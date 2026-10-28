// Node implementations of the core ports, used by integration tests and scripts/matrix.mjs.
// They follow the same contracts as the Expo adapters: Result-typed, no names/URIs in errors,
// files streamed from disk, bounded copies.

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  err,
  ok,
  type ClockPort,
  type CopyError,
  type FileError,
  type FilesPort,
  type HttpPort,
  type HttpResponse,
  type IdsPort,
  type LogEntry,
  type LoggerPort,
  type OpId,
  type PickedFile,
  type Result,
  type StoredRow,
  type StoreError,
  type StorePort,
  type TransportCause,
  type TransportError,
  type UploadPort,
  type UploadRequest,
} from '../../src/core';

// ---------------------------------------------------------------------------------------------
// Errors

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function transportError(cause: TransportCause, code?: string): TransportError {
  return code === undefined ? { cause } : { cause, code };
}

// ---------------------------------------------------------------------------------------------
// HTTP (fetch)

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface NodeHttpOptions {
  /** Called for every request before it is sent (traffic recording). */
  readonly onRequest?: (request: RecordedRequest) => void;
}

export function createNodeHttp(options: NodeHttpOptions = {}): HttpPort {
  return {
    async request(req) {
      options.onRequest?.({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: { ...req.headers },
      });
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
      try {
        const response = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal,
        });
        const bodyText = await response.text();
        return ok<HttpResponse>({ status: response.status, bodyText });
      } catch (error) {
        if (timeout.aborted) return err(transportError('timeout'));
        const code = errorCode(error);
        if (code !== undefined && UNREACHABLE_CODES.has(code))
          return err(transportError('unreachable', code));
        return err(transportError('reset_after_send', code));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Upload (node:http, file streamed from disk)

export interface UploadBehaviour {
  /** Drop the connection after this many body bytes were written (simulated network loss). */
  readonly dropAfterBytes?: number;
  /** Throttle: write the body in chunks of this size … */
  readonly chunkBytes?: number;
  /** … with this pause between chunks. */
  readonly chunkDelayMs?: number;
}

export interface NodeUploadOptions {
  /** Behaviour per attempt (1-based count of uploads made by this port). */
  readonly behaviour?: (attempt: number) => UploadBehaviour | undefined;
  readonly onRequest?: (request: RecordedRequest) => void;
}

class ChunkTransform extends Transform {
  written = 0;

  constructor(
    private readonly behaviour: UploadBehaviour,
    private readonly onDrop: () => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    void this.emitChunks(chunk).then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  private async emitChunks(chunk: Buffer): Promise<void> {
    const size = this.behaviour.chunkBytes ?? chunk.length;
    for (let offset = 0; offset < chunk.length; offset += size) {
      let piece = chunk.subarray(offset, Math.min(chunk.length, offset + size));
      const limit = this.behaviour.dropAfterBytes;
      if (limit !== undefined && this.written + piece.length >= limit) {
        piece = piece.subarray(0, Math.max(0, limit - this.written));
        if (piece.length > 0) this.push(piece);
        this.written += piece.length;
        // Let the partial body reach the server before the connection drops.
        await new Promise((resolve) => setTimeout(resolve, 30));
        this.onDrop();
        return new Promise<void>(() => undefined);
      }
      this.push(piece);
      this.written += piece.length;
      if (this.behaviour.chunkDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.behaviour.chunkDelayMs));
      }
    }
  }
}

export function createNodeUpload(
  options: NodeUploadOptions = {},
): UploadPort & { attempts(): number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    async upload(req: UploadRequest) {
      attempts += 1;
      const behaviour = options.behaviour?.(attempts) ?? {};
      const url = new URL(req.url);
      options.onRequest?.({ method: 'POST', path: url.pathname, headers: { ...req.headers } });
      let totalBytes: number;
      try {
        totalBytes = (await stat(req.filePath)).size;
      } catch {
        return err(transportError('not_sent'));
      }
      if (req.signal.aborted) return err(transportError('not_sent'));

      return new Promise<Result<HttpResponse, TransportError>>((resolve) => {
        let settled = false;
        let bodyBytesSent = 0;
        let timedOut = false;
        const streams: { destroy(): void }[] = [];
        const settle = (value: Result<HttpResponse, TransportError>): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.signal.removeEventListener('abort', onAbort);
          for (const stream of streams) stream.destroy();
          resolve(value);
        };
        const request = httpRequest(
          {
            method: 'POST',
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { ...req.headers, 'Content-Length': String(totalBytes) },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              settle(
                ok({
                  status: response.statusCode ?? 0,
                  bodyText: Buffer.concat(chunks).toString('utf8'),
                }),
              ),
            );
            response.on('error', () => settle(err(transportError('reset_after_send'))));
          },
        );
        const fail = (error: unknown): void => {
          const code = errorCode(error);
          if (timedOut) return settle(err(transportError('timeout', code)));
          if (code !== undefined && UNREACHABLE_CODES.has(code)) {
            return settle(err(transportError('unreachable', code)));
          }
          if (req.signal.aborted && bodyBytesSent === 0)
            return settle(err(transportError('not_sent', code)));
          settle(err(transportError('reset_after_send', code)));
        };
        request.on('error', fail);
        const onAbort = (): void => {
          request.destroy(new Error('aborted'));
        };
        req.signal.addEventListener('abort', onAbort);
        const timer = setTimeout(() => {
          timedOut = true;
          request.destroy(new Error('timeout'));
        }, req.timeoutMs);

        const chunker = new ChunkTransform(behaviour, () => request.destroy(new Error('dropped')));
        chunker.on('data', (chunk: Buffer) => {
          bodyBytesSent += chunk.length;
          req.onProgress?.({ bytesSent: bodyBytesSent, totalBytes });
        });
        const source = createReadStream(req.filePath, { highWaterMark: 64 * 1024 });
        streams.push(source, chunker);
        source.on('error', fail);
        source.pipe(chunker).pipe(request);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Files (fs-backed, temp root)

export interface NodeFiles extends FilesPort {
  readonly privateDir: string;
  /** Number of `releasePicked` calls (known-oversize path). */
  releasedCount(): number;
  /** Lists file names left in the private directory. */
  leftovers(): Promise<string[]>;
}

export interface NodeFilesOptions {
  /**
   * `bounded` (default): streaming copy that aborts past the limit, like the Android adapter.
   * `unbounded`: copies everything regardless of the limit, like the iOS adapter's `move` of the
   * Inbox file — then the core's post-copy size check is the only oversize guard.
   */
  readonly copyMode?: 'bounded' | 'unbounded';
}

export function createNodeFiles(root: string, options: NodeFilesOptions = {}): NodeFiles {
  const bounded = (options.copyMode ?? 'bounded') === 'bounded';
  const privateDir = join(root, 'imports');
  let released = 0;
  const notFound = (error: unknown): boolean => errorCode(error) === 'ENOENT';

  const files: NodeFiles = {
    privateDir,
    releasedCount: () => released,
    async leftovers() {
      try {
        return await readdir(privateDir);
      } catch (error) {
        if (notFound(error)) return [];
        throw error;
      }
    },
    pathFor: (opId: OpId) => join(privateDir, `${opId}.bin`),
    async copyIn(
      source: PickedFile,
      dest: string,
      limitBytes: number,
    ): Promise<Result<{ bytes: number }, CopyError>> {
      let bytes = 0;
      let tooLarge = false;
      try {
        await mkdir(privateDir, { recursive: true });
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bounded && bytes > limitBytes) {
              tooLarge = true;
              callback(new Error('limit'));
              return;
            }
            callback(null, chunk);
          },
        });
        // 256 KiB chunks, like FileHandle.readBytes(256 KiB) in the Android adapter.
        await pipeline(
          createReadStream(source.uri, { highWaterMark: 256 * 1024 }),
          counter,
          createWriteStream(dest),
        );
        return ok({ bytes });
      } catch {
        await rm(dest, { force: true }).catch(() => undefined);
        return err(tooLarge ? { kind: 'too_large' } : { kind: 'unreadable' });
      }
    },
    async releasePicked() {
      released += 1; // the Node "picker" source is a fixture we do not own: never delete it
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async size(path): Promise<Result<number, FileError>> {
      try {
        return ok((await stat(path)).size);
      } catch (error) {
        return err(notFound(error) ? { kind: 'not_found' } : { kind: 'io' });
      }
    },
    async readHeader(path, n): Promise<Result<Uint8Array, FileError>> {
      let handle;
      try {
        handle = await open(path, 'r');
        const buffer = Buffer.alloc(n);
        let filled = 0;
        // Short reads are normal: loop until n bytes or EOF.
        while (filled < n) {
          const { bytesRead } = await handle.read(buffer, filled, n - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return ok(new Uint8Array(buffer.subarray(0, filled)));
      } catch (error) {
        return err(notFound(error) ? { kind: 'not_found' } : { kind: 'io' });
      } finally {
        await handle?.close();
      }
    },
    async delete(path): Promise<Result<void, FileError>> {
      try {
        await rm(path, { force: true });
        return ok(undefined);
      } catch {
        return err({ kind: 'io' });
      }
    },
    async listPrivate(): Promise<Result<readonly string[], FileError>> {
      try {
        return ok((await readdir(privateDir)).map((name) => join(privateDir, name)));
      } catch (error) {
        if (notFound(error)) return ok([]);
        return err({ kind: 'io' });
      }
    },
    async sweepPlatformCaches() {
      // No picker caches in Node.
    },
  };
  return files;
}

// ---------------------------------------------------------------------------------------------
// Store (in-memory "disk" with crash injection)

export interface CrashPlan {
  /** 1-based index of the upsert that "kills the process". */
  readonly nthUpsert: number;
  /** `before_write`: the row is not written; `after_write`: it is written, then the process dies. */
  readonly when: 'before_write' | 'after_write';
}

export interface MemoryStore extends StorePort {
  /** The durable rows (what survives a crash). */
  readonly disk: Map<string, string>;
  upserts(): number;
  crashed(): boolean;
  /** A new "process" over the same disk (no crash plan). */
  revive(): MemoryStore;
}

export function createMemoryStore(
  disk = new Map<string, string>(),
  crash?: CrashPlan,
): MemoryStore {
  let count = 0;
  let dead = false;
  const crashError: StoreError = { kind: 'crash' };
  return {
    disk,
    upserts: () => count,
    crashed: () => dead,
    revive: () => createMemoryStore(disk),
    async loadAll(): Promise<Result<readonly StoredRow[], StoreError>> {
      if (dead) return err(crashError);
      return ok([...disk.entries()].map(([opId, body]) => ({ opId, body })));
    },
    async upsert(row) {
      if (dead) return err(crashError);
      count += 1;
      if (crash && crash.nthUpsert === count) {
        if (crash.when === 'after_write') disk.set(row.opId, row.body);
        dead = true;
        return err(crashError);
      }
      disk.set(row.opId, row.body);
      return ok(undefined);
    },
    async remove(opId) {
      if (dead) return err(crashError);
      disk.delete(opId);
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Clock, ids, logger

export const realClock: ClockPort = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const nodeIds: IdsPort = { uuid: () => randomUUID() };

export interface RecordingLogger extends LoggerPort {
  readonly entries: LogEntry[];
}

export function createRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  return { entries, log: (entry) => entries.push(entry) };
}
