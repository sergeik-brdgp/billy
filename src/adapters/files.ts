// FilesPort on expo-file-system's object API (SDK 58: File / Directory / Paths / FileHandle).
// Every method returns a Result or void and never throws; errors carry no URI / name.

import { Directory, File, FileMode, Paths, type FileHandle } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  err,
  ok,
  type CopyError,
  type FileError,
  type FilesPort,
  type OpId,
  type PickedFile,
  type Result,
} from '../core';
import { boundedCopy, readPrefix } from './byte-io';
import {
  canonicalFileUri,
  isInside,
  isOwnedPickerCopy,
  uriScheme,
  type PickerCopyRoots,
} from './owned-paths';

const PRIVATE_DIR = 'imports';
/** expo-document-picker's `copyToCacheDirectory` folder on both platforms. */
const PICKER_CACHE_DIR = 'DocumentPicker';

export interface ExpoFilesOptions {
  /** Defaults to `Platform.OS`; injectable for tests. */
  readonly platform?: string;
}

type Copied = Result<{ readonly bytes: number }, CopyError>;
const unreadable = (): Copied => err({ kind: 'unreadable' });
const tooLarge = (): Copied => err({ kind: 'too_large' });

function closeQuietly(handle: FileHandle | null): void {
  try {
    handle?.close();
  } catch {
    // already closed / released
  }
}

export function createExpoFiles(options: ExpoFilesOptions = {}): FilesPort {
  const isIos = (options.platform ?? Platform.OS) === 'ios';

  const privateDir = (): Directory => new Directory(Paths.cache, PRIVATE_DIR);
  const pickerCacheDir = (): Directory => new Directory(Paths.cache, PICKER_CACHE_DIR);
  /** iOS `<container>/tmp`: `Paths.cache` is `<container>/Library/Caches`. */
  const iosTmpDir = (): Directory | null =>
    isIos ? new Directory(Paths.cache, '..', '..', 'tmp') : null;

  const pickerRoots = (): PickerCopyRoots => ({
    tmpDir: iosTmpDir()?.uri ?? null,
    pickerCacheDir: pickerCacheDir().uri,
  });

  const pathFor = (opId: OpId | string): string =>
    new File(Paths.cache, PRIVATE_DIR, `${opId}.bin`).uri;

  /** Only `<cache>/imports/<name>` may be written or deleted through this port. */
  const isPrivatePath = (path: string): boolean => isInside(path, privateDir().uri);

  const ensurePrivateDir = (): void => {
    privateDir().create({ intermediates: true, idempotent: true });
  };

  /** Removes a private file; never throws, never touches anything outside `<cache>/imports`. */
  const removePrivate = (path: string): boolean => {
    if (!isPrivatePath(path)) return false;
    try {
      const file = new File(path);
      if (file.exists) file.delete();
      return true;
    } catch {
      return false;
    }
  };

  const sizeOf = (path: string): number | null => {
    const file = new File(path);
    return file.exists ? file.size : null;
  };

  /** Size check on the private copy; deletes it when over the limit. */
  const checkedCopy = (dest: string, limitBytes: number): Copied => {
    const bytes = sizeOf(dest);
    if (bytes === null) return unreadable();
    if (bytes > limitBytes) {
      removePrivate(dest);
      return tooLarge();
    }
    return ok({ bytes });
  };

  /**
   * Unbounded native copy (streams on disk, nothing in JS memory) for providers whose descriptor
   * cannot be read through a FileHandle: pipe-backed documents make the first `readBytes` throw
   * (the native read calls `FileChannel.position()`, an lseek that fails on a pipe), and some
   * virtual documents report size 0 so `readBytes` returns nothing. The private copy's size is
   * checked right after.
   */
  const nativeCopy = async (
    source: PickedFile,
    dest: string,
    limitBytes: number,
  ): Promise<Copied> => {
    removePrivate(dest);
    try {
      await new File(source.uri).copy(new File(dest), { overwrite: true });
    } catch {
      removePrivate(dest);
      return unreadable();
    }
    return checkedCopy(dest, limitBytes);
  };

  /** Bounded streaming copy: 256 KiB reads, aborts after `limitBytes + 1` bytes. */
  const streamCopy = async (
    source: PickedFile,
    dest: string,
    limitBytes: number,
  ): Promise<Copied> => {
    let input: FileHandle | null = null;
    try {
      input = new File(source.uri).open(FileMode.ReadOnly);
    } catch {
      input = null;
    }
    if (input === null) return nativeCopy(source, dest, limitBytes);

    let output: FileHandle | null = null;
    let outcome: Awaited<ReturnType<typeof boundedCopy>>;
    let bytesRead = 0;
    try {
      const destFile = new File(dest);
      destFile.create({ overwrite: true });
      output = destFile.open(FileMode.Truncate);
      const handle = input;
      const counted = {
        readBytes: async (length: number): Promise<Uint8Array> => {
          const chunk = await handle.readBytes(length);
          bytesRead += chunk.length;
          return chunk;
        },
      };
      outcome = await boundedCopy(counted, output, limitBytes);
    } catch {
      closeQuietly(output);
      closeQuietly(input);
      // Nothing came through the descriptor (pipe-backed provider): the native copy may still
      // read it. A failure after some bytes is a real read error.
      if (bytesRead === 0) return nativeCopy(source, dest, limitBytes);
      removePrivate(dest);
      return unreadable();
    }
    closeQuietly(output);
    closeQuietly(input);

    if (outcome.kind === 'too_large') {
      removePrivate(dest);
      return tooLarge();
    }
    // Zero bytes through the handle: either a truly empty file or a provider that cannot be read
    // through a descriptor. The native copy settles which (an empty file stays empty → rejected
    // by the content check as "not a statement").
    if (outcome.bytes === 0) return nativeCopy(source, dest, limitBytes);
    return checkedCopy(dest, limitBytes);
  };

  /**
   * iOS Inbox copy (or a picker cache copy): the app owns it, so it is moved, not read. Returns
   * null when the move failed and the caller should fall back to a streaming copy.
   */
  const moveOwned = async (
    source: PickedFile,
    dest: string,
    limitBytes: number,
  ): Promise<Copied | null> => {
    const file = new File(source.uri);
    if (!file.exists) return unreadable();
    if (file.size > limitBytes) return tooLarge(); // releasePicked drops the Inbox copy
    try {
      await file.move(new File(dest), { overwrite: true });
    } catch {
      removePrivate(dest);
      return null;
    }
    return checkedCopy(dest, limitBytes);
  };

  const files: FilesPort = {
    pathFor,

    async copyIn(source, dest, limitBytes) {
      if (!isPrivatePath(dest)) return unreadable();
      try {
        ensurePrivateDir();
        const scheme = uriScheme(source.uri);
        if (scheme === 'file' && isOwnedPickerCopy(source.uri, pickerRoots())) {
          const moved = await moveOwned(source, dest, limitBytes);
          if (moved !== null) return moved;
        }
        // Android `content://` (temporary grant) or a `file://` we do not own: read-only access.
        if (scheme === 'content' || scheme === 'file') {
          return await streamCopy(source, dest, limitBytes);
        }
        return unreadable();
      } catch {
        removePrivate(dest);
        return unreadable();
      }
    },

    async releasePicked(source) {
      // Never delete a `content://` URI or a `file://` outside the Inbox / picker cache: that could
      // be the user's original document.
      try {
        if (!isOwnedPickerCopy(source.uri, pickerRoots())) return;
        const file = new File(source.uri);
        if (file.exists) file.delete();
      } catch {
        // best effort; the startup sweep retries
      }
    },

    async exists(path) {
      try {
        return new File(path).exists;
      } catch {
        return false;
      }
    },

    async size(path): Promise<Result<number, FileError>> {
      try {
        const bytes = sizeOf(path);
        return bytes === null ? err({ kind: 'not_found' }) : ok(bytes);
      } catch {
        return err({ kind: 'io' });
      }
    },

    async readHeader(path, n): Promise<Result<Uint8Array, FileError>> {
      let handle: FileHandle | null = null;
      try {
        const file = new File(path);
        if (!file.exists) return err({ kind: 'not_found' });
        handle = file.open(FileMode.ReadOnly);
        return ok(await readPrefix(handle, n));
      } catch {
        return err({ kind: 'io' });
      } finally {
        closeQuietly(handle);
      }
    },

    async delete(path): Promise<Result<void, FileError>> {
      if (canonicalFileUri(path) === null || !isPrivatePath(path)) return err({ kind: 'io' });
      return removePrivate(path) ? ok(undefined) : err({ kind: 'io' });
    },

    async listPrivate(): Promise<Result<readonly string[], FileError>> {
      try {
        const dir = privateDir();
        if (!dir.exists) return ok([]);
        const paths: string[] = [];
        for (const entry of dir.list()) {
          // Rebuilt through pathFor's construction so the strings compare equal to pathFor(opId).
          if (entry instanceof File) paths.push(new File(Paths.cache, PRIVATE_DIR, entry.name).uri);
        }
        return ok(paths);
      } catch {
        return err({ kind: 'io' });
      }
    },

    async sweepPlatformCaches() {
      const roots: Directory[] = [pickerCacheDir()];
      try {
        const tmp = iosTmpDir();
        if (tmp?.exists) {
          for (const entry of tmp.list()) {
            if (entry instanceof Directory && entry.name.endsWith('-Inbox')) roots.push(entry);
          }
        }
      } catch {
        // tmp not listable: nothing to sweep there
      }
      for (const dir of roots) {
        try {
          if (!dir.exists) continue;
          for (const entry of dir.list()) {
            try {
              entry.delete();
            } catch {
              // keep sweeping the rest
            }
          }
        } catch {
          // directory vanished or not listable
        }
      }
    },
  };
  return files;
}
