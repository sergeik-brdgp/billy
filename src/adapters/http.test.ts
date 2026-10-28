import type { ClockPort } from '../core';
import { createFetchHttp, type FetchLike } from './http';

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

type Init = Parameters<FetchLike>[1];

/** fetch stub that hangs until aborted (like whatwg-fetch: rejects with AbortError). */
function hangingFetch(calls: Init[]): FetchLike {
  return (_url, init) => {
    calls.push(init);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
      );
    });
  };
}

describe('fetch HttpPort', () => {
  it('returns status and body for any HTTP status', async () => {
    const clock = manualClock();
    const calls: Init[] = [];
    const http = createFetchHttp({
      clock,
      fetch: async (_url, init) => {
        calls.push(init);
        return { status: 404, text: async () => '{"error":"job not found"}' };
      },
    });
    const result = await http.request({
      method: 'DELETE',
      url: 'http://127.0.0.1:8787/imports/job-1',
      headers: { 'Idempotency-Key': 'k-1234567' },
      timeoutMs: 10_000,
    });
    expect(result).toEqual({
      ok: true,
      value: { status: 404, bodyText: '{"error":"job not found"}' },
    });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      headers: { 'Idempotency-Key': 'k-1234567' },
    });
    expect(clock.pending()).toBe(0);
  });

  it('times out through its own deadline', async () => {
    const clock = manualClock();
    const http = createFetchHttp({ clock, fetch: hangingFetch([]) });
    const pending = http.request({
      method: 'GET',
      url: 'http://127.0.0.1:8787/imports/job-1',
      timeoutMs: 10_000,
    });
    clock.fire();
    expect(await pending).toEqual({ ok: false, error: { cause: 'timeout', code: 'deadline' } });
  });

  it('merges the caller signal', async () => {
    const clock = manualClock();
    const abort = new AbortController();
    const http = createFetchHttp({ clock, fetch: hangingFetch([]) });
    const pending = http.request({
      method: 'GET',
      url: 'http://x/__test/state',
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    abort.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { cause: 'reset_after_send', code: 'cancelled' },
    });
    expect(clock.pending()).toBe(0);
  });

  it('does not call fetch for an already aborted signal or an invalid header', async () => {
    const calls: Init[] = [];
    const http = createFetchHttp({ clock: manualClock(), fetch: hangingFetch(calls) });
    const abort = new AbortController();
    abort.abort();
    expect(
      await http.request({ method: 'GET', url: 'http://x/', timeoutMs: 1, signal: abort.signal }),
    ).toEqual({
      ok: false,
      error: { cause: 'not_sent', code: 'setup_failed' },
    });
    expect(
      await http.request({
        method: 'GET',
        url: 'http://x/',
        timeoutMs: 1,
        headers: { 'X-A': 'é' },
      }),
    ).toEqual({
      ok: false,
      error: { cause: 'not_sent', code: 'invalid_header' },
    });
    expect(calls).toHaveLength(0);
  });

  it('maps RN "Network request failed" to an unknown outcome and a failing body read too', async () => {
    const http = createFetchHttp({
      clock: manualClock(),
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    });
    expect(await http.request({ method: 'GET', url: 'http://x/', timeoutMs: 1 })).toEqual({
      ok: false,
      error: { cause: 'reset_after_send', code: 'network_failed' },
    });
    const broken = createFetchHttp({
      clock: manualClock(),
      fetch: async () => ({
        status: 200,
        text: () => Promise.reject(new TypeError('Network request failed')),
      }),
    });
    expect((await broken.request({ method: 'GET', url: 'http://x/', timeoutMs: 1 })).ok).toBe(
      false,
    );
  });

  it('passes a JSON body through', async () => {
    const calls: Init[] = [];
    const http = createFetchHttp({
      clock: manualClock(),
      fetch: async (_url, init) => {
        calls.push(init);
        return { status: 200, text: async () => '{}' };
      },
    });
    await http.request({
      method: 'POST',
      url: 'http://x/__test/scenario',
      body: '{"mode":"happy"}',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 1,
    });
    expect(calls[0]?.body).toBe('{"mode":"happy"}');
  });
});
