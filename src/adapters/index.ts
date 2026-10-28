// Expo / React Native implementations of the core ports (the imperative shell).
// The composition root (src/main) calls `createExpoPorts` once and hands the result to
// `createImportController`; the UI receives `pickStatementFile` as its `pickFile` prop.

import { randomUUID } from 'expo-crypto';

import { createLogger, type ClockPort, type CorePorts, type LogEntry } from '../core';
import { createExpoFiles } from './files';
import { createFetchHttp } from './http';
import { createDevConsoleSink } from './logger';
import { createSqliteStore } from './store';
import { createExpoUpload } from './upload';

export { pickStatementFile, PickerError } from './picker';
export { appSwitcherCoverEnabled, explicitAnnouncements } from './platform';

export interface ExpoPortsOptions {
  /** Extra sink for sanitised log entries (e.g. an in-memory buffer for the diagnostics screen). */
  readonly logSink?: (entry: LogEntry) => void;
}

export const systemClock: ClockPort = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createExpoPorts(options: ExpoPortsOptions = {}): CorePorts {
  const devSink = createDevConsoleSink();
  const extraSink = options.logSink;
  const logger = createLogger((entry) => {
    try {
      devSink(entry);
    } finally {
      extraSink?.(entry);
    }
  });
  return {
    http: createFetchHttp({ clock: systemClock }),
    upload: createExpoUpload({ clock: systemClock }),
    files: createExpoFiles(),
    store: createSqliteStore(),
    clock: systemClock,
    ids: { uuid: () => randomUUID().toLowerCase() },
    logger,
  };
}
