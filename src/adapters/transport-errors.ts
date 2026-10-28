// Pure mapping of platform network failures to the core's TransportCause.
//
// What the native layers actually reject with (read from node_modules, expo-file-system 58.0.12,
// react-native 0.88 / whatwg-fetch):
//
// UploadTask (expo-file-system `FileSystemUploadTask`)
//   iOS (`ios/FileSystemUploadTask.swift`, URLSession foreground session):
//     - URLSession error NSURLErrorCancelled → `ERR_UPLOAD_CANCELLED` "Upload was cancelled";
//     - any other URLSession error → `ERR_UNABLE_TO_UPLOAD`
//       "Unable to upload a file: <NSError.localizedDescription>" — the NSURLError code is NOT
//       forwarded, only its (English, the app ships no other localisation) description, e.g.
//       "Could not connect to the server." (-1004), "A server with the specified hostname could not
//       be found." (-1003), "The Internet connection appears to be offline." (-1009),
//       "The request timed out." (-1001), "The network connection was lost." (-1005);
//     - set-up failures before `resume()` also use `ERR_UNABLE_TO_UPLOAD`
//       ("Failed to create upload task", scoped-access errors).
//   Android (`FileSystemUploadTask.kt`, OkHttp, 60 s connect/read/write timeouts):
//     - `file.validatePermission` → `ERR_INVALID_PERMISSION`; missing file →
//       `ERR_UNABLE_TO_UPLOAD` "… File does not exist"; an illegal header char makes
//       `Request.Builder.addHeader` throw IllegalArgumentException → `ERR_UNEXPECTED`. All of these
//       happen before `enqueue`, i.e. nothing was sent;
//     - `Callback.onFailure` after our `cancel()` → `ERR_UPLOAD_CANCELLED`;
//     - any other IOException → `ERR_UNABLE_TO_UPLOAD` "Unable to upload a file: <message>", e.g.
//       "Failed to connect to /127.0.0.1:8787" (ConnectException), "Unable to resolve host …"
//       (UnknownHostException), "timeout" / "Read timed out" (SocketTimeoutException),
//       "unexpected end of stream on …" / "Connection reset" / "Broken pipe" (dropped mid-request),
//       "CLEARTEXT communication … not permitted by network security policy".
//   JS wrapper (`build/NetworkTasks.js`): an aborted `options.signal` rejects with an
//   `AbortError`; we do not pass a signal and call `task.cancel()` ourselves instead, so the
//   adapter itself knows whether the cancel came from the caller or from its own deadline.
//
// fetch (react-native → whatwg-fetch over XMLHttpRequest)
//   - TypeError "Network request failed" for every transport error (no detail at all);
//   - TypeError "Network request timed out" when the native request timed out;
//   - DOMException AbortError when the signal aborted.
//
// Rule of thumb: `not_sent` / `unreachable` are only returned on positive evidence that nothing
// reached the server; everything else is `reset_after_send` (outcome unknown → by-key lookup).
// Error messages are inspected here and then dropped: they can contain the URL or, on Android,
// the offending header value (= the file name), so only the low-cardinality `code` labels below
// ever leave this module.

import type { TransportCause, TransportError } from '../core';

/** Fields of a thrown value that the classifiers look at. Never stored or logged. */
export interface ErrorFacts {
  readonly code: string | undefined;
  readonly name: string | undefined;
  readonly message: string;
}

export function errorFacts(error: unknown): ErrorFacts {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, name: undefined, message: typeof error === 'string' ? error : '' };
  }
  const record = error as { code?: unknown; name?: unknown; message?: unknown };
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    message: typeof record.message === 'string' ? record.message : '',
  };
}

export interface FailureFacts {
  /** `before_start`: the native request was never started (set-up threw, signal already aborted). */
  readonly stage: 'before_start' | 'in_flight';
  /** The adapter's own deadline (`request.timeoutMs`) fired and cancelled the request. */
  readonly timedOut: boolean;
  /** The caller's AbortSignal fired while the request was in flight. */
  readonly callerAborted: boolean;
  /** Highest `bytesSent` reported by native progress (uploads; 0 for fetch). */
  readonly bytesSent: number;
  readonly error: unknown;
}

/** Low-cardinality labels for `TransportError.code` (diagnostics only). */
export type TransportCode =
  | 'invalid_header'
  | 'file_missing'
  | 'setup_failed'
  | 'aborted_before_start'
  | 'rejected_before_send'
  | 'deadline'
  | 'cancelled'
  | 'cancelled_by_system'
  | 'connect_failed'
  | 'dns'
  | 'offline'
  | 'blocked_by_policy'
  | 'native_timeout'
  | 'connection_lost'
  | 'network_failed';

const transport = (cause: TransportCause, code: TransportCode): TransportError => ({ cause, code });

/** Connection-establishment failures: the request certainly did not reach the server. */
const UNREACHABLE_PATTERNS: readonly (readonly [TransportCode, RegExp])[] = [
  [
    'connect_failed',
    /failed to connect|could not connect|connection refused|econnrefused|no route to host|ehostunreach|enetunreach|network is unreachable/i,
  ],
  [
    'dns',
    /unable to resolve host|hostname could not be found|cannot find host|no address associated|enotfound|eai_again/i,
  ],
  ['offline', /appears to be offline|not connected to the internet/i],
  ['blocked_by_policy', /cleartext|network security policy|app transport security/i],
];

const TIMEOUT_PATTERN = /time[d\s-]*out/i;

/** Native codes that are only produced before the request is handed to the network stack. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ERR_UNEXPECTED', // Android: IllegalArgumentException from addHeader (invalid header char)
  'ERR_INVALID_PERMISSION', // Android/iOS: file permission check in start()
]);
const FILE_MISSING_PATTERN = /file does not exist/i;
const SETUP_FAILED_PATTERN = /failed to create upload task/i;
const INVALID_HEADER_PATTERN = /invalid character in header|unexpected char|invalid header/i;

function unreachableCode(message: string): TransportCode | null {
  for (const [code, pattern] of UNREACHABLE_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return null;
}

/** Maps a failed `UploadTask.uploadAsync()` (or its set-up) to a TransportError. */
export function classifyUploadFailure(facts: FailureFacts): TransportError {
  const info = errorFacts(facts.error);
  if (facts.stage === 'before_start') {
    if (info.code === 'file_missing') return transport('not_sent', 'file_missing');
    if (info.name === 'AbortError') return transport('not_sent', 'aborted_before_start');
    return transport('not_sent', 'setup_failed');
  }
  if (facts.timedOut) return transport('timeout', 'deadline');
  // The native task was started: even with no progress event yet, (part of) the body may be in
  // the socket — a cancel is therefore an unknown outcome, never `not_sent`.
  if (facts.callerAborted) return transport('reset_after_send', 'cancelled');
  if (info.code === 'ERR_UPLOAD_CANCELLED' || info.name === 'AbortError') {
    return transport('reset_after_send', 'cancelled_by_system');
  }
  if (info.code !== undefined && NOT_SENT_CODES.has(info.code)) {
    return transport('not_sent', 'rejected_before_send');
  }
  if (FILE_MISSING_PATTERN.test(info.message)) return transport('not_sent', 'file_missing');
  if (SETUP_FAILED_PATTERN.test(info.message)) return transport('not_sent', 'setup_failed');
  if (facts.bytesSent === 0) {
    const code = unreachableCode(info.message);
    if (code !== null) return transport('unreachable', code);
  }
  if (TIMEOUT_PATTERN.test(info.message)) return transport('timeout', 'native_timeout');
  return transport('reset_after_send', 'connection_lost');
}

/** Maps a failed `fetch()` (or reading its body) to a TransportError. */
export function classifyFetchFailure(facts: FailureFacts): TransportError {
  const info = errorFacts(facts.error);
  if (facts.stage === 'before_start') return transport('not_sent', 'setup_failed');
  if (facts.timedOut) return transport('timeout', 'deadline');
  if (facts.callerAborted) return transport('reset_after_send', 'cancelled');
  if (INVALID_HEADER_PATTERN.test(info.message)) return transport('not_sent', 'invalid_header');
  const code = unreachableCode(info.message);
  if (code !== null) return transport('unreachable', code);
  if (TIMEOUT_PATTERN.test(info.message)) return transport('timeout', 'native_timeout');
  // whatwg-fetch's "Network request failed" carries no detail: the request may have been sent.
  return transport('reset_after_send', 'network_failed');
}

// ---------------------------------------------------------------------------------------------
// Header validation (before anything is handed to the platform)

/** RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** What OkHttp accepts in a header value (`\t` and printable ASCII); stricter than URLSession. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** True when every header would be accepted by both platform stacks unchanged. */
export function headersAreValid(headers: Readonly<Record<string, string>> | undefined): boolean {
  if (headers === undefined) return true;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) {
      return false;
    }
  }
  return true;
}

export const invalidHeaderError = (): TransportError => transport('not_sent', 'invalid_header');
