// In-memory stand-in for the parts of `expo-file-system` (SDK 58 object API) the adapters use.
// Installed with `jest.mock('expo-file-system', () => jest.requireActual('./__tests__/fake-file-system'))`.
// Semantics mirror the native docs: `File.size` is 0 for a missing file, `readBytes` returns
// fewer bytes at EOF and an empty array past it, `/private/var` and `/var` are the same place.

export const CONTAINER = 'file:///var/mobile/Containers/Data/Application/APP';
export const CACHE = `${CONTAINER}/Library/Caches/`;

type Entry =
  | {
      kind: 'file';
      data: Uint8Array;
      /**
       * Pipe-backed provider: the first `readBytes` throws, as the native handle does
       * (`FileChannel.position()` → lseek on a pipe → ESPIPE); `copy` still works.
       */
      pipe?: boolean;
      /** Reads through a handle return nothing (descriptor reports size 0); `copy` still works. */
      zeroReads?: boolean;
      /** `open()` throws (provider without descriptor support). */
      unopenable?: boolean;
      /** `readBytes` throws after this many bytes were read. */
      failAfter?: number;
    }
  | { kind: 'dir' };

export const fakeFs = {
  entries: new Map<string, Entry>(),
  openHandles: 0,
  maxReadRequest: 0,
  deletes: [] as string[],
  moves: 0,
  copies: 0,
  reset(): void {
    this.entries.clear();
    this.openHandles = 0;
    this.maxReadRequest = 0;
    this.deletes = [];
    this.moves = 0;
    this.copies = 0;
    this.entries.set(key(CACHE), { kind: 'dir' });
  },
  putFile(
    uri: string,
    data: Uint8Array,
    extra: Partial<Extract<Entry, { kind: 'file' }>> = {},
  ): void {
    this.entries.set(key(uri), { kind: 'file', data, ...extra });
  },
  putDir(uri: string): void {
    this.entries.set(key(uri), { kind: 'dir' });
  },
  has(uri: string): boolean {
    return this.entries.has(key(uri));
  },
  data(uri: string): Uint8Array | undefined {
    const entry = this.entries.get(key(uri));
    return entry?.kind === 'file' ? entry.data : undefined;
  },
  children(dirUri: string): string[] {
    const prefix = `${key(dirUri)}/`;
    return [...this.entries.keys()].filter(
      (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'),
    );
  },
};

/** Storage key: canonical spelling without trailing slash, `/private/var` folded. */
function key(uri: string): string {
  let out = uri.replace('file:///private/var/', 'file:///var/');
  while (out.endsWith('/') && !out.endsWith('://')) out = out.slice(0, -1);
  return out;
}

function join(parts: readonly (string | { uri: string })[]): string {
  const [first = '', ...rest] = parts.map((part) => (typeof part === 'string' ? part : part.uri));
  const match = /^([a-z]+:\/\/)(.*)$/i.exec(first);
  const scheme = match?.[1] ?? '';
  const segments = (match?.[2] ?? first).split('/');
  for (const part of rest) segments.push(...part.split('/'));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return scheme === 'file://' ? `file:///${out.join('/')}` : `${scheme}${out.join('/')}`;
}

export enum FileMode {
  ReadWrite = 'rw',
  ReadOnly = 'r',
  WriteOnly = 'w',
  Append = 'wa',
  Truncate = 'wt',
}

export enum UploadType {
  BINARY_CONTENT = 0,
  MULTIPART = 1,
}

class FakeHandle {
  private offset = 0;
  private closed = false;

  constructor(
    private readonly target: string,
    private readonly mode: FileMode,
  ) {
    fakeFs.openHandles += 1;
  }

  private entry(): Extract<Entry, { kind: 'file' }> {
    const entry = fakeFs.entries.get(this.target);
    if (this.closed || entry?.kind !== 'file') throw new Error('handle closed');
    return entry;
  }

  async readBytes(length: number): Promise<Uint8Array> {
    if (this.mode !== FileMode.ReadOnly && this.mode !== FileMode.ReadWrite)
      throw new Error('write-only');
    fakeFs.maxReadRequest = Math.max(fakeFs.maxReadRequest, length);
    const entry = this.entry();
    if (entry.pipe) throw new Error('UnableToReadHandleException: ESPIPE');
    if (entry.zeroReads) return new Uint8Array(0);
    if (entry.failAfter !== undefined && this.offset >= entry.failAfter)
      throw new Error('read failed');
    const chunk = entry.data.slice(this.offset, this.offset + length);
    this.offset += chunk.length;
    return chunk;
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.mode === FileMode.ReadOnly) throw new Error('read-only');
    const entry = this.entry();
    const next = new Uint8Array(entry.data.length + bytes.length);
    next.set(entry.data, 0);
    next.set(bytes, entry.data.length);
    entry.data = next;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fakeFs.openHandles -= 1;
  }
}

export class File {
  readonly uri: string;

  constructor(...uris: (string | File | Directory)[]) {
    this.uri = join(uris);
  }

  get exists(): boolean {
    return fakeFs.entries.get(key(this.uri))?.kind === 'file';
  }

  get size(): number {
    const entry = fakeFs.entries.get(key(this.uri));
    return entry?.kind === 'file' ? entry.data.length : 0;
  }

  get name(): string {
    return key(this.uri).split('/').pop() ?? '';
  }

  create(options: { overwrite?: boolean } = {}): void {
    if (this.exists && !options.overwrite) throw new Error('exists');
    fakeFs.entries.set(key(this.uri), { kind: 'file', data: new Uint8Array(0) });
  }

  delete(): void {
    if (!this.exists) throw new Error('missing');
    fakeFs.deletes.push(this.uri);
    fakeFs.entries.delete(key(this.uri));
  }

  open(mode: FileMode = FileMode.ReadWrite): FakeHandle {
    const entry = fakeFs.entries.get(key(this.uri));
    if (entry?.kind !== 'file') throw new Error('cannot open');
    if (entry.unopenable) throw new Error('no descriptor');
    if (mode === FileMode.Truncate) entry.data = new Uint8Array(0);
    return new FakeHandle(key(this.uri), mode);
  }

  async move(destination: File, options: { overwrite?: boolean } = {}): Promise<void> {
    const entry = fakeFs.entries.get(key(this.uri));
    if (entry?.kind !== 'file') throw new Error('missing');
    if (destination.exists && !options.overwrite) throw new Error('exists');
    fakeFs.moves += 1;
    fakeFs.entries.delete(key(this.uri));
    fakeFs.entries.set(key(destination.uri), entry);
  }

  async copy(destination: File, options: { overwrite?: boolean } = {}): Promise<void> {
    const entry = fakeFs.entries.get(key(this.uri));
    if (entry?.kind !== 'file') throw new Error('missing');
    if (destination.exists && !options.overwrite) throw new Error('exists');
    fakeFs.copies += 1;
    fakeFs.entries.set(key(destination.uri), { kind: 'file', data: entry.data.slice() });
  }
}

export class Directory {
  readonly uri: string;

  constructor(...uris: (string | File | Directory)[]) {
    this.uri = `${join(uris)}/`;
  }

  get exists(): boolean {
    return fakeFs.entries.get(key(this.uri))?.kind === 'dir';
  }

  get name(): string {
    return key(this.uri).split('/').pop() ?? '';
  }

  create(options: { intermediates?: boolean; idempotent?: boolean } = {}): void {
    if (this.exists) {
      if (!options.idempotent) throw new Error('exists');
      return;
    }
    fakeFs.entries.set(key(this.uri), { kind: 'dir' });
  }

  list(): (File | Directory)[] {
    if (!this.exists) throw new Error('missing');
    return fakeFs
      .children(this.uri)
      .map((child) =>
        fakeFs.entries.get(child)?.kind === 'dir' ? new Directory(child) : new File(child),
      );
  }

  delete(): void {
    if (!this.exists) throw new Error('missing');
    const prefix = key(this.uri);
    for (const k of [...fakeFs.entries.keys()]) {
      if (k === prefix || k.startsWith(`${prefix}/`)) fakeFs.entries.delete(k);
    }
    fakeFs.deletes.push(this.uri);
  }
}

export const Paths = {
  get cache(): Directory {
    return new Directory(CACHE);
  },
};
