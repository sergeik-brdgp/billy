// Ports: everything the core needs from the outside world.
// Implemented by Expo/RN adapters (src/adapters) and by Node test adapters (tests/support).
// Rules for implementers:
//   - never throw: return a Result (the controller still guards against throws, defensively);
//   - never put a file name, URI or file bytes into an error value (errors may be logged/shown);
//   - paths handed to the core are opaque strings created by `FilesPort.pathFor`.

import type { OpId, TransportCause } from './domain';
import type { LoggerPort } from './log';
import type { Result } from './result';

export type { LoggerPort } from './log';

// ---------------------------------------------------------------------------------------------
// Network

export interface HttpResponse {
  readonly status: number;
  readonly bodyText: string;
}

export interface TransportError {
  /**
   * `not_sent`: failed before anything left the device; `unreachable`: connection refused / DNS /
   * offline; `timeout`; `reset_after_send`: dropped after (part of) the request was written,
   * including a cancellation through `signal` once bytes were sent.
   */
  readonly cause: TransportCause;
  /** Optional low-cardinality code for diagnostics (e.g. `ECONNRESET`). No URIs, no names. */
  readonly code?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON / text body (test routes only). */
  readonly body?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Small JSON requests (GET / DELETE / test routes) with a timeout. */
export interface HttpPort {
  request(request: HttpRequest): Promise<Result<HttpResponse, TransportError>>;
}

export interface UploadProgress {
  readonly bytesSent: number;
  readonly totalBytes: number;
}

export interface UploadRequest {
  readonly url: string;
  /** Private copy to stream from disk (never loaded into JS memory). */
  readonly filePath: string;
  /** Includes `Content-Type: application/octet-stream`, `Idempotency-Key`, `X-File-Name`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly onProgress?: (progress: UploadProgress) => void;
  /** Aborting must cancel the transfer (foreground session; ). */
  readonly signal: AbortSignal;
}

/** Raw-body POST of a file from disk. */
export interface UploadPort {
  upload(request: UploadRequest): Promise<Result<HttpResponse, TransportError>>;
}

// ---------------------------------------------------------------------------------------------
// Files

/** What the system picker returned. `uri` is opaque to the core and never logged or shown. */
export interface PickedFile {
  readonly uri: string;
  readonly name: string;
  /** Picker metadata; a positive number is a "known" size, 0 / null means unknown. */
  readonly declaredSize: number | null;
}

export type FileError = { readonly kind: 'not_found' } | { readonly kind: 'io' };

export type CopyError =
  /** The copy was aborted because more than `limitBytes` were read (dest already removed). */
  { readonly kind: 'too_large' } | { readonly kind: 'unreadable' };

export interface FilesPort {
  /**
   * Destination of the private copy for `opId` (e.g. `<cache>/imports/<opId>.bin`), resolved
   * against the CURRENT app container. The core re-derives a persisted copy path from the opId at
   * every cold start (the iOS container path can change across updates / restores), so the result
   * must be a pure function of `opId` within one launch and match what `listPrivate` returns.
   */
  pathFor(opId: OpId): string;
  /**
   * Makes the private copy at `dest`, streaming in bounded chunks and aborting as soon as more
   * than `limitBytes` were read. May move instead of copy when the source is a temp file the app
   * owns (iOS Inbox). Must not modify a source it does not own.
   */
  copyIn(
    source: PickedFile,
    dest: string,
    limitBytes: number,
  ): Promise<Result<{ readonly bytes: number }, CopyError>>;
  /**
   * Drops a picker temp copy the app owns (iOS Inbox). Never the user's original. Called after
   * EVERY prepare outcome (accepted, rejected, copy failed), so it must be idempotent and a no-op
   * when the source is already gone (moved by `copyIn`) or not owned (Android `content://`).
   */
  releasePicked(source: PickedFile): Promise<void>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<Result<number, FileError>>;
  /** Reads up to `n` bytes from the start; fewer bytes for shorter files (short reads are normal). */
  readHeader(path: string, n: number): Promise<Result<Uint8Array, FileError>>;
  /** Deletes a private file; deleting a missing file is ok. */
  delete(path: string): Promise<Result<void, FileError>>;
  /** Lists the private copy directory (paths as `pathFor` would build them) for the orphan sweep. */
  listPrivate(): Promise<Result<readonly string[], FileError>>;
  /** Platform picker leftovers (iOS `tmp/*-Inbox`, picker cache dir). No-op where none exist. */
  sweepPlatformCaches(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Journal

export interface StoredRow {
  readonly opId: string;
  readonly body: string;
}

export interface StoreError {
  readonly kind: 'io' | 'crash';
}

/** Durable journal of operations; each `upsert` is atomic (one SQLite statement). */
export interface StorePort {
  loadAll(): Promise<Result<readonly StoredRow[], StoreError>>;
  upsert(row: StoredRow): Promise<Result<void, StoreError>>;
  remove(opId: string): Promise<Result<void, StoreError>>;
}

// ---------------------------------------------------------------------------------------------
// Time and ids

/** Whatever the platform's `setTimeout` returns. */
export type TimerHandle = unknown;

export interface ClockPort {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface IdsPort {
  /** RFC 4122 v4 UUID (36 chars, URL-safe; satisfies the mock's 8–128 key length). */
  uuid(): string;
}

export interface CorePorts {
  readonly http: HttpPort;
  readonly upload: UploadPort;
  readonly files: FilesPort;
  readonly store: StorePort;
  readonly clock: ClockPort;
  readonly ids: IdsPort;
  readonly logger: LoggerPort;
}
