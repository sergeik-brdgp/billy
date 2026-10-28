// Property tests (fast-check) for invariants I1–I8, C8, C9 on the pure reducer under random
// interleavings of user actions, server views (any status / revision / job id), failures,
// duplicate and late responses (incl. 202 for ready / deleted ops) and restarts.
// I7 here: a POST only for the user's send, plus at most ONE automatic same-key re-POST per op per
// session after a genuine by-key 404 race — and zero in a session that began with a cold start.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ApiError, DeleteOutcome, PostOutcome, ReadOutcome } from '../../src/core/api';
import { decodeOperation, encodeOperation, journalKeepsFileName } from '../../src/core/codec';
import {
  asDeleteKey,
  asIdempotencyKey,
  asJobId,
  asOpId,
  isTerminal,
  isTombstone,
  phaseJobId,
  type JobId,
  type Operation,
  type ServerJobView,
} from '../../src/core/domain';
import {
  initialSession,
  isNetworkEffect,
  newOperation,
  reduce,
  type MachineEvent,
  type Session,
  type Transition,
} from '../../src/core/machine';

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261027);
const JOB = asJobId('job-demo-001');
const OTHER = asJobId('job-demo-002');
const KEY = asIdempotencyKey('5f0c6f8e-2a7b-4c1d-9e3f-0a1b2c3d4e5f');
const TEMP = '/cache/imports/op.bin';
const FILE_NAME = 'statement.csv';

// ---------------------------------------------------------------------------------------------
// Arbitraries

const jobIdArb: fc.Arbitrary<JobId> = fc.constantFrom(JOB, JOB, JOB, OTHER);

const viewArb: fc.Arbitrary<ServerJobView> = fc
  .record({
    status: fc.constantFrom('queued', 'processing', 'ready', 'deleting', 'deleted') as fc.Arbitrary<
      ServerJobView['status']
    >,
    revision: fc.integer({ min: 0, max: 6 }),
    jobId: jobIdArb,
  })
  .map(({ status, revision, jobId }): ServerJobView =>
    status === 'ready'
      ? { jobId, status, revision, result: { currency: 'AUD', items: [] } }
      : { jobId, status, revision },
  );

const apiErrorArb: fc.Arbitrary<ApiError> = fc.oneof(
  fc
    .constantFrom('not_sent', 'unreachable', 'timeout', 'reset_after_send', 'interrupted')
    .map((cause) => ({ kind: 'transport' as const, cause })),
  fc.constant({ kind: 'config' as const, httpStatus: 404 }),
  fc.constant({ kind: 'server' as const, httpStatus: 503 }),
  fc.constant({ kind: 'protocol' as const, httpStatus: 200 }),
);

const postOutcomeArb: fc.Arbitrary<PostOutcome> = fc.oneof(
  {
    weight: 3,
    arbitrary: jobIdArb.map((jobId) => ({ tag: 'accepted' as const, jobId, revision: 1 })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(409, 413, 415)
      .map((httpStatus) => ({ tag: 'rejected' as const, httpStatus, error: 'e' })),
  },
  { weight: 1, arbitrary: fc.constant({ tag: 'client_error' as const, httpStatus: 400 }) },
  { weight: 1, arbitrary: fc.constant({ tag: 'file_missing' as const }) },
  { weight: 3, arbitrary: apiErrorArb.map((error) => ({ tag: 'failed' as const, error })) },
);

const readOutcomeArb: fc.Arbitrary<ReadOutcome> = fc.oneof(
  { weight: 5, arbitrary: viewArb.map((view) => ({ tag: 'found' as const, view })) },
  { weight: 1, arbitrary: fc.constant({ tag: 'not_found' as const }) },
  { weight: 2, arbitrary: apiErrorArb.map((error) => ({ tag: 'failed' as const, error })) },
);

const deleteOutcomeArb: fc.Arbitrary<DeleteOutcome> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .option(viewArb, { nil: null })
      .map((view) => ({ tag: 'accepted' as const, view })),
  },
  { weight: 1, arbitrary: fc.constant({ tag: 'not_found' as const }) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(400, 409)
      .map((httpStatus) => ({ tag: 'client_error' as const, httpStatus })),
  },
  { weight: 2, arbitrary: apiErrorArb.map((error) => ({ tag: 'failed' as const, error })) },
);

type Step =
  | { readonly k: 'user'; readonly event: MachineEvent }
  | { readonly k: 'env'; readonly event: MachineEvent }
  | { readonly k: 'restart' }
  | { readonly k: 'deliver_post'; readonly outcome: PostOutcome }
  | { readonly k: 'deliver_read'; readonly read: ReadOutcome }
  | { readonly k: 'deliver_del'; readonly outcome: DeleteOutcome }
  /** Late / duplicate / foreign response with an arbitrary request id. */
  | { readonly k: 'stray'; readonly event: MachineEvent };

const userArb: fc.Arbitrary<Step> = fc
  .constantFrom<MachineEvent>(
    { type: 'send' },
    { type: 'send' },
    { type: 'cancel_sending' },
    { type: 'check_again' },
    { type: 'abandon' },
    { type: 'refresh' },
    { type: 'request_delete', newDeleteKey: asDeleteKey('8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d') },
    { type: 'retry_delete' },
  )
  .map((event) => ({ k: 'user' as const, event }));

const envArb: fc.Arbitrary<Step> = fc
  .constantFrom<MachineEvent>(
    { type: 'poll_tick' },
    { type: 'poll_tick' },
    { type: 'foreground' },
    { type: 'background' },
  )
  .map((event) => ({ k: 'env' as const, event }));

const strayArb: fc.Arbitrary<Step> = fc
  .tuple(
    fc.integer({ min: 0, max: 12 }),
    postOutcomeArb,
    readOutcomeArb,
    deleteOutcomeArb,
    fc.integer({ min: 0, max: 3 }),
  )
  .map(([reqId, post, read, del, which]) => {
    const event: MachineEvent =
      which === 0
        ? { type: 'post_result', reqId, outcome: post }
        : which === 1
          ? { type: 'lookup_result', reqId, outcome: read }
          : which === 2
            ? { type: 'get_result', reqId, outcome: read }
            : { type: 'delete_result', reqId, outcome: del };
    return { k: 'stray' as const, event };
  });

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: userArb },
  { weight: 2, arbitrary: envArb },
  { weight: 1, arbitrary: fc.constant<Step>({ k: 'restart' }) },
  {
    weight: 3,
    arbitrary: postOutcomeArb.map((outcome) => ({ k: 'deliver_post' as const, outcome })),
  },
  { weight: 6, arbitrary: readOutcomeArb.map((read) => ({ k: 'deliver_read' as const, read })) },
  {
    weight: 3,
    arbitrary: deleteOutcomeArb.map((outcome) => ({ k: 'deliver_del' as const, outcome })),
  },
  { weight: 2, arbitrary: strayArb },
);

// ---------------------------------------------------------------------------------------------
// Simulation

type Lane = 'post' | 'del' | 'read';
interface Outstanding {
  readonly reqId: number;
  readonly type: 'post' | 'lookupByKey' | 'getJob' | 'del';
}

interface Sim {
  op: Operation;
  session: Session;
  persisted: Operation;
  outstanding: Record<Lane, Outstanding[]>;
  knewJob: boolean;
  /** Automatic (non-tap) POSTs in the current session. */
  autoPosts: number;
  /** The current session began with a cold start (relaunch). */
  coldStarted: boolean;
  trace: string[];
}

/** Across all runs: the generator really reaches the automatic re-POST (not vacuous). */
const autoCoverage = { posts: 0, deniedAfterColdStart: 0 };

function laneOf(type: Outstanding['type']): Lane {
  return type === 'post' ? 'post' : type === 'del' ? 'del' : 'read';
}

function resultLane(event: MachineEvent): Lane | null {
  switch (event.type) {
    case 'post_result':
      return 'post';
    case 'delete_result':
      return 'del';
    case 'lookup_result':
    case 'get_result':
      return 'read';
    default:
      return null;
  }
}

function initialOp(): Operation {
  return newOperation({
    opId: asOpId('0d2e4f6a-8b0c-4d1e-a3f5-b7c9d1e3f5a7'),
    key: KEY,
    createdAt: 1,
    format: 'csv',
    size: 112,
    name: FILE_NAME,
    tempPath: TEMP,
  });
}

function toEvent(sim: Sim, step: Step): MachineEvent | null {
  switch (step.k) {
    case 'user':
    case 'env':
    case 'stray':
      return step.event;
    case 'restart':
      return { type: 'cold_start' };
    case 'deliver_post': {
      const o = sim.outstanding.post[0];
      return o ? { type: 'post_result', reqId: o.reqId, outcome: step.outcome } : null;
    }
    case 'deliver_del': {
      const o = sim.outstanding.del[0];
      return o ? { type: 'delete_result', reqId: o.reqId, outcome: step.outcome } : null;
    }
    case 'deliver_read': {
      const o = sim.outstanding.read[0];
      if (!o) return null;
      return o.type === 'lookupByKey'
        ? { type: 'lookup_result', reqId: o.reqId, outcome: step.read }
        : { type: 'get_result', reqId: o.reqId, outcome: step.read };
    }
    default:
      return null;
  }
}

function checkTransition(
  sim: Sim,
  event: MachineEvent,
  prev: Operation,
  prevSession: Session,
  t: Transition,
): void {
  const next = t.op;
  const ctx = (): string => `\n${sim.trace.join('\n')}`;

  // the key never changes; every POST uses it and the same immutable private copy.
  expect(next.key, ctx()).toBe(KEY);
  for (const e of t.effects) {
    if (e.type === 'post') {
      expect(e.key, ctx()).toBe(KEY);
      expect(e.filePath, ctx()).toBe(TEMP);
      // Recovery needs X-File-Name (the mock answers 400 to an empty one): every POST — also a
      // resend after a relaunch, i.e. from the journal's stored form — carries the original name.
      expect(e.fileName, ctx()).toBe(FILE_NAME);
    }
  }

  // revision never decreases.
  expect(next.revision, ctx()).toBeGreaterThanOrEqual(prev.revision);

  // tombstone phases never go back to server / sending.
  if (isTombstone(prev.phase)) {
    expect(['server', 'pending_send', 'sending', 'outcome_unknown'], ctx()).not.toContain(
      next.phase.tag,
    );
  }

  // I4 / C9: `deleted` only from a GET / by-key view saying deleted; DELETE never changes revision.
  if (next.phase.tag === 'deleted' && prev.phase.tag !== 'deleted') {
    const viaView =
      (event.type === 'lookup_result' || event.type === 'get_result') &&
      event.outcome.tag === 'found' &&
      event.outcome.view.status === 'deleted';
    expect(viaView, ctx()).toBe(true);
  }
  if (event.type === 'delete_result') expect(next.revision, ctx()).toBe(prev.revision);

  // a change of what the journal stores is persisted first, and persist is only ever the
  // first effect. In-memory-only changes (the re-fetched ready result) write nothing.
  const persistIdx = t.effects.findIndex((e) => e.type === 'persist');
  if (encodeOperation(next) !== encodeOperation(prev)) {
    expect(persistIdx, ctx()).toBe(0);
    expect(t.effects[0], ctx()).toEqual({ type: 'persist', op: next });
  } else {
    expect(persistIdx, ctx()).toBe(-1);
  }
  expect(t.effects.filter((e) => e.type === 'persist').length, ctx()).toBeLessThanOrEqual(1);

  // Journal minimisation: the stored body never holds the ready result, and holds the file name
  // only while a resend may need it (before the server has the job).
  const stored = JSON.parse(encodeOperation(next)) as Operation;
  expect(stored.result, ctx()).toBeNull();
  if (!journalKeepsFileName(next.phase)) expect(stored.file.name, ctx()).toBe('');

  // a POST for the user's send, or the one bounded automatic same-key re-POST: only on the
  // genuine by-key 404 for a non-abandoned race cause, at most once per session, never after a
  // cold start. Nothing in the persisted op may carry that permission into a new session.
  if (t.effects.some((e) => e.type === 'post') && event.type !== 'send') {
    expect(event.type, ctx()).toBe('lookup_result');
    expect(event.type === 'lookup_result' && event.outcome.tag, ctx()).toBe('not_found');
    expect(prev.phase.tag, ctx()).toBe('outcome_unknown');
    if (prev.phase.tag === 'outcome_unknown') {
      expect(prev.phase.abandon, ctx()).toBe(false);
      // `interrupted` is the cold-start cause: never auto-resent.
      expect(['timeout', 'reset_after_send'], ctx()).toContain(prev.phase.cause);
    }
    // Never from the background: the OS would likely kill the upload and spend the one attempt.
    expect(prevSession.paused, ctx()).toBe(false);
    expect(sim.coldStarted, ctx()).toBe(false);
    expect(sim.autoPosts, ctx()).toBe(0);
    sim.autoPosts += 1;
    autoCoverage.posts += 1;
  }
  if (
    sim.coldStarted &&
    event.type === 'lookup_result' &&
    event.outcome.tag === 'not_found' &&
    prev.phase.tag === 'outcome_unknown' &&
    !prev.phase.abandon
  ) {
    autoCoverage.deniedAfterColdStart += 1;
  }
  expect(JSON.stringify(next), ctx()).not.toMatch(/auto/i);

  // terminal ops hold no name, result or copy; a dropped copy is deleted.
  if (isTerminal(next.phase)) {
    expect(next.file.name, ctx()).toBe('');
    expect(next.result, ctx()).toBeNull();
    expect(next.file.tempPath, ctx()).toBeNull();
  }
  if (prev.file.tempPath !== null && next.file.tempPath === null) {
    expect(t.effects, ctx()).toContainEqual({ type: 'deleteTempFile', path: prev.file.tempPath });
  }

  // terminal is absorbing; late responses never resurrect.
  if (isTerminal(prev.phase)) expect(next, ctx()).toBe(prev);

  // Never "cancelled" once a server job was known (always a delete path).
  if (next.phase.tag === 'cancelled' && prev.phase.tag !== 'cancelled') {
    expect(sim.knewJob, ctx()).toBe(false);
    const viaNotFound = event.type === 'lookup_result' && event.outcome.tag === 'not_found';
    const firstAttemptNothingSent =
      (prev.phase.tag === 'outcome_unknown' && prev.phase.lookup === 'skipped') ||
      (prev.phase.tag === 'sending' && prev.phase.attempt === 1 && event.type === 'post_result');
    expect(viaNotFound || firstAttemptNothingSent, ctx()).toBe(true);
  }

  // I5 (reducer level): at most one new request per lane, only when the lane is free.
  const prevInflight = prevSession.inflight;
  for (const lane of ['post', 'del', 'read'] as const) {
    const emitted = t.effects.filter(isNetworkEffect).filter((e) => laneOf(e.type) === lane);
    expect(emitted.length, ctx()).toBeLessThanOrEqual(1);
    const [first] = emitted;
    if (first) {
      const before = lane === 'read' ? (prevInflight.read?.reqId ?? null) : prevInflight[lane];
      if (before !== null) {
        // Only the result of that very request may chain the next one (lookup → GET).
        expect(resultLane(event), ctx()).toBe(lane);
        expect('reqId' in event ? event.reqId : -1, ctx()).toBe(before);
      }
    }
  }
}

function apply(sim: Sim, step: Step): void {
  if (step.k === 'restart') {
    // Process death: in-flight requests die with it; the journal (its stored form) is all that
    // survives — no ready result, no name once the server has the job.
    const reloaded = decodeOperation(encodeOperation(sim.persisted));
    if (!reloaded.ok) throw new Error('journal row does not decode');
    sim.op = reloaded.value;
    sim.session = initialSession();
    sim.outstanding = { post: [], del: [], read: [] };
    sim.autoPosts = 0;
    sim.coldStarted = true;
  }
  const event = toEvent(sim, step);
  if (event === null) return;
  sim.trace.push(`${step.k}: ${JSON.stringify(event)}`);
  const prev = sim.op;
  const prevSession = sim.session;
  const t = reduce({ op: prev, session: prevSession }, event);
  checkTransition(sim, event, prev, prevSession, t);

  // Model of the network: a result answers its request.
  const lane = resultLane(event);
  if (lane !== null && 'reqId' in event) {
    sim.outstanding[lane] = sim.outstanding[lane].filter((o) => o.reqId !== event.reqId);
  }
  for (const e of t.effects) {
    if (e.type === 'persist') sim.persisted = e.op;
    if (isNetworkEffect(e)) sim.outstanding[laneOf(e.type)].push({ reqId: e.reqId, type: e.type });
  }
  // I5 (system level): at most one request in flight per lane.
  for (const l of ['post', 'del', 'read'] as const) {
    expect(sim.outstanding[l].length, sim.trace.join('\n')).toBeLessThanOrEqual(1);
  }
  // whenever requests are in flight, the journal holds exactly the in-memory op (as stored).
  expect(encodeOperation(sim.persisted)).toBe(encodeOperation(t.op));

  sim.op = t.op;
  sim.session = t.session;
  if (phaseJobId(t.op.phase) !== null) sim.knewJob = true;
}

describe('reducer invariants under random interleavings (I1–I8, C8, C9; I7 incl. auto re-POST)', () => {
  it('hold for every reachable sequence', () => {
    const reached = new Set<string>();
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 80 }), (steps) => {
        const op = initialOp();
        const sim: Sim = {
          op,
          session: initialSession(),
          persisted: op,
          outstanding: { post: [], del: [], read: [] },
          knewJob: false,
          autoPosts: 0,
          coldStarted: false,
          trace: [],
        };
        apply(sim, { k: 'user', event: { type: 'send' } });
        for (const step of steps) {
          apply(sim, step);
          reached.add(sim.op.phase.tag);
        }
      }),
      // Fixed seed: the coverage assertion below must not depend on luck (reproducible results);
      // FC_SEED=<n> explores other interleavings locally.
      { numRuns: 1500, seed: PROPERTY_SEED },
    );
    // The generator really explores the whole machine (guards against a vacuous property).
    expect([...reached].sort()).toEqual(
      [
        'cancelled',
        'delete_failed',
        'delete_requested',
        'deleted',
        'deleting',
        'lost',
        'outcome_unknown',
        'rejected_by_server',
        'sending',
        'server',
      ].sort(),
    );
    // The automatic re-POST is reachable from the general generator too.
    expect(autoCoverage.posts).toBeGreaterThan(0);
  });

  it('race-focused: at most one automatic POST per op per session, zero after a cold start', () => {
    // Biased towards the race: POSTs failing with every transport cause, by-key 404s, taps,
    // cancels / abandons and relaunches. The I7 checks in checkTransition do the asserting.
    const raceCause = fc.constantFrom(
      'not_sent',
      'unreachable',
      'timeout',
      'reset_after_send',
      'interrupted',
    );
    const raceStepArb: fc.Arbitrary<Step> = fc.oneof(
      {
        weight: 4,
        arbitrary: raceCause.map((cause) => ({
          k: 'deliver_post' as const,
          outcome: { tag: 'failed' as const, error: { kind: 'transport' as const, cause } },
        })),
      },
      {
        weight: 1,
        arbitrary: fc.constant<Step>({
          k: 'deliver_post',
          outcome: { tag: 'accepted', jobId: JOB, revision: 1 },
        }),
      },
      {
        weight: 5,
        arbitrary: fc.constant<Step>({ k: 'deliver_read', read: { tag: 'not_found' } }),
      },
      {
        weight: 1,
        arbitrary: readOutcomeArb.map((read) => ({ k: 'deliver_read' as const, read })),
      },
      {
        weight: 3,
        arbitrary: fc
          .constantFrom<MachineEvent>(
            { type: 'send' },
            { type: 'cancel_sending' },
            { type: 'check_again' },
            { type: 'abandon' },
          )
          .map((event) => ({ k: 'user' as const, event })),
      },
      { weight: 1, arbitrary: envArb },
      { weight: 1, arbitrary: fc.constant<Step>({ k: 'restart' }) },
    );
    const before = { ...autoCoverage };
    fc.assert(
      fc.property(fc.array(raceStepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        const op = initialOp();
        const sim: Sim = {
          op,
          session: initialSession(),
          persisted: op,
          outstanding: { post: [], del: [], read: [] },
          knewJob: false,
          autoPosts: 0,
          coldStarted: false,
          trace: [],
        };
        apply(sim, { k: 'user', event: { type: 'send' } });
        for (const step of steps) apply(sim, step);
      }),
      { numRuns: 1500, seed: PROPERTY_SEED },
    );
    // Not vacuous: automatic re-POSTs happened, and so did 404 races after a cold start.
    expect(autoCoverage.posts - before.posts).toBeGreaterThan(100);
    expect(autoCoverage.deniedAfterColdStart - before.deniedAfterColdStart).toBeGreaterThan(100);
  });

  it('a ready or deleted op is never changed by duplicate / late 202s or older views', () => {
    const ready: Operation = {
      ...initialOp(),
      revision: 3,
      file: { ...initialOp().file, tempPath: null },
      phase: { tag: 'server', jobId: JOB, status: 'ready' },
      result: { currency: 'AUD', items: [] },
    };
    const deleted: Operation = {
      ...ready,
      revision: 5,
      result: null,
      file: { ...ready.file, name: '' },
      phase: { tag: 'deleted', jobId: JOB },
    };
    fc.assert(
      fc.property(
        fc.constantFrom(ready, deleted),
        fc.array(strayArb, { maxLength: 30 }),
        (start, strays) => {
          let state = { op: start, session: initialSession() };
          for (const step of strays) {
            if (step.k !== 'stray') continue;
            const ev = step.event;
            // Only views newer than ready may change a ready op (and never back below ready).
            const t = reduce(state, ev);
            if (start.phase.tag === 'deleted') expect(t.op).toBe(start);
            else {
              expect(t.op.revision).toBeGreaterThanOrEqual(3);
              if (t.op.phase.tag === 'server') expect(t.op.phase.status).toBe('ready');
            }
            state = t;
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
