// ImportController: the imperative shell around the pure reducer.
// - Serialises every state change through one queue (events, commands, results).
// - Awaits `persist` before running any other effect of a transition; a failed persist
//   drops the transition (nothing reaches the network) and surfaces a storage error.
// - Single-flight is decided by the reducer (session.inflight); the runner just executes.
// - Exposes immutable snapshots for React's useSyncExternalStore.

import {
  createImport,
  deleteJob,
  fetchMockState,
  getJob,
  lookupByKey,
  resetMock,
  setMockScenario,
  type ApiConfig,
  type ApiError,
  type MockState,
  type PostOutcome,
} from './api';
import { decodeOperation, encodeOperation, journalForm } from './codec';
import {
  asDeleteKey,
  asIdempotencyKey,
  asOpId,
  isTerminal,
  type DeleteFailureCause,
  type Draft,
  type FileFormat,
  type JobId,
  type LocalRejection,
  type LookupState,
  type MockMode,
  type Operation,
  type OpId,
  type Phase,
  type ReadyResult,
  type ServerStatus,
  type UnknownOutcomeCause,
} from './domain';
import { sanitizeLogEntry, type LogEntry } from './log';
import {
  initialSession,
  isLookupBusy,
  newOperation,
  reduce,
  type Effect,
  type IgnoredView,
  type MachineEvent,
  type Notice,
  type RawView,
  type ReadError,
  type Session,
  type Transition,
} from './machine';
import type { CorePorts, PickedFile, TimerHandle, UploadProgress } from './ports';
import { err, ok, type Result } from './result';
import {
  detectFormat,
  HEADER_BYTES,
  isWithinSizeLimit,
  knownDeclaredSize,
  MAX_FILE_BYTES,
} from './validate';

// ---------------------------------------------------------------------------------------------
// Public types

export interface ControllerConfig {
  /** Mock base URL, e.g. `http://127.0.0.1:8787`. */
  readonly baseUrl: string;
  /** GET / DELETE timeout; default 10 s. */
  readonly requestTimeoutMs?: number;
  /** Upload timeout; default 60 s. */
  readonly uploadTimeoutMs?: number;
  /** Abandon re-check delays after a by-key 404 (default `SETTLE_RECHECK_DELAYS_MS`). */
  readonly settleDelaysMs?: readonly number[];
}

export type ControllerDeps = CorePorts & ControllerConfig;

/** What the confirm screen shows. */
export interface DraftView {
  readonly draftId: OpId;
  readonly name: string;
  readonly size: number;
  readonly format: FileFormat;
}

export type PrepareError =
  | LocalRejection
  /** An import is in progress, a file is being prepared, or the controller has not started. */
  | { readonly reason: 'busy' };

export interface OperationView {
  readonly opId: OpId;
  readonly revision: number;
  readonly recoveredByKey: boolean;
  readonly file: {
    readonly name: string;
    readonly size: number;
    readonly format: FileFormat;
    /** The private copy still exists (needed for "Send again"). */
    readonly available: boolean;
  };
  /**
   * Present only while ready (and kept through delete phases until terminal). In memory only: the
   * journal never stores it, so after a cold start it is null until the by-key / GET re-fetch.
   */
  readonly result: ReadyResult | null;
}

/** One variant per UI state of ; switch on `tag` exhaustively. */
export type ImportView =
  /** Journal not loaded yet (cold start in progress). */
  | { readonly tag: 'starting' }
  /**
   * The journal could not be read: an op may exist on disk, so nothing new may start.
   * Only `actions.retryStorage` is offered.
   */
  | { readonly tag: 'storage_unavailable' }
  | { readonly tag: 'empty' }
  /** Copying + validating the picked file. */
  | { readonly tag: 'preparing' }
  | { readonly tag: 'local_rejection'; readonly rejection: LocalRejection }
  | { readonly tag: 'confirm'; readonly draft: DraftView }
  | {
      readonly tag: 'sending';
      readonly op: OperationView;
      readonly attempt: number;
      /** null until the first progress event. */
      readonly progress: UploadProgress | null;
      /** "Cancel" tapped; waiting for the upload to stop and the by-key check. */
      readonly cancelRequested: boolean;
      /**
       * This POST is the one automatic same-key re-POST after a by-key 404 race, not a
       * user tap: the screen says so honestly ("Sending again won't create a duplicate").
       */
      readonly autoRetry: boolean;
      /**
       * The op is still `pending_send`: nothing was sent. Shown only when the `sending` write
       * failed ("Send" is kept for `retryStorage`); otherwise it lasts no longer than a write.
       */
      readonly notStarted: boolean;
    }
  | {
      readonly tag: 'outcome_unknown';
      readonly op: OperationView;
      readonly cause: UnknownOutcomeCause;
      readonly lookup: LookupState;
      readonly attempt: number;
      readonly abandon: boolean;
    }
  /** queued / processing / ready. A 202 is shown as `queued`, never as a report. */
  | {
      readonly tag: 'job';
      readonly op: OperationView;
      readonly jobId: JobId;
      readonly status: ServerStatus;
    }
  | { readonly tag: 'delete_requested'; readonly op: OperationView; readonly jobId: JobId }
  | { readonly tag: 'deleting'; readonly op: OperationView; readonly jobId: JobId }
  | {
      readonly tag: 'delete_failed';
      readonly op: OperationView;
      readonly jobId: JobId;
      readonly cause: DeleteFailureCause;
    }
  /** Only after a GET / by-key view said `deleted`. */
  | { readonly tag: 'deleted'; readonly op: OperationView; readonly jobId: JobId }
  | { readonly tag: 'lost'; readonly op: OperationView; readonly jobId: JobId | null }
  | {
      readonly tag: 'rejected_by_server';
      readonly op: OperationView;
      readonly httpStatus: number;
      readonly error: string;
    }
  | { readonly tag: 'cancelled'; readonly op: OperationView };

export interface AvailableActions {
  readonly pickFile: boolean;
  readonly confirmSend: boolean;
  readonly cancelDraft: boolean;
  readonly cancelSending: boolean;
  readonly checkAgain: boolean;
  readonly resend: boolean;
  readonly abandon: boolean;
  readonly refresh: boolean;
  readonly requestDelete: boolean;
  readonly retryDelete: boolean;
  /** "New import": only when there is no op or it is terminal, or after a local rejection. */
  readonly newImport: boolean;
  /**
   * "Retry": the journal could not be read, or a server result could not be saved. While this
   * is true every other action is false (the core retries on its own with backoff too).
   */
  readonly retryStorage: boolean;
}

export interface DiagnosticsSnapshot {
  readonly baseUrl: string;
  readonly opId: OpId | null;
  readonly jobId: JobId | null;
  readonly revision: number | null;
  /** Local size of the file (draft or op) to compare with the server's `bytes`. */
  readonly localSize: number | null;
  /** Last parsed server view (POST 202, by-key, GET or DELETE 202 body). */
  readonly lastRawView: RawView | null;
  /** Views not applied (stale revision / tombstone / terminal). */
  readonly ignoredViews: { readonly count: number; readonly last: IgnoredView | null };
  /** Non-terminal ops found in the journal besides the active one (should be 0, I9). */
  readonly extraOperations: number;
}

export interface ImportSnapshot {
  /** Increments on every change. */
  readonly version: number;
  readonly view: ImportView;
  readonly actions: AvailableActions;
  /** Requests in flight (spinners). */
  readonly activity: {
    readonly posting: boolean;
    readonly deleting: boolean;
    readonly reading: boolean;
  };
  /** Last read failed: show the status as "Last known status". */
  readonly readError: ReadError | null;
  readonly notice: Notice | null;
  /**
   * The journal could not be written / read; the last action did not happen. Sticky until a
   * write (or the journal load) succeeds.
   */
  readonly storageError: boolean;
  readonly diagnostics: DiagnosticsSnapshot;
}

export interface ImportDiagnostics {
  /** GET /__test/state (mode, counters, jobs with server `bytes`). */
  fetchServerState(): Promise<Result<MockState, ApiError>>;
  setScenario(mode: MockMode): Promise<Result<{ readonly mode: MockMode }, ApiError>>;
  /**
   * Aborts an in-flight upload, POST /__test/reset, then — only if the reset succeeded — drops
   * every local op, draft and private copy. On failure local state is kept (delete path intact).
   */
  resetMockAndLocal(): Promise<Result<void, ApiError>>;
}

export interface ImportController {
  getSnapshot(): ImportSnapshot;
  subscribe(listener: () => void): () => void;
  /** Cold start: load the journal, sweep orphan copies, recover the active op. Idempotent. */
  start(): Promise<void>;
  onForeground(): Promise<void>;
  onBackground(): Promise<void>;
  /** Copy + validate a picked file (before any network). */
  prepareFile(picked: PickedFile): Promise<Result<DraftView, PrepareError>>;
  /** Persist key + op, then POST. */
  confirmSend(draftId: OpId): Promise<void>;
  cancelDraft(): Promise<void>;
  cancelSending(): Promise<void>;
  checkAgain(): Promise<void>;
  resend(): Promise<void>;
  abandon(): Promise<void>;
  refresh(): Promise<void>;
  requestDelete(): Promise<void>;
  retryDelete(): Promise<void>;
  /** Leave a terminal op / local rejection and return to the empty state. */
  newImport(): Promise<void>;
  /** Alias of `newImport` for "Close". */
  dismiss(): Promise<void>;
  /** Re-reads the journal (storage_unavailable) or re-applies a server result that was not saved. */
  retryStorage(): Promise<void>;
  /** Stops timers and in-flight work (tests / simulated process death). */
  dispose(): void;
  readonly diagnostics: ImportDiagnostics;
}

// ---------------------------------------------------------------------------------------------
// Implementation

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;
/** Automatic re-applies of a server result whose persist failed; then only `retryStorage`. */
const STORAGE_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];
/** How long a mock reset waits for an aborted upload to settle. */
const RESET_ABORT_WAIT_MS = 5000;

/** Results / recovery events: dropping them would wedge a lane, so they are re-applied. */
function isReplayable(event: MachineEvent): boolean {
  return (
    event.type === 'post_result' ||
    event.type === 'lookup_result' ||
    event.type === 'get_result' ||
    event.type === 'delete_result' ||
    event.type === 'cold_start'
  );
}

/**
 * "Send" on a `pending_send` op whose `sending` write failed. Without this the op would sit
 * in `pending_send` with nothing in flight and no action until a relaunch. It is kept for the
 * manual "Retry" (`retryStorage`), which re-runs the send transition: persist `sending` first,
 * then POST. Never re-applied on a timer: every POST but the bounded race re-POST needs a tap
 *, and the tap here is "Retry".
 */
function isRetryableSend(event: MachineEvent, op: Operation | null): boolean {
  return event.type === 'send' && op?.phase.tag === 'pending_send';
}

type CommitResult = 'persisted' | 'no_persist' | 'failed' | 'skipped';

interface CoreState {
  readonly started: boolean;
  readonly op: Operation | null;
  readonly session: Session;
  readonly draft: Draft | null;
  readonly preparing: boolean;
  readonly rejection: LocalRejection | null;
  readonly progress: UploadProgress | null;
  readonly storageError: boolean;
  /** The journal could not be loaded at start: blocks every new import. */
  readonly loadFailed: boolean;
  /**
   * A replayable event (or a first "Send", `isRetryableSend`) whose transition could not be
   * persisted; re-applied by `retryStorage` (and, for replayable results, by the backoff timer).
   */
  readonly dropped: MachineEvent | null;
  readonly extraOperations: number;
}

function operationView(op: Operation): OperationView {
  return {
    opId: op.opId,
    revision: op.revision,
    recoveredByKey: op.recoveredByKey,
    file: {
      name: op.file.name,
      size: op.file.size,
      format: op.file.format,
      available: op.file.tempPath !== null,
    },
    result: op.result,
  };
}

function draftView(draft: Draft): DraftView {
  return { draftId: draft.draftId, name: draft.name, size: draft.size, format: draft.format };
}

function phaseView(op: Operation, state: CoreState): ImportView {
  const opv = operationView(op);
  const phase: Phase = op.phase;
  switch (phase.tag) {
    case 'pending_send':
      return {
        tag: 'sending',
        op: opv,
        attempt: 1,
        progress: null,
        cancelRequested: false,
        autoRetry: false,
        notStarted: true,
      };
    case 'sending':
      return {
        tag: 'sending',
        op: opv,
        attempt: phase.attempt,
        progress: state.progress,
        cancelRequested: state.session.cancelRequested,
        autoRetry:
          state.session.autoPostReqId !== null &&
          state.session.inflight.post === state.session.autoPostReqId,
        notStarted: false,
      };
    case 'outcome_unknown':
      return {
        tag: 'outcome_unknown',
        op: opv,
        cause: phase.cause,
        lookup: phase.lookup,
        attempt: phase.attempt,
        abandon: phase.abandon,
      };
    case 'server':
      return { tag: 'job', op: opv, jobId: phase.jobId, status: phase.status };
    case 'delete_requested':
      return { tag: 'delete_requested', op: opv, jobId: phase.jobId };
    case 'deleting':
      return { tag: 'deleting', op: opv, jobId: phase.jobId };
    case 'delete_failed':
      return { tag: 'delete_failed', op: opv, jobId: phase.jobId, cause: phase.cause };
    case 'deleted':
      return { tag: 'deleted', op: opv, jobId: phase.jobId };
    case 'lost':
      return { tag: 'lost', op: opv, jobId: phase.jobId };
    case 'rejected_by_server':
      return {
        tag: 'rejected_by_server',
        op: opv,
        httpStatus: phase.httpStatus,
        error: phase.error,
      };
    case 'cancelled':
      return { tag: 'cancelled', op: opv };
    default: {
      const never: never = phase;
      return never;
    }
  }
}

function deriveView(state: CoreState): ImportView {
  if (state.loadFailed) return { tag: 'storage_unavailable' };
  if (!state.started) return { tag: 'starting' };
  const op = state.op;
  if (op !== null && !isTerminal(op.phase)) return phaseView(op, state);
  if (state.preparing) return { tag: 'preparing' };
  if (state.draft !== null) return { tag: 'confirm', draft: draftView(state.draft) };
  if (state.rejection !== null) return { tag: 'local_rejection', rejection: state.rejection };
  if (op !== null) return phaseView(op, state);
  return { tag: 'empty' };
}

const NO_ACTIONS: AvailableActions = {
  pickFile: false,
  confirmSend: false,
  cancelDraft: false,
  cancelSending: false,
  checkAgain: false,
  resend: false,
  abandon: false,
  refresh: false,
  requestDelete: false,
  retryDelete: false,
  newImport: false,
  retryStorage: false,
};

function deriveActions(state: CoreState): AvailableActions {
  if (state.loadFailed || state.dropped !== null) return { ...NO_ACTIONS, retryStorage: true };
  const op = state.op;
  const phase = op?.phase ?? null;
  const inflight = state.session.inflight;
  const idle = op === null || isTerminal(op.phase);
  const unknown = phase?.tag === 'outcome_unknown' ? phase : null;
  const lookupBusy = unknown !== null && isLookupBusy(unknown.lookup);
  const canLookupAgain = unknown !== null && !lookupBusy && inflight.read === null;
  return {
    pickFile: state.started && idle && !state.preparing && state.draft === null,
    confirmSend: state.started && idle && state.draft !== null,
    cancelDraft: state.draft !== null,
    cancelSending:
      phase?.tag === 'sending' && inflight.post !== null && !state.session.cancelRequested,
    checkAgain: canLookupAgain,
    resend: unknown !== null && !lookupBusy && inflight.post === null && op?.file.tempPath !== null,
    abandon: unknown !== null && !lookupBusy,
    refresh:
      (phase?.tag === 'server' || phase?.tag === 'deleting' || phase?.tag === 'delete_failed') &&
      inflight.read === null,
    requestDelete: phase?.tag === 'server' && inflight.del === null,
    retryDelete: phase?.tag === 'delete_failed' && inflight.del === null,
    newImport:
      state.started &&
      idle &&
      state.draft === null &&
      !state.preparing &&
      (op !== null || state.rejection !== null),
    retryStorage: false,
  };
}

export function createImportController(deps: ControllerDeps): ImportController {
  const api: ApiConfig = {
    baseUrl: deps.baseUrl,
    http: deps.http,
    upload: deps.upload,
    requestTimeoutMs: deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    uploadTimeoutMs: deps.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
  };
  const { files, store, clock, ids } = deps;
  const freshSession = (): Session =>
    deps.settleDelaysMs === undefined ? initialSession() : initialSession(deps.settleDelaysMs);

  let state: CoreState = {
    started: false,
    op: null,
    session: freshSession(),
    draft: null,
    preparing: false,
    rejection: null,
    progress: null,
    storageError: false,
    loadFailed: false,
    dropped: null,
    extraOperations: 0,
  };
  /** Bumped whenever the active op/session is replaced: results of older requests are dropped. */
  let generation = 0;
  let disposed = false;
  let pollTimer: TimerHandle | null = null;
  let postAbort: { readonly reqId: number; readonly controller: AbortController } | null = null;
  /** The running upload (awaited by a mock reset after aborting it). */
  let postRunning: Promise<void> | null = null;
  let storageRetryTimer: TimerHandle | null = null;
  /**
   * Rows from an older build (file name / ready result inside) whose minimised rewrite at start
   * failed (logged as `journal_rewrite_failed`). Retried on every foreground; a successful persist
   * of the same op writes the minimised form anyway and clears it.
   */
  const pendingRewrites = new Map<OpId, Operation>();
  let storageRetries = 0;
  /** Identifies the latest prepareFile call (an older one must not touch `preparing`). */
  let prepareToken = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  let version = 0;
  let snapshot: ImportSnapshot = buildSnapshot();

  // -- snapshot -------------------------------------------------------------------------------

  function buildSnapshot(): ImportSnapshot {
    const op = state.op;
    const jobId = op === null ? null : 'jobId' in op.phase ? op.phase.jobId : null;
    return Object.freeze({
      version,
      view: Object.freeze(deriveView(state)),
      actions: Object.freeze(deriveActions(state)),
      // A result that could not be saved is not "in flight" any more.
      activity: Object.freeze({
        posting: state.session.inflight.post !== null && state.dropped?.type !== 'post_result',
        deleting: state.session.inflight.del !== null && state.dropped?.type !== 'delete_result',
        reading:
          state.session.inflight.read !== null &&
          state.dropped?.type !== 'lookup_result' &&
          state.dropped?.type !== 'get_result',
      }),
      readError: state.session.readError,
      notice: state.session.notice,
      storageError: state.storageError || state.loadFailed || state.dropped !== null,
      diagnostics: Object.freeze({
        baseUrl: deps.baseUrl,
        opId: op?.opId ?? null,
        jobId,
        revision: op?.revision ?? null,
        localSize: op?.file.size ?? state.draft?.size ?? null,
        lastRawView: state.session.lastRawView,
        ignoredViews: state.session.ignored,
        extraOperations: state.extraOperations,
      }),
    });
  }

  function emit(): void {
    version += 1;
    snapshot = buildSnapshot();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not break the controller.
      }
    }
  }

  function set(patch: Partial<CoreState>): void {
    state = { ...state, ...patch };
  }

  // -- infrastructure -------------------------------------------------------------------------

  function log(entry: LogEntry): void {
    const clean = sanitizeLogEntry(entry);
    if (clean === null) return;
    try {
      deps.logger.log(clean);
    } catch {
      // ignore
    }
  }

  /** Runs `job` after every previously queued job (one state change at a time). */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  }

  async function guarded<T>(promise: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await promise();
    } catch {
      return fallback;
    }
  }

  async function persistOp(op: Operation): Promise<boolean> {
    const result = await guarded(() => store.upsert({ opId: op.opId, body: encodeOperation(op) }), {
      ok: false as const,
      error: { kind: 'io' as const },
    });
    if (!result.ok) {
      log({ event: 'persist_failed', opId: op.opId, phase: op.phase.tag, cause: 'storage' });
      return false;
    }
    return true;
  }

  async function removeOp(opId: OpId): Promise<void> {
    pendingRewrites.delete(opId);
    await guarded(() => store.remove(opId), ok(undefined));
  }

  /** Best-effort retry of the minimised rewrites that failed at start (see `pendingRewrites`). */
  async function flushRewrites(): Promise<void> {
    for (const [opId, op] of [...pendingRewrites]) {
      // The active op may have moved on in memory without a journal change: write its current
      // stored form (same as `op`'s when nothing was persisted since).
      const current = state.op?.opId === opId ? state.op : op;
      const result = await guarded(
        () => store.upsert({ opId, body: encodeOperation(current) }),
        err({ kind: 'io' as const }),
      );
      if (disposed) return;
      if (result.ok) pendingRewrites.delete(opId);
    }
  }

  async function deleteFile(path: string, opId?: OpId): Promise<void> {
    const result = await guarded(() => files.delete(path), err({ kind: 'io' as const }));
    if (!result.ok) log({ event: 'temp_delete_failed', ...(opId ? { opId } : {}) });
  }

  function clearPollTimer(): void {
    if (pollTimer !== null) {
      clock.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function abortInFlightPost(): void {
    postAbort?.controller.abort();
    postAbort = null;
  }

  function clearStorageRetry(): void {
    if (storageRetryTimer !== null) {
      clock.clearTimeout(storageRetryTimer);
      storageRetryTimer = null;
    }
  }

  /** Re-applies a dropped result later (backoff), unless the op/session was replaced meanwhile. */
  function scheduleStorageRetry(gen: number): void {
    clearStorageRetry();
    const delayMs = STORAGE_RETRY_DELAYS_MS[storageRetries];
    if (delayMs === undefined) return; // manual "Retry" only
    storageRetries += 1;
    storageRetryTimer = clock.setTimeout(() => {
      storageRetryTimer = null;
      if (disposed || gen !== generation) return;
      void enqueue(replayDropped);
    }, delayMs);
  }

  /** Must run inside the queue. */
  async function replayDropped(): Promise<void> {
    const event = state.dropped;
    if (event === null || disposed) return;
    set({ dropped: null });
    const result = await step(event);
    if (result !== 'failed') {
      storageRetries = 0;
      clearStorageRetry();
      if (state.storageError) {
        set({ storageError: false });
        emit();
      }
    }
  }

  // -- effect runner --------------------------------------------------------------------------

  /**
   * Applies a reducer transition: persist first (awaited), then the remaining effects.
   * A failed persist drops the whole transition (I6: nothing reaches the network) and keeps the
   * old op and session; a replayable `event` (a server result) is re-applied later so its lane is
   * not left occupied by a request whose answer was lost.
   */
  async function commit(transition: Transition, event: MachineEvent): Promise<CommitResult> {
    const gen = generation;
    const [first, ...rest] = transition.effects;
    let effects: readonly Effect[] = transition.effects;
    let persisted = false;
    if (first?.type === 'persist') {
      const saved = await persistOp(first.op);
      if (saved) pendingRewrites.delete(first.op.opId);
      // Disposed (process death) or replaced while writing: this transition must not run.
      if (disposed || gen !== generation) return 'skipped';
      if (!saved) {
        const replayable = isReplayable(event);
        const keep = replayable || isRetryableSend(event, state.op);
        set({
          storageError: true,
          ...(keep ? { dropped: event } : {}),
        });
        if (replayable) scheduleStorageRetry(gen);
        emit();
        return 'failed';
      }
      effects = rest;
      persisted = true;
    }
    set({
      op: transition.op,
      session: transition.session,
      ...(persisted ? { storageError: false } : {}),
    });
    const cleanups: Promise<void>[] = [];
    for (const effect of effects) {
      const pending = runEffect(effect, gen);
      if (pending) cleanups.push(pending);
    }
    // Copy deletions are awaited so a terminal state is shown only once its copy is gone.
    await Promise.all(cleanups);
    emit();
    return persisted ? 'persisted' : 'no_persist';
  }

  /** Processes one reducer event; must run inside the queue. */
  async function step(event: MachineEvent): Promise<CommitResult> {
    const op = state.op;
    if (op === null || disposed) return 'skipped';
    return commit(reduce({ op, session: state.session }, event), event);
  }

  function dispatch(event: MachineEvent): Promise<void> {
    return enqueue(async () => {
      await step(event);
    });
  }

  /** Feeds a network result back, unless the op/session it belongs to was replaced. */
  function deliver(gen: number, event: MachineEvent): void {
    if (disposed || gen !== generation) return;
    void dispatch(event);
  }

  /** Starts one effect; returns a promise only for local file cleanup (awaited by commit). */
  function runEffect(effect: Effect, gen: number): Promise<void> | undefined {
    switch (effect.type) {
      case 'persist':
        // Only the first effect may be a persist (handled by commit).
        log({ event: 'invariant_violation', opId: effect.op.opId });
        return;
      case 'log':
        log(effect.entry);
        return;
      case 'deleteTempFile':
        return deleteFile(effect.path, state.op?.opId);
      case 'schedulePoll':
        clearPollTimer();
        pollTimer = clock.setTimeout(() => {
          pollTimer = null;
          deliver(gen, { type: 'poll_tick' });
        }, effect.delayMs);
        return;
      case 'cancelPoll':
        clearPollTimer();
        return;
      case 'abortPost':
        if (postAbort?.reqId === effect.reqId) postAbort.controller.abort();
        return;
      case 'post': {
        const running = runPost(effect, gen);
        postRunning = running;
        void running.finally(() => {
          if (postRunning === running) postRunning = null;
        });
        return;
      }
      case 'lookupByKey': {
        const startedAt = clock.now();
        void guarded(() => lookupByKey(api, effect.key), transportFailure()).then((outcome) => {
          logDuration('lookup_finished', startedAt);
          deliver(gen, { type: 'lookup_result', reqId: effect.reqId, outcome });
        });
        return;
      }
      case 'getJob': {
        const startedAt = clock.now();
        void guarded(() => getJob(api, effect.jobId), transportFailure()).then((outcome) => {
          logDuration('get_finished', startedAt);
          deliver(gen, { type: 'get_result', reqId: effect.reqId, outcome });
        });
        return;
      }
      case 'del': {
        const startedAt = clock.now();
        void guarded(() => deleteJob(api, effect.jobId, effect.deleteKey), transportFailure()).then(
          (outcome) => {
            logDuration('delete_finished', startedAt);
            deliver(gen, { type: 'delete_result', reqId: effect.reqId, outcome });
          },
        );
        return;
      }
      default: {
        const never: never = effect;
        return never;
      }
    }
  }

  function transportFailure(): { tag: 'failed'; error: ApiError } {
    // A port that throws broke its contract; we cannot know what reached the server.
    return { tag: 'failed', error: { kind: 'transport', cause: 'reset_after_send' } };
  }

  function logDuration(
    event: 'lookup_finished' | 'get_finished' | 'delete_finished' | 'post_finished',
    startedAt: number,
  ): void {
    const opId = state.op?.opId;
    log({
      event,
      durationMs: Math.max(0, Math.round(clock.now() - startedAt)),
      ...(opId ? { opId } : {}),
    });
  }

  async function runPost(effect: Extract<Effect, { type: 'post' }>, gen: number): Promise<void> {
    const controller = new AbortController();
    postAbort = { reqId: effect.reqId, controller };
    const totalBytes = state.op?.file.size ?? 0;
    set({ progress: { bytesSent: 0, totalBytes } });
    let lastPercent = -1;
    const startedAt = clock.now();
    let outcome: PostOutcome;
    try {
      if (!(await files.exists(effect.filePath))) {
        outcome = { tag: 'file_missing' };
      } else {
        outcome = await createImport(api, {
          key: effect.key,
          filePath: effect.filePath,
          fileName: effect.fileName,
          format: effect.format,
          signal: controller.signal,
          onProgress: (progress) => {
            if (postAbort?.reqId !== effect.reqId || gen !== generation) return;
            const percent =
              progress.totalBytes > 0
                ? Math.floor((progress.bytesSent / progress.totalBytes) * 100)
                : 0;
            if (percent === lastPercent) return;
            lastPercent = percent;
            set({ progress });
            emit();
          },
        });
      }
    } catch {
      outcome = transportFailure();
    }
    logDuration('post_finished', startedAt);
    if (postAbort?.reqId === effect.reqId) postAbort = null;
    if (gen === generation) set({ progress: null });
    deliver(gen, { type: 'post_result', reqId: effect.reqId, outcome });
  }

  // -- lifecycle ------------------------------------------------------------------------------

  /**
   * The copy location is derived from the opId at load time: a persisted absolute path goes stale
   * when the app container moves (iOS app update / restore), and the sweep would delete a live
   * copy that `listPrivate` reports under the new container path.
   */
  function rebaseCopy(op: Operation): Operation {
    if (op.file.tempPath === null) return op;
    const current = files.pathFor(op.opId);
    return current === op.file.tempPath ? op : { ...op, file: { ...op.file, tempPath: current } };
  }

  async function sweep(referenced: ReadonlySet<string>): Promise<void> {
    const listed = await guarded(() => files.listPrivate(), err({ kind: 'io' as const }));
    if (listed.ok) {
      for (const path of listed.value) {
        if (!referenced.has(path)) await deleteFile(path);
      }
    }
    await guarded(() => files.sweepPlatformCaches(), undefined);
    log({ event: 'sweep_done' });
  }

  async function startJob(): Promise<void> {
    if (state.started || disposed) return;
    log({ event: 'controller_started' });
    const loaded = await guarded(() => store.loadAll(), err({ kind: 'io' as const }));
    if (disposed) return;
    if (!loaded.ok) {
      // A live op may be on disk: never offer a new import over it. Retry via retryStorage.
      log({ event: 'store_load_failed', cause: 'storage' });
      set({ loadFailed: true, storageError: true });
      emit();
      return;
    }
    if (state.loadFailed) set({ loadFailed: false, storageError: false });
    const ops: Operation[] = [];
    for (const row of loaded.value) {
      const decoded = decodeOperation(row.body);
      if (!decoded.ok) {
        log({ event: 'store_row_invalid' });
        continue;
      }
      // A row written by an older build may still hold the file name / ready result: rewrite it
      // minimised now (best effort; any later persist writes the minimised form anyway).
      if (journalForm(decoded.value) !== decoded.value && !(await persistOp(decoded.value))) {
        pendingRewrites.set(decoded.value.opId, decoded.value);
        log({ event: 'journal_rewrite_failed', opId: decoded.value.opId, cause: 'storage' });
      }
      ops.push(rebaseCopy(decoded.value));
    }
    ops.sort((a, b) => b.createdAt - a.createdAt);
    const [active, ...older] = ops;
    let extra = 0;
    const referenced = new Set<string>();
    for (const op of ops) {
      if (!isTerminal(op.phase) && op.file.tempPath !== null) referenced.add(op.file.tempPath);
    }
    for (const op of older) {
      if (isTerminal(op.phase)) {
        await removeOp(op.opId);
      } else {
        extra += 1; // I9 violation: keep it in the journal (it may own a server job)
        log({ event: 'invariant_violation', opId: op.opId, phase: op.phase.tag });
      }
    }
    await sweep(referenced);
    generation += 1;
    set({ started: true, op: active ?? null, session: freshSession(), extraOperations: extra });
    if (active !== undefined) {
      await step({ type: 'cold_start' });
    }
    emit();
  }

  // -- commands -------------------------------------------------------------------------------

  async function prepareFile(picked: PickedFile): Promise<Result<DraftView, PrepareError>> {
    const op = state.op;
    if (
      !state.started ||
      state.loadFailed ||
      state.dropped !== null ||
      disposed ||
      state.preparing ||
      (op !== null && !isTerminal(op.phase))
    ) {
      return err({ reason: 'busy' });
    }
    const gen = generation;
    prepareToken += 1;
    const token = prepareToken;
    const previousDraft = state.draft;
    set({ preparing: true, rejection: null, draft: null });
    emit();
    if (previousDraft !== null) await deleteFile(previousDraft.tempPath);

    const draftId = asOpId(ids.uuid());
    const dest = files.pathFor(draftId);

    const finish = async (
      outcome: Result<Draft, LocalRejection>,
      removeDest: boolean,
    ): Promise<Result<DraftView, PrepareError>> => {
      if (removeDest) await deleteFile(dest);
      // Drop a picker temp copy the app owns (iOS Inbox) on every outcome; a no-op after a
      // move and on Android.
      await guarded(() => files.releasePicked(picked), undefined);
      if (gen !== generation || disposed || token !== prepareToken) {
        if (outcome.ok) await deleteFile(dest);
        // Superseded (mock reset / dispose): never leave the UI stuck in "preparing".
        if (!disposed && token === prepareToken && state.preparing) {
          set({ preparing: false });
          emit();
        }
        return err({ reason: 'busy' });
      }
      if (outcome.ok) {
        set({ preparing: false, draft: outcome.value });
        emit();
        return ok(draftView(outcome.value));
      }
      log({
        event: 'local_rejection',
        cause: outcome.error.reason,
      });
      set({ preparing: false, rejection: outcome.error });
      emit();
      return err(outcome.error);
    };

    const known = knownDeclaredSize(picked.declaredSize);
    if (known !== null && known > MAX_FILE_BYTES) {
      // Known oversize: reject before copying anything (finish drops the iOS Inbox copy).
      return finish(err({ reason: 'oversize', size: known }), false);
    }
    const copied = await guarded(
      () => files.copyIn(picked, dest, MAX_FILE_BYTES),
      err({ kind: 'unreadable' as const }),
    );
    if (!copied.ok) {
      return finish(
        err(
          copied.error.kind === 'too_large'
            ? { reason: 'oversize', size: null }
            : { reason: 'unreadable' },
        ),
        true,
      );
    }
    // Picker metadata can lie: the private copy is what we check.
    const size = await guarded(() => files.size(dest), err({ kind: 'io' as const }));
    if (!size.ok) return finish(err({ reason: 'unreadable' }), true);
    if (!isWithinSizeLimit(size.value))
      return finish(err({ reason: 'oversize', size: size.value }), true);
    const header = await guarded(
      () => files.readHeader(dest, HEADER_BYTES),
      err({ kind: 'io' as const }),
    );
    if (!header.ok) return finish(err({ reason: 'unreadable' }), true);
    const format = detectFormat(header.value);
    if (format === null) return finish(err({ reason: 'not_statement' }), true);
    return finish(
      ok({ draftId, name: picked.name, size: size.value, format, tempPath: dest }),
      false,
    );
  }

  async function confirmSendJob(draftId: OpId): Promise<void> {
    const draft = state.draft;
    const current = state.op;
    if (disposed || !state.started || draft === null || draft.draftId !== draftId) return;
    if (current !== null && !isTerminal(current.phase)) return; // I9
    const op = newOperation({
      opId: draft.draftId,
      key: asIdempotencyKey(ids.uuid()),
      createdAt: clock.now(),
      format: draft.format,
      size: draft.size,
      name: draft.name,
      tempPath: draft.tempPath,
    });
    // the key is on disk before anything is sent.
    if (!(await persistOp(op))) {
      set({ storageError: true });
      emit();
      return;
    }
    if (current !== null) await removeOp(current.opId);
    log({ event: 'op_created', opId: op.opId, phase: op.phase.tag });
    generation += 1;
    clearPollTimer();
    set({ op, session: freshSession(), draft: null, rejection: null, storageError: false });
    await step({ type: 'send' });
  }

  async function newImportJob(): Promise<void> {
    const op = state.op;
    if (!state.started || state.preparing || (op !== null && !isTerminal(op.phase))) return;
    if (op !== null) await removeOp(op.opId);
    generation += 1;
    clearPollTimer();
    set({ op: null, session: freshSession(), rejection: null });
    emit();
  }

  /** Waits (bounded) for an aborted upload to finish so none of its bytes outlive a reset. */
  async function settleAbortedPost(): Promise<void> {
    const running = postRunning;
    abortInFlightPost();
    if (running === null) return;
    let timer: TimerHandle | null = null;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = clock.setTimeout(resolve, RESET_ABORT_WAIT_MS);
      }),
    ]);
    if (timer !== null) clock.clearTimeout(timer);
  }

  async function resetJob(): Promise<Result<void, ApiError>> {
    // Abort the upload first: its bytes must not land on the freshly reset mock.
    await settleAbortedPost();
    const result = await resetMock(api);
    log({ event: 'mock_reset', cause: result.ok ? 'ok' : apiCause(result.error) });
    if (!result.ok) {
      // The server may still hold our jobs: keep every key / jobId so they keep a delete path.
      emit();
      return result;
    }
    clearPollTimer();
    clearStorageRetry();
    generation += 1;
    const loaded = await guarded(() => store.loadAll(), err({ kind: 'io' as const }));
    if (loaded.ok) for (const row of loaded.value) await removeOp(asOpId(row.opId));
    if (state.op !== null) await removeOp(state.op.opId);
    if (state.draft !== null) await deleteFile(state.draft.tempPath);
    set({
      op: null,
      session: freshSession(),
      draft: null,
      preparing: false,
      rejection: null,
      progress: null,
      storageError: false,
      dropped: null,
      extraOperations: 0,
    });
    await sweep(new Set());
    emit();
    return result;
  }

  function apiCause(
    error: ApiError,
  ): 'config_error' | 'http_5xx' | 'protocol_error' | 'unreachable' {
    switch (error.kind) {
      case 'transport':
        return 'unreachable';
      case 'config':
        return 'config_error';
      case 'server':
        return 'http_5xx';
      case 'protocol':
        return 'protocol_error';
      default: {
        const never: never = error;
        return never;
      }
    }
  }

  const controller: ImportController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => enqueue(startJob),
    onForeground: () =>
      enqueue(async () => {
        if (pendingRewrites.size > 0) await flushRewrites();
        await step({ type: 'foreground' });
      }),
    onBackground: () => {
      clearPollTimer();
      return dispatch({ type: 'background' });
    },
    prepareFile,
    confirmSend: (draftId) => enqueue(() => confirmSendJob(draftId)),
    cancelDraft: () =>
      enqueue(async () => {
        const draft = state.draft;
        if (draft === null) return;
        set({ draft: null });
        emit();
        await deleteFile(draft.tempPath);
      }),
    cancelSending: () => dispatch({ type: 'cancel_sending' }),
    checkAgain: () => dispatch({ type: 'check_again' }),
    resend: () => dispatch({ type: 'send' }),
    abandon: () => dispatch({ type: 'abandon' }),
    refresh: () => dispatch({ type: 'refresh' }),
    requestDelete: () =>
      dispatch({ type: 'request_delete', newDeleteKey: asDeleteKey(ids.uuid()) }),
    retryDelete: () => dispatch({ type: 'retry_delete', newDeleteKey: asDeleteKey(ids.uuid()) }),
    newImport: () => enqueue(newImportJob),
    dismiss: () => enqueue(newImportJob),
    retryStorage: () =>
      enqueue(async () => {
        if (state.loadFailed) {
          await startJob();
          return;
        }
        clearStorageRetry();
        storageRetries = 0;
        await replayDropped();
      }),
    dispose() {
      disposed = true;
      generation += 1;
      clearPollTimer();
      clearStorageRetry();
      abortInFlightPost();
      listeners.clear();
    },
    diagnostics: {
      fetchServerState: () => fetchMockState(api),
      setScenario: (mode) => setMockScenario(api, mode),
      resetMockAndLocal: () => enqueue(resetJob),
    },
  };
  return controller;
}
