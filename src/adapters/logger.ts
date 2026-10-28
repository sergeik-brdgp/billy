// The only console sink in src/. Receives entries already sanitised by the
// core's `createLogger` (allow-listed fields only: no names, URIs, bytes or descriptions).
// Release builds: no-op — no analytics, no crash reporting SDK.

import type { LogEntry } from '../core';

const FIELD_ORDER = [
  'opId',
  'phase',
  'httpStatus',
  'revision',
  'attempt',
  'durationMs',
  'cause',
] as const;

/** One compact line: `[import] phase_changed opId=… phase=server`. */
export function formatLogLine(entry: LogEntry): string {
  const parts: string[] = [`[import] ${entry.event}`];
  for (const field of FIELD_ORDER) {
    const value = entry[field];
    if (value !== undefined) parts.push(`${field}=${String(value)}`);
  }
  return parts.join(' ');
}

/** Dev-only console sink; `isDev` defaults to `__DEV__`. */
export function createDevConsoleSink(isDev: boolean = __DEV__): (entry: LogEntry) => void {
  if (!isDev) return () => undefined;
  return (entry) => {
    // eslint-disable-next-line no-console -- the one allowed sink; entries are pre-sanitised
    console.log(formatLogLine(entry));
  };
}
