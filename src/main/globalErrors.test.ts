// An uncaught error never reaches the default handler (dev log, release crash report) with its
// message: only a typed log event and a redacted error with the same name and frames.

import type { LogEntry, LoggerPort } from '../core';
import { installGlobalErrorHandler, redactError, type ErrorUtilsLike } from './globalErrors';

const SECRET = 'file:///private/var/mobile/Containers/statement-2026.pdf';

function fakeErrorUtils() {
  const received: { error: unknown; isFatal: boolean | undefined }[] = [];
  let handler = (error: unknown, isFatal?: boolean) => {
    received.push({ error, isFatal });
  };
  const utils: ErrorUtilsLike = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next) => {
      handler = next;
    },
  };
  return { utils, received, fire: (error: unknown, isFatal?: boolean) => handler(error, isFatal) };
}

function fakeLogger() {
  const entries: LogEntry[] = [];
  const logger: LoggerPort = { log: (entry) => entries.push(entry) };
  return { logger, entries };
}

describe('global error handler', () => {
  it('logs a typed event and passes on the error without its message', () => {
    const { utils, received, fire } = fakeErrorUtils();
    const { logger, entries } = fakeLogger();
    installGlobalErrorHandler(utils, logger);

    fire(new TypeError(`Cannot read ${SECRET}`), true);

    expect(entries).toEqual([{ event: 'invariant_violation', cause: 'unexpected' }]);
    expect(received).toHaveLength(1);
    const passed = received[0]?.error as Error;
    expect(received[0]?.isFatal).toBe(true);
    expect(passed.name).toBe('TypeError');
    expect(passed.message).toBe('[redacted]');
    expect(JSON.stringify({ m: passed.message, s: passed.stack })).not.toContain(SECRET);
    expect(passed.stack).toMatch(/^TypeError: \[redacted\]/);
  });

  it('keeps stack frames but drops a multi-line message', () => {
    const error = new Error(`line one ${SECRET}\nline two ${SECRET}`);
    error.stack = `Error: line one ${SECRET}\nline two ${SECRET}\n    at upload (bundle.js:10:5)\n    at run (bundle.js:20:1)`;
    const redacted = redactError(error);
    expect(redacted.stack).toBe(
      'Error: [redacted]\n    at upload (bundle.js:10:5)\n    at run (bundle.js:20:1)',
    );
  });

  it('handles thrown non-errors and a missing ErrorUtils', () => {
    expect(redactError(`raw ${SECRET}`).message).toBe('[redacted]');
    const { logger } = fakeLogger();
    expect(() => installGlobalErrorHandler(undefined, logger)).not.toThrow();
  });
});
