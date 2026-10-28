// Typed, allow-listed log events.
// A log entry can only carry these fields. Free text, file names, URIs, bytes and server result
// fields (merchant names) have no slot, and `sanitizeLogEntry` drops anything else at runtime too.

import { PHASE_TAGS, type OpId, type PhaseTag } from './domain';

export const LOG_EVENTS = [
  'controller_started',
  'cold_start_recovery',
  'sweep_done',
  'op_created',
  'phase_changed',
  'post_started',
  /** The bounded in-session same-key re-POST after a by-key 404 race. */
  'post_auto_resend',
  'post_finished',
  'lookup_finished',
  'get_finished',
  'delete_finished',
  'view_ignored',
  'stale_response',
  'persist_failed',
  'store_load_failed',
  'store_row_invalid',
  /** A row from an older build (name / report inside) could not be rewritten minimised yet. */
  'journal_rewrite_failed',
  'local_rejection',
  'client_bug',
  'config_error',
  'file_missing',
  'temp_delete_failed',
  'invariant_violation',
  'mock_reset',
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export const LOG_CAUSES = [
  'not_sent',
  'unreachable',
  'timeout',
  'reset_after_send',
  'interrupted',
  'server_error',
  'http_5xx',
  'client_error',
  'config_error',
  'protocol_error',
  'not_found',
  'found',
  'identity_mismatch',
  'stale_revision',
  'tombstone',
  'terminal',
  'unexpected',
  'not_statement',
  'oversize',
  'unreadable',
  'storage',
  'aborted',
  'ok',
] as const;
export type LogCause = (typeof LOG_CAUSES)[number];

export interface LogEntry {
  readonly event: LogEvent;
  readonly opId?: OpId;
  readonly phase?: PhaseTag;
  readonly httpStatus?: number;
  readonly revision?: number;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly cause?: LogCause;
}

export interface LoggerPort {
  log(entry: LogEntry): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eventSet: ReadonlySet<string> = new Set(LOG_EVENTS);
const causeSet: ReadonlySet<string> = new Set(LOG_CAUSES);
const phaseSet: ReadonlySet<string> = new Set(PHASE_TAGS);

function smallInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e12
    ? value
    : undefined;
}

/**
 * Rebuilds an entry from allow-listed fields only. Values of the wrong shape are dropped
 * (an opId that is not a UUID could be a path or a name). Returns null for unknown events.
 */
export function sanitizeLogEntry(input: unknown): LogEntry | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.event !== 'string' || !eventSet.has(raw.event)) return null;
  const entry: {
    event: LogEvent;
    opId?: OpId;
    phase?: PhaseTag;
    httpStatus?: number;
    revision?: number;
    attempt?: number;
    durationMs?: number;
    cause?: LogCause;
  } = { event: raw.event as LogEvent };
  if (typeof raw.opId === 'string' && UUID_RE.test(raw.opId)) entry.opId = raw.opId as OpId;
  if (typeof raw.phase === 'string' && phaseSet.has(raw.phase)) entry.phase = raw.phase as PhaseTag;
  if (typeof raw.cause === 'string' && causeSet.has(raw.cause)) entry.cause = raw.cause as LogCause;
  const httpStatus = smallInt(raw.httpStatus);
  if (httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599)
    entry.httpStatus = httpStatus;
  const revision = smallInt(raw.revision);
  if (revision !== undefined) entry.revision = revision;
  const attempt = smallInt(raw.attempt);
  if (attempt !== undefined) entry.attempt = attempt;
  const durationMs = smallInt(raw.durationMs);
  if (durationMs !== undefined) entry.durationMs = durationMs;
  return entry;
}

/** Wraps a sink (the platform adapter owns the actual `console`/file sink) with sanitising. */
export function createLogger(sink: (entry: LogEntry) => void): LoggerPort {
  return {
    log(entry) {
      const clean = sanitizeLogEntry(entry);
      if (clean === null) return;
      try {
        sink(clean);
      } catch {
        // A failing log sink must never break an import.
      }
    },
  };
}

/** A logger that drops everything (tests, or when logging is disabled). */
export const silentLogger: LoggerPort = { log: () => undefined };
