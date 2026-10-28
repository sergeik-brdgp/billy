// Pure reducer for one operation: (op, session, event) -> { op, session, effects }.
// No I/O, no time, no randomness: ids and request numbers come in through events / session.
//
// Persisted state is `Operation`; `Session` is per-process runtime state (in-flight requests,
// polling backoff, last raw view, ignored views, notices). Effects are data; the controller runs
// them in order, and `persist` (when the op changed) is always the FIRST effect, so the runner can
// await it before any network effect.

import type { ApiError, DeleteOutcome, PostOutcome, ReadOutcome } from './api';
import { encodeOperation } from './codec';
import {
  assertNever,
  isTerminal,
  isTombstone,
  phaseJobId,
  type DeleteFailureCause,
  type DeleteKey,
  type FileFormat,
  type IdempotencyKey,
  type JobId,
  type JobStatus,
  type LookupState,
  type OpId,
  type Operation,
  type Phase,
  type ServerJobView,
  type TerminalPhase,
  type UnknownOutcomeCause,
} from './domain';
import type { LogCause, LogEntry } from './log';

// ---------------------------------------------------------------------------------------------
// Session (not persisted)

export const POLL_INITIAL_MS = 400;
export const POLL_FACTOR = 1.5;
export const POLL_MAX_MS = 3000;

/**
 * Re-checks by key after a by-key 404 when the user abandons an op whose bytes may have left the
 * device (TZ: 404 means «пока не найден»). Bytes already written can still be in kernel buffers /
 * in flight after an abort, so one immediate 404 is not proof that no job will appear. Only after
 * every re-check also says 404 is the op `cancelled`.
 */
export const SETTLE_RECHECK_DELAYS_MS: readonly number[] = [1000, 3000, 10000];

/** Why a read (by-key lookup, then possibly GET /imports/{id}) was started. */
export type ReadPurpose =
  /** outcome_unknown: find the job by key after a lost / failed POST. */
  | 'recover'
  /** Poll tick while queued/processing/deleting: verify identity, then GET. */
  | 'poll'
  /** User "Refresh status": verify identity, then one GET. */
  | 'refresh'
  /** Cold start / foreground: verify identity, then GET (or follow the delete phase). */
  | 'resume'
  /** Identity check right before DELETE. */
  | 'delete';

export interface ReadInFlight {
  readonly reqId: number;
  readonly step: 'lookup' | 'get';
  readonly purpose: ReadPurpose;
}

export interface InFlight {
  /** at most one POST, one DELETE and one read (poller) per op. */
  readonly post: number | null;
  readonly del: number | null;
  readonly read: ReadInFlight | null;
}

export type Notice =
  /** A non-"job not found" 4xx: wrong base URL / route. Retryable, never terminal. */
  | { readonly tag: 'config_error'; readonly httpStatus: number }
  /** The private copy disappeared (cache purge): re-pick needed for a resend. */
  | { readonly tag: 'file_missing' }
  /** The user cancelled, but the server already had the job: it is shown with "Delete import". */
  | { readonly tag: 'cancel_too_late' }
  /** The server refused our request shape (POST 400, DELETE 400/409). Logged as a bug. */
  | { readonly tag: 'client_error'; readonly httpStatus: number };

export interface ReadError {
  readonly source: 'lookup' | 'get';
  readonly error: ApiError;
}

export type ViewSource = 'post' | 'by_key' | 'get' | 'delete';

/** A server view without the result payload (diagnostics never hold merchants / amounts, I8). */
export interface RawJobView {
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly revision: number;
}

export interface RawView {
  readonly seq: number;
  readonly source: ViewSource;
  readonly view: RawJobView;
}

export type IgnoreReason = 'stale_revision' | 'tombstone' | 'terminal' | 'unexpected';

export interface IgnoredView {
  readonly source: ViewSource;
  readonly status: ServerJobView['status'];
  readonly revision: number;
  /** op.revision at the time the view was ignored ("discarded: processing r2 ≤ r3"). */
  readonly currentRevision: number;
  readonly reason: IgnoreReason;
}

export interface Session {
  readonly nextReqId: number;
  readonly inflight: InFlight;
  /** Backoff state; non-null while polling is active for `phaseKey`. */
  readonly poll: { readonly delayMs: number; readonly phaseKey: string } | null;
  /** App in background: timers paused. */
  readonly paused: boolean;
  /** The user tapped "Cancel" while sending; the POST result is handled as an abandon. */
  readonly cancelRequested: boolean;
  /** Last read failed: the UI labels the status "Last known status". */
  readonly readError: ReadError | null;
  readonly notice: Notice | null;
  readonly rawSeq: number;
  readonly lastRawView: RawView | null;
  readonly ignored: { readonly count: number; readonly last: IgnoredView | null };
  /** Delays of the by-key re-checks before an abandon may end in `cancelled` (runtime config). */
  readonly settleDelaysMs: readonly number[];
  /** Re-checks already scheduled for the current abandon (reset by every POST). */
  readonly settleChecks: number;
  /**
   * Bounded in-session same-key re-POST on a by-key 404 race (TZ «При гонке повторяйте
   * POST с тем же ключом»). `off`: this session did not issue the op's first POST (fresh / cold
   * start) — never auto-sends; `armed`: the first POST went out in this session; `used`: the one
   * automatic re-POST was issued. Runtime only: nothing persisted can make a new session auto-send.
   */
  readonly autoResend: 'off' | 'armed' | 'used';
  /** reqId of the automatic re-POST while it is in flight (sending view: `autoRetry`). */
  readonly autoPostReqId: number | null;
}

export function initialSession(
  settleDelaysMs: readonly number[] = SETTLE_RECHECK_DELAYS_MS,
): Session {
  return {
    nextReqId: 1,
    inflight: { post: null, del: null, read: null },
    poll: null,
    paused: false,
    cancelRequested: false,
    readError: null,
    notice: null,
    rawSeq: 0,
    lastRawView: null,
    ignored: { count: 0, last: null },
    settleDelaysMs,
    settleChecks: 0,
    autoResend: 'off',
    autoPostReqId: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Events and effects

export type MachineEvent =
  /**
   * User: "Send" (pending_send) or "Send again" (outcome_unknown). The only source of a
   * POST besides the one bounded in-session same-key re-POST on a by-key 404 race (I7, §3.3).
   */
  | { readonly type: 'send' }
  /** User: "Cancel" while sending. */
  | { readonly type: 'cancel_sending' }
  /** User: "Check again" in outcome_unknown. */
  | { readonly type: 'check_again' }
  /** User: "Cancel import" in outcome_unknown (final lookup first). */
  | { readonly type: 'abandon' }
  /** User: "Refresh status" / opening "Details". */
  | { readonly type: 'refresh' }
  /** User: "Delete import"; `newDeleteKey` is used only if the op has none yet. */
  | { readonly type: 'request_delete'; readonly newDeleteKey: DeleteKey }
  /**
   * User: "Retry deletion" (same delete key). `newDeleteKey` is used only if the op has none
   * (a corrupt journal row): the mock accepts a fresh key for the same job.
   */
  | { readonly type: 'retry_delete'; readonly newDeleteKey?: DeleteKey }
  | { readonly type: 'poll_tick' }
  | { readonly type: 'foreground' }
  | { readonly type: 'background' }
  /** First event after loading the op from the journal (session must be fresh). */
  | { readonly type: 'cold_start' }
  | { readonly type: 'post_result'; readonly reqId: number; readonly outcome: PostOutcome }
  | { readonly type: 'lookup_result'; readonly reqId: number; readonly outcome: ReadOutcome }
  | { readonly type: 'get_result'; readonly reqId: number; readonly outcome: ReadOutcome }
  | { readonly type: 'delete_result'; readonly reqId: number; readonly outcome: DeleteOutcome };

export type Effect =
  | { readonly type: 'persist'; readonly op: Operation }
  | {
      readonly type: 'post';
      readonly reqId: number;
      readonly opId: OpId;
      readonly key: IdempotencyKey;
      readonly filePath: string;
      readonly fileName: string;
      readonly format: FileFormat;
      readonly attempt: number;
    }
  | { readonly type: 'abortPost'; readonly reqId: number }
  | { readonly type: 'lookupByKey'; readonly reqId: number; readonly key: IdempotencyKey }
  | { readonly type: 'getJob'; readonly reqId: number; readonly jobId: JobId }
  | {
      readonly type: 'del';
      readonly reqId: number;
      readonly jobId: JobId;
      readonly deleteKey: DeleteKey;
    }
  | { readonly type: 'schedulePoll'; readonly delayMs: number }
  | { readonly type: 'cancelPoll' }
  | { readonly type: 'deleteTempFile'; readonly path: string }
  | { readonly type: 'log'; readonly entry: LogEntry };

export type NetworkEffect = Extract<Effect, { type: 'post' | 'lookupByKey' | 'getJob' | 'del' }>;

export function isNetworkEffect(effect: Effect): effect is NetworkEffect {
  return (
    effect.type === 'post' ||
    effect.type === 'lookupByKey' ||
    effect.type === 'getJob' ||
    effect.type === 'del'
  );
}

export interface MachineState {
  readonly op: Operation;
  readonly session: Session;
}

export interface Transition extends MachineState {
  readonly effects: readonly Effect[];
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Phases in which a poller runs. */
export function isPollable(phase: Phase): boolean {
  return (
    (phase.tag === 'server' && (phase.status === 'queued' || phase.status === 'processing')) ||
    phase.tag === 'deleting'
  );
}

/**
 * Whether the poller should run for this op: a pollable phase, or a ready op whose report is not
 * in memory (the journal never stores it, so after a cold start it is re-fetched; when both reads
 * came back stale or failed, the same backoff keeps retrying until the report is filled).
 */
export function needsPolling(op: Operation): boolean {
  return (
    isPollable(op.phase) ||
    (op.phase.tag === 'server' && op.phase.status === 'ready' && op.result === null)
  );
}

/** A by-key lookup runs or is scheduled: no resend / abandon / check-again meanwhile. */
export function isLookupBusy(lookup: LookupState): boolean {
  return lookup === 'pending' || lookup === 'settling';
}

function phaseKey(phase: Phase): string {
  return phase.tag === 'server' ? `server:${phase.status}` : phase.tag;
}

function apiErrorCause(error: ApiError): LogCause {
  switch (error.kind) {
    case 'transport':
      return error.cause;
    case 'config':
      return 'config_error';
    case 'server':
      return 'http_5xx';
    case 'protocol':
      return 'protocol_error';
    default:
      return assertNever(error, 'api error');
  }
}

function deleteFailureCause(error: ApiError): DeleteFailureCause {
  switch (error.kind) {
    case 'transport':
      return error.cause;
    case 'server':
      return 'http_5xx';
    case 'config':
    case 'protocol':
      return 'client_error';
    default:
      return assertNever(error, 'api error');
  }
}

/** Mutable builder used inside one reduce() call; the result is frozen data. */
class Tx {
  op: Operation;
  session: Session;
  private readonly local: Effect[] = [];
  private readonly network: Effect[] = [];

  constructor(private readonly before: MachineState) {
    this.op = before.op;
    this.session = before.session;
  }

  setSession(patch: Partial<Session>): void {
    this.session = { ...this.session, ...patch };
  }

  setInflight(patch: Partial<InFlight>): void {
    this.session = { ...this.session, inflight: { ...this.session.inflight, ...patch } };
  }

  setPhase(phase: Phase): void {
    this.op = { ...this.op, phase };
  }

  log(entry: Omit<LogEntry, 'opId'>): void {
    this.local.push({ type: 'log', entry: { ...entry, opId: this.op.opId } });
  }

  notice(notice: Notice | null): void {
    this.setSession({ notice });
  }

  private reqId(): number {
    const id = this.session.nextReqId;
    this.setSession({ nextReqId: id + 1 });
    return id;
  }

  recordView(source: ViewSource, view: ServerJobView): void {
    const seq = this.session.rawSeq + 1;
    // Never keep the result (merchants, amounts) outside the op: it would outlive I8.
    const raw: RawJobView = { jobId: view.jobId, status: view.status, revision: view.revision };
    this.setSession({ rawSeq: seq, lastRawView: { seq, source, view: raw } });
  }

  ignore(source: ViewSource, view: ServerJobView, reason: IgnoreReason): void {
    const last: IgnoredView = {
      source,
      status: view.status,
      revision: view.revision,
      currentRevision: this.op.revision,
      reason,
    };
    this.setSession({ ignored: { count: this.session.ignored.count + 1, last } });
    this.log({
      event: 'view_ignored',
      phase: this.op.phase.tag,
      revision: view.revision,
      cause: reason,
    });
  }

  // -- private copy ------------------------------------------------------------------------

  /** The server has the bytes (202 or by-key found) or the op is over: drop the private copy. */
  dropTempFile(): void {
    const path = this.op.file.tempPath;
    if (path === null) return;
    this.op = { ...this.op, file: { ...this.op.file, tempPath: null } };
    this.local.push({ type: 'deleteTempFile', path });
  }

  /** Entering a terminal phase: no name, no result, no temp file; polling stops. */
  finish(phase: TerminalPhase): void {
    this.dropTempFile();
    this.op = { ...this.op, phase, result: null, file: { ...this.op.file, name: '' } };
    this.setSession({ cancelRequested: false, readError: null });
    this.stopPolling();
  }

  // -- network -----------------------------------------------------------------------------

  /** `auto`: the bounded same-key re-POST on a by-key 404 race (not a user tap). */
  startPost(attempt: number, auto = false): void {
    const filePath = this.op.file.tempPath;
    if (filePath === null || this.session.inflight.post !== null) return;
    const reqId = this.reqId();
    this.setPhase({ tag: 'sending', attempt });
    this.setInflight({ post: reqId });
    this.setSession({
      cancelRequested: false,
      readError: null,
      settleChecks: 0,
      autoPostReqId: auto ? reqId : null,
    });
    this.network.push({
      type: 'post',
      reqId,
      opId: this.op.opId,
      key: this.op.key,
      filePath,
      fileName: this.op.file.name,
      format: this.op.file.format,
      attempt,
    });
    this.log({ event: 'post_started', phase: 'sending', attempt });
  }

  /** Starts a read if the read lane is free; otherwise the in-flight read's continuation decides. */
  startLookup(purpose: ReadPurpose): void {
    if (this.session.inflight.read !== null) return;
    const reqId = this.reqId();
    this.setInflight({ read: { reqId, step: 'lookup', purpose } });
    this.network.push({ type: 'lookupByKey', reqId, key: this.op.key });
  }

  startGet(purpose: ReadPurpose, jobId: JobId): void {
    const reqId = this.reqId();
    this.setInflight({ read: { reqId, step: 'get', purpose } });
    this.network.push({ type: 'getJob', reqId, jobId });
  }

  startDelete(jobId: JobId): void {
    const deleteKey = this.op.deleteKey;
    if (this.session.inflight.del !== null) return;
    if (deleteKey === null) {
      // Corrupt row (delete phase without a key): never sit in delete_requested with nothing in
      // flight; "Retry deletion" then assigns a key.
      this.log({ event: 'invariant_violation', phase: this.op.phase.tag, cause: 'client_error' });
      this.setPhase({ tag: 'delete_failed', jobId, cause: 'client_error' });
      return;
    }
    const reqId = this.reqId();
    this.setInflight({ del: reqId });
    this.network.push({ type: 'del', reqId, jobId, deleteKey });
  }

  /** Cancels the in-flight upload; its (transport) result then goes through the abandon path. */
  abortPost(reqId: number): void {
    this.local.push({ type: 'abortPost', reqId });
  }

  // -- polling -----------------------------------------------------------------------------

  schedulePollIfNeeded(): void {
    const phase = this.op.phase;
    if (!needsPolling(this.op) || this.session.paused || this.session.inflight.read !== null)
      return;
    const key = phaseKey(phase);
    const prev = this.session.poll;
    // Backoff resets to the initial delay on every phase change.
    const delayMs =
      prev === null || prev.phaseKey !== key
        ? POLL_INITIAL_MS
        : Math.min(Math.round(prev.delayMs * POLL_FACTOR), POLL_MAX_MS);
    this.setSession({ poll: { delayMs, phaseKey: key } });
    this.local.push({ type: 'schedulePoll', delayMs });
  }

  stopPolling(): void {
    if (this.session.poll !== null) {
      this.setSession({ poll: null });
    }
    this.local.push({ type: 'cancelPoll' });
  }

  /** Schedules the next abandon re-check; false when all of them were used up. */
  scheduleSettleRecheck(): boolean {
    const delayMs = this.session.settleDelaysMs[this.session.settleChecks];
    if (delayMs === undefined) return false;
    this.setSession({ settleChecks: this.session.settleChecks + 1 });
    this.local.push({ type: 'schedulePoll', delayMs });
    return true;
  }

  // -- result ------------------------------------------------------------------------------

  build(): Transition {
    const before = this.before.op;
    const effects: Effect[] = [];
    if (this.op !== before) {
      if (this.op.phase.tag !== before.phase.tag) {
        this.log({ event: 'phase_changed', phase: this.op.phase.tag, revision: this.op.revision });
      }
      // Only what the journal stores counts (codec `journalForm`): re-fetching the in-memory ready
      // result after a cold start changes nothing on disk, so it writes nothing.
      if (encodeOperation(this.op) !== encodeOperation(before)) {
        effects.push({ type: 'persist', op: this.op });
      }
    }
    effects.push(...this.local, ...this.network);
    return { op: this.op, session: this.session, effects };
  }
}

// ---------------------------------------------------------------------------------------------
// View application

/**
 * Applies a GET / by-key view (identity already checked by the caller).
 * A view is applied iff `revision > op.revision`, or `>=` for `deleted`; equal revisions are a
 * silent no-op; lower ones are counted as ignored. Tombstone phases never go back to `server`.
 */
function applyView(tx: Tx, source: ViewSource, view: ServerJobView): void {
  const op = tx.op;
  if (isTerminal(op.phase)) {
    tx.ignore(source, view, 'terminal');
    return;
  }
  if (
    view.status === 'ready' &&
    view.revision === op.revision &&
    op.result === null &&
    op.phase.tag === 'server' &&
    op.phase.status === 'ready' &&
    op.phase.jobId === view.jobId
  ) {
    // The journal never stores the ready result (codec `journalForm`): after a cold start the
    // op is ready with no result, and the same revision re-fetched by key → GET fills it in
    // memory. Same jobId and revision: the same server data, so I2 still holds.
    tx.op = { ...op, result: view.result };
    return;
  }
  const fresh =
    view.status === 'deleted' ? view.revision >= op.revision : view.revision > op.revision;
  if (!fresh) {
    if (view.revision < op.revision) tx.ignore(source, view, 'stale_revision');
    return;
  }
  if (op.phase.tag === 'pending_send' || op.phase.tag === 'sending') {
    tx.ignore(source, view, 'unexpected');
    return;
  }
  switch (view.status) {
    case 'queued':
    case 'processing':
    case 'ready':
      if (isTombstone(op.phase)) {
        tx.ignore(source, view, 'tombstone');
        return;
      }
      tx.op = {
        ...op,
        revision: view.revision,
        result: view.status === 'ready' ? view.result : null,
        phase: { tag: 'server', jobId: view.jobId, status: view.status },
      };
      return;
    case 'deleting':
      tx.op = { ...op, revision: view.revision, phase: { tag: 'deleting', jobId: view.jobId } };
      return;
    case 'deleted':
      tx.op = { ...op, revision: view.revision };
      tx.finish({ tag: 'deleted', jobId: view.jobId });
      return;
    default:
      assertNever(view, 'view');
  }
}

// ---------------------------------------------------------------------------------------------
// Continuations

/** Called whenever the read lane becomes free: decide what runs next. */
function afterRead(tx: Tx): void {
  const phase = tx.op.phase;
  if (isTerminal(phase)) {
    tx.stopPolling();
    return;
  }
  if (phase.tag === 'outcome_unknown' && phase.lookup === 'pending') {
    tx.startLookup('recover');
    return;
  }
  if (phase.tag === 'delete_requested') {
    if (tx.session.inflight.del === null) tx.startLookup('delete');
    return;
  }
  tx.schedulePollIfNeeded();
}

/**
 * Whether the latest POST may still create a job after the by-key 404 (bytes left the device and
 * no definitive answer came back). `not_sent` / `unreachable`: nothing was received.
 */
function mayHaveReachedServer(cause: UnknownOutcomeCause): boolean {
  return cause !== 'not_sent' && cause !== 'unreachable';
}

/**
 * Causes after which a by-key 404 is an in-session race («пока не найден»): the bytes may have
 * left the device and no definitive answer came back. `not_sent` / `unreachable`: nothing was
 * received, so a 404 is not a race. `server_error`: the server answered — no automatic resend.
 * `interrupted` is the cold-start cause (the app died mid-send); a cold-started session is never
 * armed, so it is never auto-resent and is deliberately not listed here.
 */
const AUTO_RESEND_CAUSES: ReadonlySet<UnknownOutcomeCause> = new Set([
  'timeout',
  'reset_after_send',
]);

/**
 * The bounded in-session same-key re-POST (owner decision on the TZ rule «404 означает
 * «пока не найден». При гонке повторяйте POST с тем же ключом»). Only after the genuine by-key 404,
 * never for an abandon, never in a session that did not issue the op's first POST (cold start),
 * at most once per op per session, and only with the private copy (same key, same bytes, same
 * X-File-Name — the mock dedups by key + sha256, so at most one job). Never from the background:
 * the OS would likely kill the upload and spend the one attempt; a 404 that arrives while paused
 * leaves the op `not_found` and the `foreground` handler re-checks the key, then re-POSTs.
 */
function mayAutoResend(tx: Tx, phase: Extract<Phase, { tag: 'outcome_unknown' }>): boolean {
  return (
    tx.session.autoResend === 'armed' &&
    !tx.session.paused &&
    !phase.abandon &&
    AUTO_RESEND_CAUSES.has(phase.cause) &&
    tx.op.file.tempPath !== null &&
    tx.session.inflight.post === null
  );
}

/** After a POST failed without creating anything certain: decide lookup / skip / cancel. */
function toOutcomeUnknown(
  tx: Tx,
  cause: UnknownOutcomeCause,
  attempt: number,
  abandon: boolean,
): void {
  // Nothing left the device on the very first attempt: no lookup needed.
  const certainlyNothing = cause === 'not_sent' && attempt <= 1;
  if (certainlyNothing && abandon) {
    tx.finish({ tag: 'cancelled' });
    return;
  }
  tx.setPhase({
    tag: 'outcome_unknown',
    cause,
    lookup: certainlyNothing ? 'skipped' : 'pending',
    attempt,
    abandon,
  });
  if (!certainlyNothing) tx.startLookup('recover');
}

// ---------------------------------------------------------------------------------------------
// Handlers

function onSend(tx: Tx): void {
  const phase = tx.op.phase;
  if (tx.session.inflight.post !== null || tx.op.file.tempPath === null) return;
  if (phase.tag === 'pending_send') {
    // This session issues the op's first POST: it may later make the one automatic same-key
    // re-POST on a by-key 404 race. A cold-started session never gets here (pending_send →
    // outcome_unknown{interrupted}), so it never auto-sends.
    tx.setSession({ autoResend: 'armed' });
    tx.startPost(1);
    return;
  }
  if (phase.tag === 'outcome_unknown' && !isLookupBusy(phase.lookup)) {
    tx.notice(null);
    tx.startPost(phase.attempt + 1);
  }
}

function onPostResult(tx: Tx, reqId: number, outcome: PostOutcome): void {
  const phase = tx.op.phase;
  if (tx.session.inflight.post !== reqId || phase.tag !== 'sending') {
    // Late / duplicate response (e.g. a 202 for an op that is ready or deleted): never resurrects.
    tx.log({
      event: 'stale_response',
      phase: phase.tag,
      cause: outcome.tag === 'accepted' ? 'found' : 'aborted',
    });
    return;
  }
  const attempt = phase.attempt;
  const abandon = tx.session.cancelRequested;
  const wasAuto = tx.session.autoPostReqId === reqId;
  tx.setInflight({ post: null });
  tx.setSession({ cancelRequested: false, autoPostReqId: null });

  if (wasAuto && outcome.tag === 'rejected' && outcome.httpStatus === 409) {
    // Same key + same bytes can never be "key reused for another file": if the mock says so, it
    // is a client bug (e.g. the private copy changed). Never terminal, never retried on its own;
    // the by-key lookup that follows finds whatever holds the key, so it keeps a delete path.
    // Cause `server_error`, not `not_sent`: the server answered and the earlier race attempt may
    // have landed, so the copy stays "unknown" and an abandon still gets the settle re-checks.
    tx.log({ event: 'client_bug', httpStatus: 409, attempt, cause: 'client_error' });
    tx.notice({ tag: 'client_error', httpStatus: 409 });
    toOutcomeUnknown(tx, 'server_error', attempt, abandon);
    return;
  }

  switch (outcome.tag) {
    case 'accepted': {
      const view: ServerJobView = {
        jobId: outcome.jobId,
        status: 'queued',
        revision: outcome.revision,
      };
      tx.recordView('post', view);
      tx.op = {
        ...tx.op,
        revision: Math.max(tx.op.revision, outcome.revision),
        phase: { tag: 'server', jobId: outcome.jobId, status: 'queued' },
      };
      tx.dropTempFile(); // job confirmation: the server has the bytes
      if (abandon) tx.notice({ tag: 'cancel_too_late' });
      tx.log({
        event: 'post_finished',
        httpStatus: 202,
        revision: outcome.revision,
        attempt,
        cause: 'ok',
      });
      afterRead(tx);
      return;
    }
    case 'rejected':
      tx.log({ event: 'post_finished', httpStatus: outcome.httpStatus, attempt });
      tx.finish({
        tag: 'rejected_by_server',
        httpStatus: outcome.httpStatus,
        error: outcome.error,
      });
      return;
    case 'client_error':
      tx.log({
        event: 'client_bug',
        httpStatus: outcome.httpStatus,
        attempt,
        cause: 'client_error',
      });
      tx.notice({ tag: 'client_error', httpStatus: outcome.httpStatus });
      toOutcomeUnknown(tx, 'not_sent', attempt, abandon);
      return;
    case 'file_missing':
      tx.log({ event: 'file_missing', attempt, cause: 'not_sent' });
      tx.dropTempFile(); // already gone; the delete is a harmless no-op that keeps I8 uniform
      tx.notice({ tag: 'file_missing' });
      toOutcomeUnknown(tx, 'not_sent', attempt, abandon);
      return;
    case 'failed': {
      const error = outcome.error;
      tx.log({
        event: 'post_finished',
        attempt,
        cause: apiErrorCause(error),
        ...(error.kind === 'transport' ? {} : { httpStatus: error.httpStatus }),
      });
      switch (error.kind) {
        case 'transport':
          toOutcomeUnknown(tx, error.cause, attempt, abandon);
          return;
        case 'config':
          // Route not found: the request never reached POST /imports.
          tx.notice({ tag: 'config_error', httpStatus: error.httpStatus });
          tx.log({ event: 'config_error', httpStatus: error.httpStatus });
          toOutcomeUnknown(tx, 'not_sent', attempt, abandon);
          return;
        case 'server':
        case 'protocol':
          toOutcomeUnknown(tx, 'server_error', attempt, abandon);
          return;
        default:
          assertNever(error, 'api error');
      }
      return;
    }
    default:
      assertNever(outcome, 'post outcome');
  }
}

function onCancelSending(tx: Tx): void {
  const reqId = tx.session.inflight.post;
  if (tx.op.phase.tag !== 'sending' || reqId === null || tx.session.cancelRequested) return;
  tx.setSession({ cancelRequested: true });
  tx.abortPost(reqId);
}

function onLookupResult(tx: Tx, reqId: number, outcome: ReadOutcome): void {
  const read = tx.session.inflight.read;
  if (read === null || read.reqId !== reqId || read.step !== 'lookup') {
    tx.log({ event: 'stale_response', phase: tx.op.phase.tag, cause: 'aborted' });
    return;
  }
  tx.setInflight({ read: null });
  const phase = tx.op.phase;

  if (outcome.tag === 'found') tx.recordView('by_key', outcome.view);
  tx.log({
    event: 'lookup_finished',
    phase: phase.tag,
    cause: outcome.tag === 'failed' ? apiErrorCause(outcome.error) : outcome.tag,
    ...(outcome.tag === 'found' ? { revision: outcome.view.revision } : {}),
  });

  if (isTerminal(phase) || phase.tag === 'pending_send' || phase.tag === 'sending') {
    if (outcome.tag === 'found')
      tx.ignore('by_key', outcome.view, isTerminal(phase) ? 'terminal' : 'unexpected');
    afterRead(tx);
    return;
  }

  if (phase.tag === 'outcome_unknown') {
    switch (outcome.tag) {
      case 'found': {
        tx.op = { ...tx.op, recoveredByKey: true };
        tx.setSession({ readError: null });
        applyView(tx, 'by_key', outcome.view);
        tx.dropTempFile(); // job confirmation by key
        if (phase.abandon) tx.notice({ tag: 'cancel_too_late' });
        else if (tx.session.notice?.tag !== 'config_error') tx.notice(null);
        break;
      }
      case 'not_found':
        tx.setSession({ readError: null });
        if (phase.abandon) {
          // TZ: 404 means «пока не найден». Bytes that may have left the device can still land:
          // re-check after settle delays before claiming nothing is on the server.
          if (mayHaveReachedServer(phase.cause) && tx.scheduleSettleRecheck()) {
            tx.setPhase({ ...phase, lookup: 'settling' });
          } else {
            tx.finish({ tag: 'cancelled' });
          }
        } else if (mayAutoResend(tx, phase)) {
          // TZ: «404 означает «пока не найден». При гонке повторяйте POST с тем же ключом».
          // One automatic re-POST per op per session; persisted as `sending` before it leaves.
          tx.setSession({ autoResend: 'used' });
          tx.notice(null);
          tx.log({ event: 'post_auto_resend', attempt: phase.attempt + 1, cause: phase.cause });
          tx.startPost(phase.attempt + 1, true);
          return;
        } else {
          tx.setPhase({ ...phase, lookup: 'not_found' });
        }
        break;
      case 'failed':
        tx.setSession({ readError: { source: 'lookup', error: outcome.error } });
        if (outcome.error.kind === 'config')
          tx.notice({ tag: 'config_error', httpStatus: outcome.error.httpStatus });
        tx.setPhase({ ...phase, lookup: 'unreachable' });
        break;
      default:
        assertNever(outcome, 'read outcome');
    }
    afterRead(tx);
    return;
  }

  // Phases with a job id: identity verification.
  const jobId = phaseJobId(phase);
  if (jobId === null) {
    afterRead(tx);
    return;
  }
  switch (outcome.tag) {
    case 'found': {
      if (outcome.view.jobId !== jobId) {
        // Our key now maps to another job: ours is gone (never touch the other one).
        tx.log({ event: 'lookup_finished', phase: phase.tag, cause: 'identity_mismatch' });
        tx.finish({ tag: 'lost', jobId });
        return;
      }
      tx.setSession({ readError: null });
      if (tx.session.notice?.tag === 'config_error') tx.notice(null);
      applyView(tx, 'by_key', outcome.view);
      const next = tx.op.phase;
      if (isTerminal(next)) return;
      if (next.tag === 'delete_requested') {
        tx.startDelete(next.jobId);
        return;
      }
      if ((next.tag === 'server' || next.tag === 'deleting') && read.purpose !== 'delete') {
        tx.startGet(read.purpose, next.jobId);
        return;
      }
      afterRead(tx);
      return;
    }
    case 'not_found':
      tx.finish({ tag: 'lost', jobId });
      return;
    case 'failed': {
      const error = outcome.error;
      tx.setSession({ readError: { source: 'lookup', error } });
      if (error.kind === 'config') {
        tx.notice({ tag: 'config_error', httpStatus: error.httpStatus });
        tx.log({ event: 'config_error', httpStatus: error.httpStatus });
      }
      if (phase.tag === 'delete_requested') {
        // Could not verify identity: do not DELETE blindly; the user can retry.
        tx.setPhase({ tag: 'delete_failed', jobId, cause: deleteFailureCause(error) });
        return;
      }
      afterRead(tx);
      return;
    }
    default:
      assertNever(outcome, 'read outcome');
  }
}

function onGetResult(tx: Tx, reqId: number, outcome: ReadOutcome): void {
  const read = tx.session.inflight.read;
  if (read === null || read.reqId !== reqId || read.step !== 'get') {
    tx.log({ event: 'stale_response', phase: tx.op.phase.tag, cause: 'aborted' });
    return;
  }
  tx.setInflight({ read: null });
  const phase = tx.op.phase;
  const jobId = phaseJobId(phase);
  tx.log({
    event: 'get_finished',
    phase: phase.tag,
    cause: outcome.tag === 'failed' ? apiErrorCause(outcome.error) : outcome.tag,
    ...(outcome.tag === 'found' ? { revision: outcome.view.revision } : {}),
  });
  if (isTerminal(phase) || jobId === null) {
    if (outcome.tag === 'found') {
      tx.recordView('get', outcome.view);
      tx.ignore('get', outcome.view, isTerminal(phase) ? 'terminal' : 'unexpected');
    }
    afterRead(tx);
    return;
  }
  switch (outcome.tag) {
    case 'found':
      tx.recordView('get', outcome.view);
      if (outcome.view.jobId !== jobId) {
        tx.setSession({
          readError: { source: 'get', error: { kind: 'protocol', httpStatus: 200 } },
        });
        break;
      }
      tx.setSession({ readError: null });
      if (tx.session.notice?.tag === 'config_error') tx.notice(null);
      applyView(tx, 'get', outcome.view);
      break;
    case 'not_found':
      tx.finish({ tag: 'lost', jobId });
      return;
    case 'failed':
      tx.setSession({ readError: { source: 'get', error: outcome.error } });
      if (outcome.error.kind === 'config') {
        tx.notice({ tag: 'config_error', httpStatus: outcome.error.httpStatus });
        tx.log({ event: 'config_error', httpStatus: outcome.error.httpStatus });
      }
      break;
    default:
      assertNever(outcome, 'read outcome');
  }
  afterRead(tx);
}

function onDeleteResult(tx: Tx, reqId: number, outcome: DeleteOutcome): void {
  if (tx.session.inflight.del !== reqId) {
    tx.log({ event: 'stale_response', phase: tx.op.phase.tag, cause: 'aborted' });
    return;
  }
  tx.setInflight({ del: null });
  const phase = tx.op.phase;
  if (outcome.tag === 'accepted' && outcome.view !== null) tx.recordView('delete', outcome.view);
  tx.log({
    event: 'delete_finished',
    phase: phase.tag,
    ...(outcome.tag === 'failed'
      ? {
          cause: apiErrorCause(outcome.error),
          ...(outcome.error.kind === 'transport' ? {} : { httpStatus: outcome.error.httpStatus }),
        }
      : outcome.tag === 'client_error'
        ? { cause: 'client_error' as const, httpStatus: outcome.httpStatus }
        : outcome.tag === 'not_found'
          ? { cause: 'not_found' as const, httpStatus: 404 }
          : { cause: 'ok' as const, httpStatus: 202 }),
  });
  if (phase.tag !== 'delete_requested') {
    // A view already moved us on (deleting / deleted / lost): the DELETE response changes nothing.
    afterRead(tx);
    return;
  }
  switch (outcome.tag) {
    case 'accepted':
      // any 202 body (even deleted/5) only means "deleting"; revision is untouched.
      tx.setPhase({ tag: 'deleting', jobId: phase.jobId });
      break;
    case 'not_found':
      tx.finish({ tag: 'lost', jobId: phase.jobId });
      return;
    case 'client_error':
      tx.log({ event: 'client_bug', httpStatus: outcome.httpStatus, cause: 'client_error' });
      tx.notice({ tag: 'client_error', httpStatus: outcome.httpStatus });
      tx.setPhase({ tag: 'delete_failed', jobId: phase.jobId, cause: 'client_error' });
      break;
    case 'failed':
      if (outcome.error.kind === 'config') {
        tx.notice({ tag: 'config_error', httpStatus: outcome.error.httpStatus });
        tx.log({ event: 'config_error', httpStatus: outcome.error.httpStatus });
      }
      tx.setPhase({
        tag: 'delete_failed',
        jobId: phase.jobId,
        cause: deleteFailureCause(outcome.error),
      });
      break;
    default:
      assertNever(outcome, 'delete outcome');
  }
  afterRead(tx);
}

function onRequestDelete(tx: Tx, newDeleteKey: DeleteKey | null): void {
  const phase = tx.op.phase;
  if (phase.tag !== 'server' && phase.tag !== 'delete_failed') return;
  if (tx.session.inflight.del !== null) return;
  // The persisted key is always reused; a new one only if the op never had one.
  const deleteKey = tx.op.deleteKey ?? newDeleteKey;
  if (deleteKey === null) return;
  tx.op = { ...tx.op, deleteKey, phase: { tag: 'delete_requested', jobId: phase.jobId } };
  tx.setSession({ readError: null });
  if (tx.session.notice?.tag === 'client_error') tx.notice(null);
  tx.stopPolling();
  tx.startLookup('delete'); // verify identity right before DELETE
}

function onRefresh(tx: Tx): void {
  const phase = tx.op.phase;
  if (phase.tag === 'server' || phase.tag === 'deleting' || phase.tag === 'delete_failed') {
    tx.startLookup('refresh');
  }
}

function onCheckAgain(tx: Tx): void {
  const phase = tx.op.phase;
  if (phase.tag !== 'outcome_unknown' || isLookupBusy(phase.lookup)) return;
  tx.setPhase({ ...phase, lookup: 'pending' });
  tx.startLookup('recover');
}

function onAbandon(tx: Tx): void {
  const phase = tx.op.phase;
  if (phase.tag !== 'outcome_unknown' || phase.lookup === 'settling') return;
  if (phase.lookup === 'skipped') {
    tx.finish({ tag: 'cancelled' }); // first attempt never left the device
    return;
  }
  tx.setPhase({ ...phase, abandon: true, lookup: 'pending' });
  tx.startLookup('recover'); // final lookup first: never leave a server job without a delete path
}

function resume(tx: Tx): void {
  const phase = tx.op.phase;
  switch (phase.tag) {
    case 'server':
    case 'deleting':
    case 'delete_failed':
      tx.startLookup('resume');
      return;
    case 'delete_requested':
      if (tx.session.inflight.del === null) tx.startLookup('delete');
      return;
    case 'outcome_unknown':
      if (
        phase.lookup === 'unreachable' ||
        phase.lookup === 'pending' ||
        phase.lookup === 'settling'
      ) {
        if (phase.lookup !== 'pending') tx.setPhase({ ...phase, lookup: 'pending' });
        tx.startLookup('recover');
      }
      return;
    case 'pending_send':
    case 'sending':
    case 'rejected_by_server':
    case 'deleted':
    case 'lost':
    case 'cancelled':
      return;
    default:
      assertNever(phase, 'phase');
  }
}

function onColdStart(tx: Tx): void {
  const phase = tx.op.phase;
  if (isTerminal(phase)) {
    // A crash between "terminal persisted" and "copy deleted" is finished here.
    if (tx.op.file.tempPath !== null || tx.op.result !== null || tx.op.file.name !== '')
      tx.finish(phase);
    return;
  }
  switch (phase.tag) {
    case 'pending_send':
    case 'sending':
      tx.log({ event: 'cold_start_recovery', phase: phase.tag, cause: 'interrupted' });
      tx.setPhase({
        tag: 'outcome_unknown',
        cause: 'interrupted',
        lookup: 'pending',
        attempt: phase.tag === 'sending' ? phase.attempt : 0,
        abandon: false,
      });
      tx.startLookup('recover');
      return;
    case 'outcome_unknown':
      tx.log({ event: 'cold_start_recovery', phase: phase.tag });
      if (phase.lookup !== 'pending') tx.setPhase({ ...phase, lookup: 'pending' });
      tx.startLookup('recover');
      return;
    case 'server':
    case 'delete_requested':
    case 'delete_failed':
    case 'deleting':
      tx.log({ event: 'cold_start_recovery', phase: phase.tag });
      resume(tx);
      return;
    default:
      assertNever(phase, 'phase');
  }
}

// ---------------------------------------------------------------------------------------------
// Reducer

export function reduce(state: MachineState, event: MachineEvent): Transition {
  const tx = new Tx(state);
  switch (event.type) {
    case 'send':
      onSend(tx);
      break;
    case 'cancel_sending':
      onCancelSending(tx);
      break;
    case 'check_again':
      onCheckAgain(tx);
      break;
    case 'abandon':
      onAbandon(tx);
      break;
    case 'refresh':
      onRefresh(tx);
      break;
    case 'request_delete':
      onRequestDelete(tx, event.newDeleteKey);
      break;
    case 'retry_delete':
      onRequestDelete(tx, event.newDeleteKey ?? null);
      break;
    case 'poll_tick': {
      const phase = tx.op.phase;
      if (tx.session.paused || tx.session.inflight.read !== null) break;
      if (needsPolling(tx.op)) {
        tx.startLookup('poll');
      } else if (phase.tag === 'outcome_unknown' && phase.lookup === 'settling') {
        tx.setPhase({ ...phase, lookup: 'pending' });
        tx.startLookup('recover');
      }
      break;
    }
    case 'background':
      tx.setSession({ paused: true });
      tx.stopPolling();
      break;
    case 'foreground': {
      tx.setSession({ paused: false });
      const phase = tx.op.phase;
      if (
        phase.tag === 'outcome_unknown' &&
        phase.lookup === 'not_found' &&
        mayAutoResend(tx, phase)
      ) {
        // A by-key 404 arrived while paused, which held back the one automatic re-POST. Re-check
        // the key first (the earlier attempt may have landed meanwhile); a 404 then re-POSTs.
        tx.setPhase({ ...phase, lookup: 'pending' });
        tx.startLookup('recover');
      } else {
        resume(tx);
      }
      if (tx.session.inflight.read === null) tx.schedulePollIfNeeded();
      break;
    }
    case 'cold_start':
      onColdStart(tx);
      break;
    case 'post_result':
      onPostResult(tx, event.reqId, event.outcome);
      break;
    case 'lookup_result':
      onLookupResult(tx, event.reqId, event.outcome);
      break;
    case 'get_result':
      onGetResult(tx, event.reqId, event.outcome);
      break;
    case 'delete_result':
      onDeleteResult(tx, event.reqId, event.outcome);
      break;
    default:
      assertNever(event, 'event');
  }
  return tx.build();
}

/** A brand-new op as persisted right before the first send: phase `pending_send`. */
export function newOperation(args: {
  readonly opId: OpId;
  readonly key: IdempotencyKey;
  readonly createdAt: number;
  readonly format: FileFormat;
  readonly size: number;
  readonly name: string;
  readonly tempPath: string;
}): Operation {
  return {
    schemaVersion: 1,
    opId: args.opId,
    createdAt: args.createdAt,
    key: args.key,
    deleteKey: null,
    file: { format: args.format, size: args.size, name: args.name, tempPath: args.tempPath },
    revision: 0,
    result: null,
    recoveredByKey: false,
    phase: { tag: 'pending_send' },
  };
}
