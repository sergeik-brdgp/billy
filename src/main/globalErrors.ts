// Uncaught JS errors. Adapters catch what they expect, but an unexpected exception can carry a file
// URI or name in its message (expo-file-system errors do), and the default handler prints it to the
// dev log and, in release, puts it into the native crash report. The TZ forbids file names in
// crash logs: log a typed event instead, and hand the default handler the same error with the
// message removed (name and stack frames are kept, so the crash is still traceable).

import type { LoggerPort } from '../core';

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

/** The subset of React Native's global `ErrorUtils` used here. */
export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

const REDACTED = '[redacted]';

export function redactError(error: unknown): Error {
  const name = error instanceof Error ? error.name : 'Error';
  const redacted = new Error(REDACTED);
  redacted.name = name;
  const stack = error instanceof Error ? error.stack : undefined;
  // Only the frame lines: the first line(s) of a stack repeat the message.
  const frames =
    typeof stack === 'string' ? stack.split('\n').filter((l) => /^\s+at /.test(l)) : [];
  redacted.stack = [`${name}: ${REDACTED}`, ...frames].join('\n');
  return redacted;
}

export function installGlobalErrorHandler(
  errorUtils: ErrorUtilsLike | undefined,
  logger: LoggerPort,
): void {
  if (errorUtils === undefined) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    logger.log({ event: 'invariant_violation', cause: 'unexpected' });
    previous(redactError(error), isFatal);
  });
}
