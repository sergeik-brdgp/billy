// UploadPort on expo-file-system's UploadTask (SDK 58): raw-body POST streamed from disk by the
// native stack (URLSession foreground session on iOS, OkHttp on Android).

import { File, UploadType, type UploadOptions } from 'expo-file-system';

import {
  err,
  ok,
  type ClockPort,
  type HttpResponse,
  type Result,
  type TransportError,
  type UploadPort,
  type UploadRequest,
} from '../core';
import { classifyUploadFailure, headersAreValid, invalidHeaderError } from './transport-errors';

/** The subset of expo-file-system's `UploadTask` this adapter uses. */
export interface UploadTaskLike {
  uploadAsync(): Promise<{ readonly status: number; readonly body: string }>;
  cancel(): void;
  release?(): void;
}

export type CreateUploadTask = (
  filePath: string,
  url: string,
  options: UploadOptions,
) => UploadTaskLike;

/** Thrown by the default task factory when the private copy is gone (classified as not_sent). */
const fileMissing = (): Error & { code: string } =>
  Object.assign(new Error('file missing'), { code: 'file_missing' });

const defaultCreateTask: CreateUploadTask = (filePath, url, options) => {
  const file = new File(filePath);
  if (!file.exists) throw fileMissing();
  return file.createUploadTask(url, options);
};

export interface ExpoUploadDeps {
  readonly clock: ClockPort;
  /** Injectable for tests; defaults to `new File(path).createUploadTask(url, options)`. */
  readonly createTask?: CreateUploadTask;
}

export function createExpoUpload(deps: ExpoUploadDeps): UploadPort {
  const createTask = deps.createTask ?? defaultCreateTask;
  const { clock } = deps;

  return {
    async upload(request: UploadRequest): Promise<Result<HttpResponse, TransportError>> {
      // Before-send failures: nothing reaches the platform stack.
      if (!headersAreValid(request.headers)) return err(invalidHeaderError());
      if (request.signal.aborted) {
        return err(
          classifyUploadFailure({
            stage: 'before_start',
            timedOut: false,
            callerAborted: true,
            bytesSent: 0,
            error: { name: 'AbortError' },
          }),
        );
      }

      let settled = false;
      let bytesSent = 0;
      let timedOut = false;
      let callerAborted = false;

      let task: UploadTaskLike;
      try {
        task = createTask(request.filePath, request.url, {
          httpMethod: 'POST',
          uploadType: UploadType.BINARY_CONTENT,
          // Foreground: a suspended app fails the transfer (→ by-key path) instead of letting a
          // background session commit a job after a local cancel. Android ignores it.
          sessionType: 'foreground',
          headers: { ...request.headers },
          onProgress: (progress) => {
            if (settled) return;
            bytesSent = Math.max(bytesSent, progress.bytesSent);
            try {
              request.onProgress?.({
                bytesSent: progress.bytesSent,
                totalBytes: progress.totalBytes,
              });
            } catch {
              // a failing progress listener must not break the transfer
            }
          },
        });
      } catch (error) {
        return err(
          classifyUploadFailure({
            stage: 'before_start',
            timedOut: false,
            callerAborted: false,
            bytesSent: 0,
            error,
          }),
        );
      }

      const cancelTask = (): void => {
        try {
          task.cancel();
        } catch {
          // already finished
        }
      };
      const onAbort = (): void => {
        callerAborted = true;
        cancelTask();
      };
      request.signal.addEventListener('abort', onAbort);
      // The native tasks have no overall deadline (iOS: per-packet idle timeout; Android: 60 s per
      // phase), so the request's timeout is enforced here.
      const timer = clock.setTimeout(() => {
        timedOut = true;
        cancelTask();
      }, request.timeoutMs);

      try {
        // `uploadAsync()` hands the request to the native stack synchronously; from here on bytes
        // may leave the device.
        const result = await task.uploadAsync();
        return ok({
          status: result.status,
          bodyText: typeof result.body === 'string' ? result.body : '',
        });
      } catch (error) {
        return err(
          classifyUploadFailure({ stage: 'in_flight', timedOut, callerAborted, bytesSent, error }),
        );
      } finally {
        settled = true;
        clock.clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        try {
          task.release?.();
        } catch {
          // already released
        }
      }
    },
  };
}
