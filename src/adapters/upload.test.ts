import type { UploadOptions } from 'expo-file-system';

import type { ClockPort, UploadRequest } from '../core';
import { createExpoUpload, type UploadTaskLike } from './upload';

jest.mock('expo-file-system', () => jest.requireActual('./__tests__/fake-file-system'));

/** Manually driven clock: timers fire only through `fire()`. */
function manualClock(): ClockPort & { fire(): void; pending(): number } {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    now: () => 0,
    setTimeout: (callback) => {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    fire: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pending: () => timers.size,
  };
}

interface FakeTask extends UploadTaskLike {
  options: UploadOptions;
  url: string;
  path: string;
  cancels: number;
  released: boolean;
  progress(bytesSent: number, totalBytes: number): void;
  resolve(value: { status: number; body: string }): void;
  reject(error: unknown): void;
}

function harness() {
  const clock = manualClock();
  const tasks: FakeTask[] = [];
  const upload = createExpoUpload({
    clock,
    createTask: (path, url, options) => {
      let resolve!: FakeTask['resolve'];
      let reject!: FakeTask['reject'];
      const done = new Promise<{ status: number; body: string }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const task: FakeTask = {
        options,
        url,
        path,
        cancels: 0,
        released: false,
        uploadAsync: () => done,
        // Like the native task: cancel() rejects the pending promise with ERR_UPLOAD_CANCELLED.
        cancel: () => {
          task.cancels += 1;
          reject(
            Object.assign(new Error('Upload was cancelled'), { code: 'ERR_UPLOAD_CANCELLED' }),
          );
        },
        release: () => {
          task.released = true;
        },
        progress: (bytesSent, totalBytes) => options.onProgress?.({ bytesSent, totalBytes }),
        resolve: (value) => resolve(value),
        reject: (error) => reject(error),
      };
      tasks.push(task);
      return task;
    },
  });
  return { clock, tasks, upload };
}

const HEADERS = {
  'Content-Type': 'application/octet-stream',
  'Idempotency-Key': '0b5a2b7e-6f43-4a8e-9a63-1f6b1d3c2e10',
  'X-File-Name': 'statement.csv',
};

function request(signal: AbortSignal, extra: Partial<UploadRequest> = {}): UploadRequest {
  return {
    url: 'http://127.0.0.1:8787/imports',
    filePath: 'file:///cache/imports/x.bin',
    headers: HEADERS,
    timeoutMs: 60_000,
    signal,
    ...extra,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

describe('expo UploadPort', () => {
  it('POSTs the raw file with the core headers on a foreground session', async () => {
    const { tasks, upload, clock } = harness();
    const pending = upload.upload(request(new AbortController().signal));
    const task = tasks[0]!;
    expect(task.url).toBe('http://127.0.0.1:8787/imports');
    expect(task.path).toBe('file:///cache/imports/x.bin');
    expect(task.options).toMatchObject({
      httpMethod: 'POST',
      uploadType: 0,
      sessionType: 'foreground',
      headers: HEADERS,
    });
    task.resolve({ status: 202, body: '{"jobId":"job-1","status":"queued","revision":1}' });
    expect(await pending).toEqual({
      ok: true,
      value: { status: 202, bodyText: '{"jobId":"job-1","status":"queued","revision":1}' },
    });
    expect(task.released).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it('returns non-2xx responses as values', async () => {
    const { tasks, upload } = harness();
    const pending = upload.upload(request(new AbortController().signal));
    tasks[0]!.resolve({ status: 415, body: '{"error":"unsupported"}' });
    expect(await pending).toEqual({
      ok: true,
      value: { status: 415, bodyText: '{"error":"unsupported"}' },
    });
  });

  it('forwards progress as {bytesSent, totalBytes}', async () => {
    const { tasks, upload } = harness();
    const seen: unknown[] = [];
    const pending = upload.upload(
      request(new AbortController().signal, { onProgress: (p) => seen.push(p) }),
    );
    tasks[0]!.progress(10, 100);
    tasks[0]!.progress(100, 100);
    tasks[0]!.resolve({ status: 202, body: '{}' });
    await pending;
    expect(seen).toEqual([
      { bytesSent: 10, totalBytes: 100 },
      { bytesSent: 100, totalBytes: 100 },
    ]);
  });

  it('user cancel after progress → reset_after_send (core looks the key up)', async () => {
    const { tasks, upload } = harness();
    const abort = new AbortController();
    const pending = upload.upload(request(abort.signal));
    tasks[0]!.progress(4096, 10_000);
    abort.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { cause: 'reset_after_send', code: 'cancelled' },
    });
    expect(tasks[0]!.cancels).toBe(1);
  });

  it('user cancel before any progress, task started → still reset_after_send', async () => {
    const { tasks, upload } = harness();
    const abort = new AbortController();
    const pending = upload.upload(request(abort.signal));
    abort.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { cause: 'reset_after_send', code: 'cancelled' },
    });
    expect(tasks[0]!.cancels).toBe(1);
  });

  it('signal already aborted → not_sent, no task created', async () => {
    const { tasks, upload } = harness();
    const abort = new AbortController();
    abort.abort();
    expect(await upload.upload(request(abort.signal))).toEqual({
      ok: false,
      error: { cause: 'not_sent', code: 'aborted_before_start' },
    });
    expect(tasks).toHaveLength(0);
  });

  it('enforces timeoutMs itself → timeout', async () => {
    const { tasks, upload, clock } = harness();
    const pending = upload.upload(request(new AbortController().signal));
    tasks[0]!.progress(1, 10);
    clock.fire();
    expect(await pending).toEqual({ ok: false, error: { cause: 'timeout', code: 'deadline' } });
    expect(tasks[0]!.cancels).toBe(1);
  });

  it('maps a refused connection to unreachable', async () => {
    const { tasks, upload } = harness();
    const pending = upload.upload(request(new AbortController().signal));
    tasks[0]!.reject(
      Object.assign(new Error('Unable to upload a file: Failed to connect to /127.0.0.1:8787'), {
        code: 'ERR_UNABLE_TO_UPLOAD',
      }),
    );
    expect(await pending).toEqual({
      ok: false,
      error: { cause: 'unreachable', code: 'connect_failed' },
    });
  });

  it('maps a connection dropped after bytes were written to reset_after_send', async () => {
    const { tasks, upload } = harness();
    const pending = upload.upload(request(new AbortController().signal));
    tasks[0]!.progress(65_536, 200_000);
    tasks[0]!.reject(
      Object.assign(new Error('Unable to upload a file: unexpected end of stream'), {
        code: 'ERR_UNABLE_TO_UPLOAD',
      }),
    );
    expect(await pending).toEqual({
      ok: false,
      error: { cause: 'reset_after_send', code: 'connection_lost' },
    });
  });

  it('an invalid header never reaches the platform → not_sent', async () => {
    const { tasks, upload } = harness();
    const result = await upload.upload(
      request(new AbortController().signal, {
        headers: { ...HEADERS, 'X-File-Name': 'выписка.csv' },
      }),
    );
    expect(result).toEqual({ ok: false, error: { cause: 'not_sent', code: 'invalid_header' } });
    expect(tasks).toHaveLength(0);
  });

  it('a set-up throw (e.g. missing file) is not_sent', async () => {
    const upload = createExpoUpload({
      clock: manualClock(),
      createTask: () => {
        throw Object.assign(new Error('file missing'), { code: 'file_missing' });
      },
    });
    expect(await upload.upload(request(new AbortController().signal))).toEqual({
      ok: false,
      error: { cause: 'not_sent', code: 'file_missing' },
    });
  });

  it('the default task factory reports a missing private copy as not_sent', async () => {
    const upload = createExpoUpload({ clock: manualClock() });
    expect(await upload.upload(request(new AbortController().signal))).toEqual({
      ok: false,
      error: { cause: 'not_sent', code: 'file_missing' },
    });
  });

  it('ignores progress after settling and detaches from the signal', async () => {
    const { tasks, upload } = harness();
    const abort = new AbortController();
    const seen: unknown[] = [];
    const pending = upload.upload(request(abort.signal, { onProgress: (p) => seen.push(p) }));
    tasks[0]!.resolve({ status: 202, body: '{}' });
    await pending;
    tasks[0]!.progress(5, 5);
    abort.abort();
    await flush();
    expect(seen).toEqual([]);
    expect(tasks[0]!.cancels).toBe(0);
  });
});
