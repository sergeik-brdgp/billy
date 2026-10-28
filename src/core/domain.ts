// Domain model of one statement import. Plain TypeScript, persisted as schemaVersion 1.

declare const brand: unique symbol;
/** Nominal ("branded") string so ids of different kinds cannot be mixed up. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OpId = Brand<string, 'OpId'>;
export type IdempotencyKey = Brand<string, 'IdemKey'>;
export type DeleteKey = Brand<string, 'DeleteKey'>;
export type JobId = Brand<string, 'JobId'>;

export const asOpId = (value: string): OpId => value as OpId;
export const asIdempotencyKey = (value: string): IdempotencyKey => value as IdempotencyKey;
export const asDeleteKey = (value: string): DeleteKey => value as DeleteKey;
export const asJobId = (value: string): JobId => value as JobId;

/** Exhaustiveness guard for discriminated unions. */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`);
}

export type FileFormat = 'pdf' | 'csv';

/** Why a POST (or any request) did not produce an HTTP response. */
export type TransportCause =
  /** Failed before the request left (bad header, file missing): nothing reached the server. */
  | 'not_sent'
  /** Connection refused / DNS / offline: the request certainly did not reach the server. */
  | 'unreachable'
  | 'timeout'
  /** Connection dropped after (part of) the body was written: outcome unknown. */
  | 'reset_after_send'
  /** App killed / suspended while in flight (cold-start recovery). */
  | 'interrupted';

/**
 * Cause of an unknown POST outcome. `server_error` (5xx or an unparsable 202 body) is an addition
 * to the server answered, but we cannot know whether it committed the job.
 */
export type UnknownOutcomeCause = TransportCause | 'server_error';

/**
 * State of the by-key lookup in `outcome_unknown`. `skipped` is an addition to for the
 * "lookup skipped for not_sent" rule of §3.3 (first attempt never left the device). `settling`:
 * the user abandoned, a lookup said 404, and a delayed re-check is scheduled (bytes may still land).
 */
export type LookupState = 'pending' | 'not_found' | 'unreachable' | 'skipped' | 'settling';

export type ServerStatus = 'queued' | 'processing' | 'ready';
export type JobStatus = ServerStatus | 'deleting' | 'deleted';

export type DeleteFailureCause = 'http_5xx' | 'client_error' | TransportCause;

export type Phase =
  /** Persisted; POST not started yet. */
  | { readonly tag: 'pending_send' }
  /** Persisted right before the POST. */
  | { readonly tag: 'sending'; readonly attempt: number }
  | {
      readonly tag: 'outcome_unknown';
      readonly cause: UnknownOutcomeCause;
      readonly lookup: LookupState;
      /** Number of POST attempts made so far (≥ 0); a resend becomes attempt + 1. */
      readonly attempt: number;
      /** The user chose "Cancel import"/"Cancel": by-key 404s (after re-checks) end in `cancelled`. */
      readonly abandon: boolean;
    }
  | { readonly tag: 'server'; readonly jobId: JobId; readonly status: ServerStatus }
  /** 409 / 413 / 415 — terminal. */
  | { readonly tag: 'rejected_by_server'; readonly httpStatus: number; readonly error: string }
  /** Persisted before DELETE. */
  | { readonly tag: 'delete_requested'; readonly jobId: JobId }
  | { readonly tag: 'delete_failed'; readonly jobId: JobId; readonly cause: DeleteFailureCause }
  | { readonly tag: 'deleting'; readonly jobId: JobId }
  /** Terminal; reached only from a GET / by-key view with status `deleted`. */
  | { readonly tag: 'deleted'; readonly jobId: JobId }
  /** The server no longer knows our job (reset, foreign job) — terminal. */
  | { readonly tag: 'lost'; readonly jobId: JobId | null }
  /** Terminal, only when nothing is on the server. */
  | { readonly tag: 'cancelled' };

export type PhaseTag = Phase['tag'];

export const PHASE_TAGS: readonly PhaseTag[] = [
  'pending_send',
  'sending',
  'outcome_unknown',
  'server',
  'rejected_by_server',
  'delete_requested',
  'delete_failed',
  'deleting',
  'deleted',
  'lost',
  'cancelled',
];

export type TerminalPhase = Extract<
  Phase,
  { tag: 'deleted' | 'lost' | 'cancelled' | 'rejected_by_server' }
>;

export function isTerminal(phase: Phase): phase is TerminalPhase {
  switch (phase.tag) {
    case 'deleted':
    case 'lost':
    case 'cancelled':
    case 'rejected_by_server':
      return true;
    case 'pending_send':
    case 'sending':
    case 'outcome_unknown':
    case 'server':
    case 'delete_requested':
    case 'delete_failed':
    case 'deleting':
      return false;
    default:
      return assertNever(phase, 'phase');
  }
}

/** Delete phases: views with queued/processing/ready never move the op back to `server`. */
export function isTombstone(phase: Phase): boolean {
  return (
    phase.tag === 'delete_requested' ||
    phase.tag === 'delete_failed' ||
    phase.tag === 'deleting' ||
    phase.tag === 'deleted'
  );
}

/** The server job id the phase refers to, if any. */
export function phaseJobId(phase: Phase): JobId | null {
  switch (phase.tag) {
    case 'server':
    case 'delete_requested':
    case 'delete_failed':
    case 'deleting':
    case 'deleted':
      return phase.jobId;
    case 'lost':
      return phase.jobId;
    case 'pending_send':
    case 'sending':
    case 'outcome_unknown':
    case 'rejected_by_server':
    case 'cancelled':
      return null;
    default:
      return assertNever(phase, 'phase');
  }
}

export interface ReadyItem {
  readonly id: string;
  readonly merchant: string;
  readonly amountMinor: number;
  readonly cadence: string;
  /** ISO date `YYYY-MM-DD`. */
  readonly lastSeen: string;
}

export interface ReadyResult {
  readonly currency: string;
  readonly items: readonly ReadyItem[];
}

/** A server view of a job (GET /imports/{id}, GET /imports/by-key/{key}, DELETE 202 body). */
export type ServerJobView =
  | {
      readonly jobId: JobId;
      readonly status: 'queued' | 'processing' | 'deleting' | 'deleted';
      readonly revision: number;
    }
  | {
      readonly jobId: JobId;
      readonly status: 'ready';
      readonly revision: number;
      readonly result: ReadyResult;
    };

export interface OperationFile {
  readonly format: FileFormat;
  /** Size of the private copy in bytes. */
  readonly size: number;
  /**
   * Display name; '' once terminal. Never logged. The journal keeps it only until the server
   * has the job (codec `journalForm`), so after a cold start it is '' from then on.
   */
  readonly name: string;
  /** Private copy (`<cache>/imports/<opId>.bin`); null once confirmed by the server or terminal. */
  readonly tempPath: string | null;
}

export interface Operation {
  readonly schemaVersion: 1;
  readonly opId: OpId;
  readonly createdAt: number;
  /** Generated + persisted before any POST, never regenerated. */
  readonly key: IdempotencyKey;
  /** Generated + persisted before the first DELETE, reused on retry. */
  readonly deleteKey: DeleteKey | null;
  readonly file: OperationFile;
  /** Highest revision accepted from GET / by-key views (0 = none). Never decreases. */
  readonly revision: number;
  /** In memory only (never in the journal, codec `journalForm`); cleared when terminal. */
  readonly result: ReadyResult | null;
  /** True once a lost POST response was recovered via by-key (UI badge). */
  readonly recoveredByKey: boolean;
  readonly phase: Phase;
}

/** Local verdict before any network traffic. */
export type LocalRejection =
  /** Content is neither `%PDF-` nor the exact CSV header (also: empty file). */
  | { readonly reason: 'not_statement' }
  /** More than 10 485 760 bytes; `size` is null when the copy was aborted at the limit. */
  | { readonly reason: 'oversize'; readonly size: number | null }
  /** The picked file could not be copied or read. */
  | { readonly reason: 'unreadable' };

/** A validated private copy waiting on the confirm screen. Not persisted. */
export interface Draft {
  readonly draftId: OpId;
  readonly name: string;
  readonly size: number;
  readonly format: FileFormat;
  readonly tempPath: string;
}

/** Mock scenario modes (`POST /__test/scenario`). */
export type MockMode = 'happy' | 'lost_ack' | 'stale_status' | 'delete_failure';
export const MOCK_MODES: readonly MockMode[] = [
  'happy',
  'lost_ack',
  'stale_status',
  'delete_failure',
];
