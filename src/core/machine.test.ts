import { describe, expect, it } from 'vitest';

import type { DeleteOutcome, PostOutcome, ReadOutcome } from './api';
import {
  asDeleteKey,
  asIdempotencyKey,
  asJobId,
  asOpId,
  type Operation,
  type Phase,
  type ServerJobView,
} from './domain';
import {
  initialSession,
  isNetworkEffect,
  newOperation,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  reduce,
  SETTLE_RECHECK_DELAYS_MS,
  type Effect,
  type MachineEvent,
  type MachineState,
  type Transition,
} from './machine';

const JOB = asJobId('job-demo-001');
const OTHER = asJobId('job-demo-002');
const KEY = asIdempotencyKey('5f0c6f8e-2a7b-4c1d-9e3f-0a1b2c3d4e5f');
const DKEY = asDeleteKey('8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
const TEMP = '/cache/imports/op.bin';

function freshOp(): Operation {
  return newOperation({
    opId: asOpId('0d2e4f6a-8b0c-4d1e-a3f5-b7c9d1e3f5a7'),
    key: KEY,
    createdAt: 1,
    format: 'csv',
    size: 112,
    name: 'statement.csv',
    tempPath: TEMP,
  });
}

function opIn(phase: Phase, patch: Partial<Operation> = {}): Operation {
  return { ...freshOp(), phase, ...patch };
}

const state = (op: Operation): MachineState => ({ op, session: initialSession() });

function run(start: MachineState, ...events: MachineEvent[]): Transition {
  let current: Transition = { ...start, effects: [] };
  for (const event of events) current = reduce(current, event);
  return current;
}

const types = (t: Transition): string[] => t.effects.map((e) => e.type);
const net = (t: Transition): Effect[] => t.effects.filter(isNetworkEffect);
function reqIdOf(t: Transition, type: Effect['type']): number {
  const effect = t.effects.find((e) => e.type === type);
  if (!effect || !('reqId' in effect))
    throw new Error(`no ${type} effect in [${types(t).join(', ')}]`);
  return effect.reqId;
}

const view = (status: ServerJobView['status'], revision: number, jobId = JOB): ServerJobView =>
  status === 'ready'
    ? {
        jobId,
        status,
        revision,
        result: {
          currency: 'AUD',
          items: [
            {
              id: 'rec-001',
              merchant: 'StreamBeam',
              amountMinor: 1999,
              cadence: 'monthly',
              lastSeen: '2026-10-01',
            },
          ],
        },
      }
    : { jobId, status, revision };
const found = (v: ServerJobView): ReadOutcome => ({ tag: 'found', view: v });

/** Runs a full verify (by-key) + GET read cycle with the given views. */
function readCycle(t: Transition, byKey: ReadOutcome, get?: ReadOutcome): Transition {
  const afterLookup = reduce(t, {
    type: 'lookup_result',
    reqId: reqIdOf(t, 'lookupByKey'),
    outcome: byKey,
  });
  if (!get) return afterLookup;
  return reduce(afterLookup, {
    type: 'get_result',
    reqId: reqIdOf(afterLookup, 'getJob'),
    outcome: get,
  });
}

describe('send (C6, I6, I7)', () => {
  it('persists `sending` before the POST, with the persisted key and the private copy', () => {
    const t = run(state(freshOp()), { type: 'send' });
    expect(types(t)).toEqual(['persist', 'log', 'log', 'post']);
    expect(t.effects[0]).toMatchObject({
      type: 'persist',
      op: { phase: { tag: 'sending', attempt: 1 } },
    });
    expect(t.effects.at(-1)).toMatchObject({ type: 'post', key: KEY, filePath: TEMP, attempt: 1 });
  });

  it('a second send while one is in flight is a no-op (single-flight)', () => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const t2 = reduce(t1, { type: 'send' });
    expect(t2.effects).toEqual([]);
  });

  it('202 → queued (never a report), revision 1, private copy dropped, polling at 400 ms', () => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const outcome: PostOutcome = { tag: 'accepted', jobId: JOB, revision: 1 };
    const t2 = reduce(t1, { type: 'post_result', reqId: reqIdOf(t1, 'post'), outcome });
    expect(t2.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'queued' });
    expect(t2.op.result).toBeNull();
    expect(t2.op.revision).toBe(1);
    expect(t2.op.file.tempPath).toBeNull();
    expect(t2.effects[0]?.type).toBe('persist');
    expect(t2.effects).toContainEqual({ type: 'deleteTempFile', path: TEMP });
    expect(t2.effects).toContainEqual({ type: 'schedulePoll', delayMs: POLL_INITIAL_MS });
  });

  it.each([['timeout' as const], ['reset_after_send' as const], ['unreachable' as const]])(
    'transport %s → outcome_unknown + immediate by-key lookup, no re-POST',
    (cause) => {
      const t1 = run(state(freshOp()), { type: 'send' });
      const t2 = reduce(t1, {
        type: 'post_result',
        reqId: reqIdOf(t1, 'post'),
        outcome: { tag: 'failed', error: { kind: 'transport', cause } },
      });
      expect(t2.op.phase).toEqual({
        tag: 'outcome_unknown',
        cause,
        lookup: 'pending',
        attempt: 1,
        abandon: false,
      });
      expect(net(t2).map((e) => e.type)).toEqual(['lookupByKey']);
    },
  );

  it('not_sent on the first attempt → lookup skipped (nothing reached the server)', () => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: reqIdOf(t1, 'post'),
      outcome: { tag: 'failed', error: { kind: 'transport', cause: 'not_sent' } },
    });
    expect(t2.op.phase).toMatchObject({
      tag: 'outcome_unknown',
      cause: 'not_sent',
      lookup: 'skipped',
    });
    expect(net(t2)).toEqual([]);
  });

  it('not_sent on a resend still looks up (an earlier attempt may have landed)', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'reset_after_send',
      lookup: 'not_found',
      attempt: 1,
      abandon: false,
    });
    const t1 = run(state(start), { type: 'send' });
    expect(t1.effects.at(-1)).toMatchObject({ type: 'post', attempt: 2, key: KEY });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: reqIdOf(t1, 'post'),
      outcome: { tag: 'file_missing' },
    });
    expect(t2.op.phase).toMatchObject({
      tag: 'outcome_unknown',
      cause: 'not_sent',
      lookup: 'pending',
      attempt: 2,
    });
    expect(t2.op.file.tempPath).toBeNull();
    expect(t2.session.notice).toEqual({ tag: 'file_missing' });
    expect(net(t2).map((e) => e.type)).toEqual(['lookupByKey']);
    // Without a private copy there is no "Send again".
    const t3 = reduce(
      reduce(t2, {
        type: 'lookup_result',
        reqId: reqIdOf(t2, 'lookupByKey'),
        outcome: { tag: 'not_found' },
      }),
      { type: 'send' },
    );
    expect(net(t3)).toEqual([]);
  });

  it.each([409, 413, 415])('POST %i → rejected_by_server (terminal, cleaned up)', (status) => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: reqIdOf(t1, 'post'),
      outcome: { tag: 'rejected', httpStatus: status, error: 'x' },
    });
    expect(t2.op.phase).toEqual({ tag: 'rejected_by_server', httpStatus: status, error: 'x' });
    expect(t2.op.file).toMatchObject({ name: '', tempPath: null });
    expect(t2.effects).toContainEqual({ type: 'deleteTempFile', path: TEMP });
  });

  it('POST 400 is a client bug: not terminal, nothing created, resend possible', () => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: reqIdOf(t1, 'post'),
      outcome: { tag: 'client_error', httpStatus: 400 },
    });
    expect(t2.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'skipped' });
    expect(t2.session.notice).toEqual({ tag: 'client_error', httpStatus: 400 });
    expect(t2.effects.some((e) => e.type === 'log' && e.entry.event === 'client_bug')).toBe(true);
  });

  it('POST 5xx → outcome unknown (server may have committed) → lookup', () => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: reqIdOf(t1, 'post'),
      outcome: { tag: 'failed', error: { kind: 'server', httpStatus: 503 } },
    });
    expect(t2.op.phase).toMatchObject({
      tag: 'outcome_unknown',
      cause: 'server_error',
      lookup: 'pending',
    });
  });

  it('a stale / duplicate POST result is ignored', () => {
    const ready = opIn(
      { tag: 'server', jobId: JOB, status: 'ready' },
      { revision: 3, file: { ...freshOp().file, tempPath: null } },
    );
    const t = reduce(state(ready), {
      type: 'post_result',
      reqId: 7,
      outcome: { tag: 'accepted', jobId: JOB, revision: 1 },
    });
    expect(t.op).toBe(ready);
    expect(net(t)).toEqual([]);
  });
});

describe('lost ack recovery (R7)', () => {
  it('by-key 200 adopts the job and sets recoveredByKey', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'reset_after_send',
      lookup: 'pending',
      attempt: 1,
      abandon: false,
    });
    const t1 = run(state(start), { type: 'check_again' }); // pending: no-op
    expect(t1.effects).toEqual([]);
    const t2 = run(state(start), { type: 'cold_start' });
    const t3 = readCycle(t2, found(view('processing', 2)));
    expect(t3.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'processing' });
    expect(t3.op.recoveredByKey).toBe(true);
    expect(t3.op.file.tempPath).toBeNull();
    expect(t3.effects).toContainEqual({ type: 'schedulePoll', delayMs: POLL_INITIAL_MS });
  });

  it('by-key 404 → not_found (UI offers resend); unreachable → unreachable', () => {
    const start = opIn({ tag: 'sending', attempt: 1 });
    const t1 = run(state(start), { type: 'cold_start' });
    expect(t1.op.phase).toMatchObject({
      tag: 'outcome_unknown',
      cause: 'interrupted',
      lookup: 'pending',
    });
    const t2 = readCycle(t1, { tag: 'not_found' });
    expect(t2.op.phase).toMatchObject({ lookup: 'not_found' });
    expect(net(t2)).toEqual([]); // never re-POSTs on its own
    const t3 = readCycle(run(state(start), { type: 'cold_start' }), {
      tag: 'failed',
      error: { kind: 'transport', cause: 'unreachable' },
    });
    expect(t3.op.phase).toMatchObject({ lookup: 'unreachable' });
    expect(t3.session.readError).not.toBeNull();
  });

  it('a 404 with another body is a config error, not "not found"', () => {
    const t1 = run(state(opIn({ tag: 'sending', attempt: 1 })), { type: 'cold_start' });
    const t2 = readCycle(t1, { tag: 'failed', error: { kind: 'config', httpStatus: 404 } });
    expect(t2.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'unreachable' });
    expect(t2.session.notice).toEqual({ tag: 'config_error', httpStatus: 404 });
  });
});

describe('revisions (I2) and stale views (R6)', () => {
  const ready = (): Operation =>
    opIn(
      { tag: 'server', jobId: JOB, status: 'ready' },
      { revision: 3, result: null, file: { ...freshOp().file, tempPath: null } },
    );

  it('refresh: equal revision is a silent no-op, lower revision is ignored and counted', () => {
    const t1 = run(state(ready()), { type: 'refresh' });
    const t2 = readCycle(t1, found(view('ready', 3)), found(view('ready', 3)));
    expect(t2.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'ready' });
    expect(t2.session.ignored.count).toBe(0);
    const t3 = readCycle(
      reduce(t2, { type: 'refresh' }),
      found(view('ready', 3)),
      found(view('processing', 2)),
    );
    expect(t3.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'ready' });
    expect(t3.op.revision).toBe(3);
    expect(t3.session.ignored).toEqual({
      count: 1,
      last: {
        source: 'get',
        status: 'processing',
        revision: 2,
        currentRevision: 3,
        reason: 'stale_revision',
      },
    });
    expect(t3.session.lastRawView).toMatchObject({
      source: 'get',
      view: { status: 'processing', revision: 2 },
    });
  });

  it('a GET answering for another job id is not applied', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'queued' }, { revision: 1 });
    const t = readCycle(
      run(state(start), { type: 'poll_tick' }),
      found(view('queued', 1)),
      found(view('ready', 3, OTHER)),
    );
    expect(t.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'queued' });
    expect(t.session.readError).toMatchObject({ source: 'get', error: { kind: 'protocol' } });
  });

  it('poll error keeps the last known status and retries with backoff', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'processing' }, { revision: 2 });
    let t = run(state(start), { type: 'poll_tick' });
    t = readCycle(t, found(view('processing', 2)), {
      tag: 'failed',
      error: { kind: 'transport', cause: 'timeout' },
    });
    expect(t.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'processing' });
    expect(t.session.readError).toMatchObject({ source: 'get' });
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const scheduled = t.effects.find((e) => e.type === 'schedulePoll');
      if (scheduled?.type === 'schedulePoll') delays.push(scheduled.delayMs);
      t = readCycle(
        reduce(t, { type: 'poll_tick' }),
        found(view('processing', 2)),
        found(view('processing', 2)),
      );
    }
    expect(delays[0]).toBe(400);
    expect(delays[1]).toBe(600);
    expect(Math.max(...delays)).toBe(POLL_MAX_MS);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });

  it('backoff resets to 400 ms on a phase change', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'queued' }, { revision: 1 });
    let t = run(state(start), { type: 'poll_tick' });
    t = readCycle(t, found(view('queued', 1)), found(view('queued', 1)));
    t = readCycle(
      reduce(t, { type: 'poll_tick' }),
      found(view('queued', 1)),
      found(view('queued', 1)),
    );
    expect(t.effects).toContainEqual({ type: 'schedulePoll', delayMs: 600 });
    t = readCycle(
      reduce(t, { type: 'poll_tick' }),
      found(view('processing', 2)),
      found(view('processing', 2)),
    );
    expect(t.effects).toContainEqual({ type: 'schedulePoll', delayMs: 400 });
  });

  it('ready stops polling', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'processing' }, { revision: 2 });
    const t = readCycle(
      run(state(start), { type: 'poll_tick' }),
      found(view('processing', 2)),
      found(view('ready', 3)),
    );
    expect(t.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'ready' });
    expect(t.op.result?.currency).toBe('AUD');
    expect(t.effects.some((e) => e.type === 'schedulePoll')).toBe(false);
  });
});

describe('deletion (I3, I4, C8, C9, R9)', () => {
  const ready = (): Operation =>
    opIn(
      { tag: 'server', jobId: JOB, status: 'ready' },
      { revision: 3, file: { ...freshOp().file, tempPath: null } },
    );

  function toDeleteSent(): Transition {
    const t1 = run(state(ready()), { type: 'request_delete', newDeleteKey: DKEY });
    expect(t1.effects[0]).toMatchObject({
      type: 'persist',
      op: { deleteKey: DKEY, phase: { tag: 'delete_requested' } },
    });
    expect(net(t1).map((e) => e.type)).toEqual(['lookupByKey']); // identity first
    const t2 = readCycle(t1, found(view('ready', 3)));
    expect(net(t2)).toEqual([
      { type: 'del', reqId: expect.any(Number) as number, jobId: JOB, deleteKey: DKEY },
    ]);
    return t2;
  }

  it('DELETE 202 (any body, even deleted/5) → deleting; revision unchanged', () => {
    const t1 = toDeleteSent();
    const outcome: DeleteOutcome = { tag: 'accepted', view: view('deleted', 5) };
    const t2 = reduce(t1, { type: 'delete_result', reqId: reqIdOf(t1, 'del'), outcome });
    expect(t2.op.phase).toEqual({ tag: 'deleting', jobId: JOB });
    expect(t2.op.revision).toBe(3);
    expect(t2.session.lastRawView).toMatchObject({
      source: 'delete',
      view: { status: 'deleted', revision: 5 },
    });
    expect(t2.effects).toContainEqual({ type: 'schedulePoll', delayMs: POLL_INITIAL_MS });
    // Only a GET / by-key view says deleted.
    const t3 = readCycle(
      reduce(t2, { type: 'poll_tick' }),
      found(view('deleting', 4)),
      found(view('deleted', 5)),
    );
    expect(t3.op.phase).toEqual({ tag: 'deleted', jobId: JOB });
    expect(t3.op.revision).toBe(5);
    expect(t3.op.result).toBeNull();
    expect(t3.op.file.name).toBe('');
  });

  it('`deleted` is applied at an equal revision (>=)', () => {
    const start = opIn({ tag: 'deleting', jobId: JOB }, { revision: 5 });
    const t = readCycle(run(state(start), { type: 'poll_tick' }), found(view('deleted', 5)));
    expect(t.op.phase).toEqual({ tag: 'deleted', jobId: JOB });
  });

  it('503 → delete_failed; retry reuses the same delete key', () => {
    const t1 = toDeleteSent();
    const t2 = reduce(t1, {
      type: 'delete_result',
      reqId: reqIdOf(t1, 'del'),
      outcome: { tag: 'failed', error: { kind: 'server', httpStatus: 503 } },
    });
    expect(t2.op.phase).toEqual({ tag: 'delete_failed', jobId: JOB, cause: 'http_5xx' });
    const t3 = reduce(t2, {
      type: 'request_delete',
      newDeleteKey: asDeleteKey('ffffffff-ffff-4fff-8fff-ffffffffffff'),
    });
    const t4 = readCycle(t3, found(view('ready', 3)));
    expect(net(t4)).toEqual([
      { type: 'del', reqId: expect.any(Number) as number, jobId: JOB, deleteKey: DKEY },
    ]);
  });

  it('DELETE 404 job not found → lost; 400/409 → delete_failed(client_error)', () => {
    const t1 = toDeleteSent();
    const lost = reduce(t1, {
      type: 'delete_result',
      reqId: reqIdOf(t1, 'del'),
      outcome: { tag: 'not_found' },
    });
    expect(lost.op.phase).toEqual({ tag: 'lost', jobId: JOB });
    const bad = reduce(t1, {
      type: 'delete_result',
      reqId: reqIdOf(t1, 'del'),
      outcome: { tag: 'client_error', httpStatus: 409 },
    });
    expect(bad.op.phase).toEqual({ tag: 'delete_failed', jobId: JOB, cause: 'client_error' });
  });

  it('tombstone: ready/processing views never move a delete phase back to server', () => {
    for (const phase of [
      { tag: 'delete_requested', jobId: JOB },
      { tag: 'delete_failed', jobId: JOB, cause: 'http_5xx' },
      { tag: 'deleting', jobId: JOB },
    ] as const) {
      const start = opIn(phase, { revision: 2, deleteKey: DKEY });
      const t = readCycle(run(state(start), { type: 'cold_start' }), found(view('ready', 3)));
      expect(t.op.phase.tag).toBe(phase.tag);
      expect(t.session.ignored.last).toMatchObject({ status: 'ready', reason: 'tombstone' });
    }
  });

  it('terminal ops ignore late views and late 202s (no resurrection)', () => {
    const deleted = opIn(
      { tag: 'deleted', jobId: JOB },
      { revision: 5, file: { ...freshOp().file, name: '', tempPath: null } },
    );
    for (const event of [
      { type: 'lookup_result', reqId: 1, outcome: found(view('ready', 9)) },
      { type: 'get_result', reqId: 1, outcome: found(view('queued', 9)) },
      { type: 'post_result', reqId: 1, outcome: { tag: 'accepted', jobId: JOB, revision: 1 } },
      { type: 'delete_result', reqId: 1, outcome: { tag: 'accepted', view: null } },
      { type: 'refresh' },
      { type: 'send' },
      { type: 'request_delete', newDeleteKey: DKEY },
      { type: 'cold_start' },
      { type: 'foreground' },
    ] satisfies MachineEvent[]) {
      const t = reduce(state(deleted), event);
      expect(t.op.phase).toEqual({ tag: 'deleted', jobId: JOB });
      expect(net(t)).toEqual([]);
    }
  });

  it('identity: by-key answers another job id → lost, never DELETE it (R13)', () => {
    const t1 = run(state(ready()), { type: 'request_delete', newDeleteKey: DKEY });
    const t2 = readCycle(t1, found(view('queued', 1, OTHER)));
    expect(t2.op.phase).toEqual({ tag: 'lost', jobId: JOB });
    expect(net(t2)).toEqual([]);
  });

  it('identity: by-key 404 before refresh → lost (mock was reset)', () => {
    const t = readCycle(run(state(ready()), { type: 'refresh' }), { tag: 'not_found' });
    expect(t.op.phase).toEqual({ tag: 'lost', jobId: JOB });
  });

  it('verify failure before DELETE does not DELETE blindly', () => {
    const t1 = run(state(ready()), { type: 'request_delete', newDeleteKey: DKEY });
    const t2 = readCycle(t1, { tag: 'failed', error: { kind: 'transport', cause: 'timeout' } });
    expect(t2.op.phase).toEqual({ tag: 'delete_failed', jobId: JOB, cause: 'timeout' });
    expect(net(t2)).toEqual([]);
  });
});

describe('cancel / abandon', () => {
  it('cancel while sending aborts; 404s re-checked after settle delays, then cancelled', () => {
    const t1 = run(state(freshOp()), { type: 'send' });
    const t2 = reduce(t1, { type: 'cancel_sending' });
    expect(t2.effects).toEqual([{ type: 'abortPost', reqId: reqIdOf(t1, 'post') }]);
    const t3 = reduce(t2, {
      type: 'post_result',
      reqId: reqIdOf(t1, 'post'),
      outcome: { tag: 'failed', error: { kind: 'transport', cause: 'reset_after_send' } },
    });
    expect(t3.op.phase).toMatchObject({ tag: 'outcome_unknown', abandon: true, lookup: 'pending' });
    // TZ: by-key 404 means «пока не найден» — bytes may still land; never cancel on one 404.
    let t = t3;
    for (const delayMs of SETTLE_RECHECK_DELAYS_MS) {
      t = readCycle(t, { tag: 'not_found' });
      expect(t.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'settling' });
      expect(t.effects).toContainEqual({ type: 'schedulePoll', delayMs });
      expect(net(t)).toEqual([]);
      expect(t.op.file.tempPath).toBe(TEMP);
      t = reduce(t, { type: 'poll_tick' });
      expect(t.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'pending' });
      expect(net(t).map((e) => e.type)).toEqual(['lookupByKey']);
    }
    const done = readCycle(t, { tag: 'not_found' });
    expect(done.op.phase).toEqual({ tag: 'cancelled' });
    expect(done.effects).toContainEqual({ type: 'deleteTempFile', path: TEMP });
  });

  it('cancel while sending: the job lands after the first 404 → a re-check finds it (delete path kept)', () => {
    const t1 = run(state(freshOp()), { type: 'send' }, { type: 'cancel_sending' });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: 1,
      outcome: { tag: 'failed', error: { kind: 'transport', cause: 'reset_after_send' } },
    });
    const t3 = reduce(readCycle(t2, { tag: 'not_found' }), { type: 'poll_tick' });
    const t4 = readCycle(t3, found(view('queued', 1)));
    expect(t4.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'queued' });
    expect(t4.session.notice).toEqual({ tag: 'cancel_too_late' });
  });

  it('settling: no resend / abandon / check-again; background pauses, foreground re-checks', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'timeout',
      lookup: 'not_found',
      attempt: 1,
      abandon: false,
    });
    const settling = readCycle(run(state(start), { type: 'abandon' }), { tag: 'not_found' });
    expect(settling.op.phase).toMatchObject({ lookup: 'settling', abandon: true });
    for (const event of [{ type: 'send' }, { type: 'abandon' }, { type: 'check_again' }] as const) {
      const t = reduce(settling, event);
      expect(t.op).toBe(settling.op);
      expect(net(t)).toEqual([]);
    }
    const bg = reduce(settling, { type: 'background' });
    expect(types(bg)).toContain('cancelPoll');
    expect(net(reduce(bg, { type: 'poll_tick' }))).toEqual([]);
    const fg = reduce(bg, { type: 'foreground' });
    expect(net(fg).map((e) => e.type)).toEqual(['lookupByKey']);
  });

  it('abandon when nothing can be in flight (unreachable) → one 404 cancels', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'unreachable',
      lookup: 'not_found',
      attempt: 1,
      abandon: false,
    });
    const t = readCycle(run(state(start), { type: 'abandon' }), { tag: 'not_found' });
    expect(t.op.phase).toEqual({ tag: 'cancelled' });
  });

  it('cancel too late (202 arrives) → the job is shown, with a notice', () => {
    const t1 = run(state(freshOp()), { type: 'send' }, { type: 'cancel_sending' });
    const t2 = reduce(t1, {
      type: 'post_result',
      reqId: 1,
      outcome: { tag: 'accepted', jobId: JOB, revision: 1 },
    });
    expect(t2.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'queued' });
    expect(t2.session.notice).toEqual({ tag: 'cancel_too_late' });
  });

  it('abandon: final lookup finds the job → job screen (delete path kept)', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'timeout',
      lookup: 'unreachable',
      attempt: 1,
      abandon: false,
    });
    const t1 = run(state(start), { type: 'abandon' });
    expect(t1.op.phase).toMatchObject({ abandon: true, lookup: 'pending' });
    const t2 = readCycle(t1, found(view('queued', 1)));
    expect(t2.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'queued' });
    expect(t2.session.notice).toEqual({ tag: 'cancel_too_late' });
  });

  it('abandon with lookup unreachable stays undecided (never cancels blindly)', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'timeout',
      lookup: 'not_found',
      attempt: 1,
      abandon: false,
    });
    const t = readCycle(run(state(start), { type: 'abandon' }), {
      tag: 'failed',
      error: { kind: 'transport', cause: 'unreachable' },
    });
    expect(t.op.phase).toMatchObject({
      tag: 'outcome_unknown',
      abandon: true,
      lookup: 'unreachable',
    });
  });

  it('abandon after a first-attempt not_sent cancels directly (nothing on the server)', () => {
    const start = opIn({
      tag: 'outcome_unknown',
      cause: 'not_sent',
      lookup: 'skipped',
      attempt: 1,
      abandon: false,
    });
    const t = run(state(start), { type: 'abandon' });
    expect(t.op.phase).toEqual({ tag: 'cancelled' });
    expect(net(t)).toEqual([]);
  });
});

describe('cold start table', () => {
  it.each<[string, Phase, string[]]>([
    ['pending_send', { tag: 'pending_send' }, ['lookupByKey']],
    ['sending', { tag: 'sending', attempt: 2 }, ['lookupByKey']],
    [
      'outcome_unknown',
      { tag: 'outcome_unknown', cause: 'timeout', lookup: 'not_found', attempt: 1, abandon: false },
      ['lookupByKey'],
    ],
    ['server queued', { tag: 'server', jobId: JOB, status: 'queued' }, ['lookupByKey']],
    ['server ready', { tag: 'server', jobId: JOB, status: 'ready' }, ['lookupByKey']],
    ['delete_requested', { tag: 'delete_requested', jobId: JOB }, ['lookupByKey']],
    ['delete_failed', { tag: 'delete_failed', jobId: JOB, cause: 'http_5xx' }, ['lookupByKey']],
    ['deleting', { tag: 'deleting', jobId: JOB }, ['lookupByKey']],
    ['deleted', { tag: 'deleted', jobId: JOB }, []],
    ['cancelled', { tag: 'cancelled' }, []],
  ])('%s → %j (never a POST)', (_name, phase, expected) => {
    const t = run(state(opIn(phase, { deleteKey: DKEY, revision: 1 })), { type: 'cold_start' });
    expect(net(t).map((e) => e.type)).toEqual(expected);
  });

  it('server ready → verify → exactly one GET → no polling', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'ready' }, { revision: 3 });
    const t1 = readCycle(run(state(start), { type: 'cold_start' }), found(view('ready', 3)));
    expect(net(t1).map((e) => e.type)).toEqual(['getJob']);
    const t2 = reduce(t1, {
      type: 'get_result',
      reqId: reqIdOf(t1, 'getJob'),
      outcome: found(view('ready', 3)),
    });
    expect(net(t2)).toEqual([]);
    expect(t2.effects.some((e) => e.type === 'schedulePoll')).toBe(false);
  });

  it('server ready from a minimised journal row (no result, no name) → the same revision re-fetched fills the report in memory, writes nothing', () => {
    const start = opIn(
      { tag: 'server', jobId: JOB, status: 'ready' },
      { revision: 3, result: null, file: { format: 'csv', size: 112, name: '', tempPath: null } },
    );
    const t1 = readCycle(run(state(start), { type: 'cold_start' }), found(view('ready', 3)));
    expect(t1.op.result?.items.map((item) => item.merchant)).toEqual(['StreamBeam']);
    expect(t1.op.revision).toBe(3);
    expect(types(t1)).not.toContain('persist');
    expect(net(t1).map((e) => e.type)).toEqual(['getJob']);
    // An older revision never fills it.
    const cold = run(state(start), { type: 'cold_start' });
    const stale = reduce(cold, {
      type: 'lookup_result',
      reqId: reqIdOf(cold, 'lookupByKey'),
      outcome: found(view('ready', 2)),
    });
    expect(stale.op.result).toBeNull();
  });

  describe('cold-start ready without the report: never left with nothing in flight', () => {
    const coldReady = (): Operation =>
      opIn(
        { tag: 'server', jobId: JOB, status: 'ready' },
        { revision: 3, result: null, file: { format: 'csv', size: 112, name: '', tempPath: null } },
      );

    it('both views stale (stale_status) → a retry is scheduled with backoff; the fill stops it', () => {
      let t = readCycle(
        run(state(coldReady()), { type: 'cold_start' }),
        found(view('processing', 2)),
        found(view('processing', 2)),
      );
      expect(t.op.result).toBeNull();
      expect(t.effects).toContainEqual({ type: 'schedulePoll', delayMs: POLL_INITIAL_MS });
      // The tick re-reads (by key, then GET); still stale → the delay grows.
      t = readCycle(
        reduce(t, { type: 'poll_tick' }),
        found(view('processing', 2)),
        found(view('processing', 2)),
      );
      expect(t.effects).toContainEqual({
        type: 'schedulePoll',
        delayMs: Math.round(POLL_INITIAL_MS * 1.5),
      });
      // The same revision arrives → report filled in memory, polling stops, nothing written.
      t = readCycle(
        reduce(t, { type: 'poll_tick' }),
        found(view('ready', 3)),
        found(view('ready', 3)),
      );
      expect(t.op.result?.items.map((item) => item.merchant)).toEqual(['StreamBeam']);
      expect(types(t)).not.toContain('schedulePoll');
      expect(types(t)).not.toContain('persist');
      expect(net(reduce(t, { type: 'poll_tick' }))).toEqual([]);
    });

    it('by-key unreachable → readError set and a retry is scheduled (not "loading" forever)', () => {
      const t = readCycle(run(state(coldReady()), { type: 'cold_start' }), {
        tag: 'failed',
        error: { kind: 'transport', cause: 'unreachable' },
      });
      expect(t.session.readError).not.toBeNull();
      expect(t.effects).toContainEqual({ type: 'schedulePoll', delayMs: POLL_INITIAL_MS });
      expect(net(reduce(t, { type: 'poll_tick' })).map((e) => e.type)).toEqual(['lookupByKey']);
    });

    it('paused: no retry until foreground', () => {
      const cold = run(state(coldReady()), { type: 'cold_start' });
      const bg = reduce(cold, { type: 'background' });
      const t = reduce(bg, {
        type: 'lookup_result',
        reqId: reqIdOf(cold, 'lookupByKey'),
        outcome: { tag: 'failed', error: { kind: 'transport', cause: 'unreachable' } },
      });
      expect(types(t)).not.toContain('schedulePoll');
      expect(net(reduce(t, { type: 'poll_tick' }))).toEqual([]);
      // Foreground resumes: verify by key again.
      expect(net(reduce(t, { type: 'foreground' })).map((e) => e.type)).toEqual(['lookupByKey']);
    });
  });

  it('delete_requested → verify → DELETE with the persisted key', () => {
    const start = opIn({ tag: 'delete_requested', jobId: JOB }, { revision: 3, deleteKey: DKEY });
    const t = readCycle(run(state(start), { type: 'cold_start' }), found(view('ready', 3)));
    expect(net(t)).toEqual([
      { type: 'del', reqId: expect.any(Number) as number, jobId: JOB, deleteKey: DKEY },
    ]);
  });

  it('delete_failed → verify: ready stays; deleting is followed', () => {
    const start = opIn(
      { tag: 'delete_failed', jobId: JOB, cause: 'http_5xx' },
      { revision: 3, deleteKey: DKEY },
    );
    const stays = readCycle(run(state(start), { type: 'cold_start' }), found(view('ready', 3)));
    expect(stays.op.phase.tag).toBe('delete_failed');
    const follows = readCycle(
      run(state(start), { type: 'cold_start' }),
      found(view('deleting', 4)),
    );
    expect(follows.op.phase).toEqual({ tag: 'deleting', jobId: JOB });
  });

  it('a terminal op that still holds a copy is cleaned up (I8)', () => {
    const start = opIn({ tag: 'lost', jobId: JOB });
    const t = run(state(start), { type: 'cold_start' });
    expect(t.op.file).toMatchObject({ name: '', tempPath: null });
    expect(t.effects).toContainEqual({ type: 'deleteTempFile', path: TEMP });
  });
});

describe('background / foreground', () => {
  it('background cancels the poll timer; poll ticks are ignored while paused', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'queued' }, { revision: 1 });
    const t1 = run(state(start), { type: 'background' });
    expect(types(t1)).toContain('cancelPoll');
    expect(net(reduce(t1, { type: 'poll_tick' }))).toEqual([]);
    const t2 = reduce(t1, { type: 'foreground' });
    expect(net(t2).map((e) => e.type)).toEqual(['lookupByKey']);
  });
});

describe('diagnostics never keep the result (I8)', () => {
  it('lastRawView carries no merchants / amounts, also after the op went terminal', () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'processing' }, { revision: 2 });
    const ready = readCycle(
      run(state(start), { type: 'refresh' }),
      found(view('ready', 3)),
      found(view('ready', 3)),
    );
    expect(ready.op.result).not.toBeNull();
    expect(ready.session.lastRawView?.view).toEqual({ jobId: JOB, status: 'ready', revision: 3 });
    const lost = readCycle(reduce(ready, { type: 'refresh' }), { tag: 'not_found' });
    expect(lost.op.phase).toEqual({ tag: 'lost', jobId: JOB });
    expect(JSON.stringify(lost.session)).not.toContain('StreamBeam');
    expect(JSON.stringify(lost.op)).not.toContain('StreamBeam');
  });

  it("a foreign job's ready view is never stored with its result", () => {
    const start = opIn({ tag: 'server', jobId: JOB, status: 'ready' }, { revision: 3 });
    const t = readCycle(run(state(start), { type: 'refresh' }), found(view('ready', 3, OTHER)));
    expect(t.op.phase).toEqual({ tag: 'lost', jobId: JOB });
    expect(JSON.stringify(t.session)).not.toContain('StreamBeam');
  });
});

describe('corrupt row: delete phase without a delete key', () => {
  it('never sits in delete_requested with nothing in flight; retry assigns a key', () => {
    const start = opIn({ tag: 'delete_requested', jobId: JOB }, { revision: 3, deleteKey: null });
    const t1 = readCycle(run(state(start), { type: 'cold_start' }), found(view('ready', 3)));
    expect(t1.op.phase).toEqual({ tag: 'delete_failed', jobId: JOB, cause: 'client_error' });
    expect(net(t1)).toEqual([]);
    const t2 = reduce(t1, { type: 'retry_delete', newDeleteKey: DKEY });
    expect(t2.op).toMatchObject({ deleteKey: DKEY, phase: { tag: 'delete_requested' } });
    const t3 = readCycle(t2, found(view('ready', 3)));
    expect(net(t3)).toEqual([
      { type: 'del', reqId: expect.any(Number) as number, jobId: JOB, deleteKey: DKEY },
    ]);
  });

  it('retry_delete never replaces a persisted delete key', () => {
    const start = opIn(
      { tag: 'delete_failed', jobId: JOB, cause: 'http_5xx' },
      { revision: 3, deleteKey: DKEY },
    );
    const t = reduce(state(start) as Transition, {
      type: 'retry_delete',
      newDeleteKey: asDeleteKey('11111111-2222-4333-8444-555555555555'),
    });
    expect(t.op.deleteKey).toBe(DKEY);
  });
});

describe('automatic same-key re-POST on a by-key 404 race', () => {
  const failed = (
    cause: 'not_sent' | 'unreachable' | 'timeout' | 'reset_after_send' | 'interrupted',
  ): PostOutcome => ({
    tag: 'failed',
    error: { kind: 'transport', cause },
  });

  /** In-session: the user's first "Send", then the POST fails with `outcome`. */
  function firstPostFails(outcome: PostOutcome): Transition {
    const t1 = run(state(freshOp()), { type: 'send' });
    return reduce(t1, { type: 'post_result', reqId: reqIdOf(t1, 'post'), outcome });
  }

  const posts = (t: Transition) => t.effects.filter((e) => e.type === 'post');

  it.each(['timeout', 'reset_after_send'] as const)(
    '%s + genuine by-key 404 → exactly one re-POST: same key, bytes and name, persisted first',
    (cause) => {
      const t2 = firstPostFails(failed(cause));
      expect(t2.op.phase).toMatchObject({ tag: 'outcome_unknown', cause, lookup: 'pending' });
      expect(t2.session.autoResend).toBe('armed');
      const t3 = readCycle(t2, { tag: 'not_found' });
      // `sending` (attempt 2) is persisted before the POST leaves.
      expect(t3.effects[0]).toMatchObject({
        type: 'persist',
        op: { phase: { tag: 'sending', attempt: 2 } },
      });
      expect(net(t3)).toEqual([
        {
          type: 'post',
          reqId: expect.any(Number) as number,
          opId: freshOp().opId,
          key: KEY,
          filePath: TEMP,
          fileName: 'statement.csv',
          format: 'csv',
          attempt: 2,
        },
      ]);
      expect(t3.session).toMatchObject({ autoResend: 'used', autoPostReqId: reqIdOf(t3, 'post') });
      expect(t3.effects.some((e) => e.type === 'log' && e.entry.event === 'post_auto_resend')).toBe(
        true,
      );
      // The automatic re-POST lands: a normal job, the private copy dropped.
      const t4 = reduce(t3, {
        type: 'post_result',
        reqId: reqIdOf(t3, 'post'),
        outcome: { tag: 'accepted', jobId: JOB, revision: 1 },
      });
      expect(t4.op.phase).toEqual({ tag: 'server', jobId: JOB, status: 'queued' });
      expect(t4.session.autoPostReqId).toBeNull();
      expect(t4.op.file.tempPath).toBeNull();
    },
  );

  it('the automatic re-POST fails too → tap options; never a third POST without a tap', () => {
    const t3 = readCycle(firstPostFails(failed('reset_after_send')), { tag: 'not_found' });
    const t4 = reduce(t3, {
      type: 'post_result',
      reqId: reqIdOf(t3, 'post'),
      outcome: failed('timeout'),
    });
    expect(t4.op.phase).toMatchObject({ tag: 'outcome_unknown', cause: 'timeout', attempt: 2 });
    const t5 = readCycle(t4, { tag: 'not_found' });
    expect(t5.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'not_found', attempt: 2 });
    expect(net(t5)).toEqual([]);
    // A later 404 ("Check again") still does not POST.
    const again = readCycle(reduce(t5, { type: 'check_again' }), { tag: 'not_found' });
    expect(net(again)).toEqual([]);
    // The user's tap still works: attempt 3 with the same key.
    const tap = reduce(again, { type: 'send' });
    expect(tap.effects.at(-1)).toMatchObject({ type: 'post', attempt: 3, key: KEY });
    expect(tap.session.autoPostReqId).toBeNull();
  });

  it('a by-key 404 after an unreachable lookup ("Проверить снова") still allows the one re-POST', () => {
    const t2 = firstPostFails(failed('timeout'));
    const t3 = readCycle(t2, { tag: 'failed', error: { kind: 'transport', cause: 'unreachable' } });
    expect(t3.op.phase).toMatchObject({ lookup: 'unreachable' });
    expect(net(t3)).toEqual([]);
    const t4 = readCycle(reduce(t3, { type: 'check_again' }), { tag: 'not_found' });
    expect(posts(t4)).toHaveLength(1);
  });

  it.each([
    ['not_sent', 0],
    ['unreachable', 0],
    ['server_error', 0],
    // The cold-start cause: never an in-session race, even in an armed session.
    ['interrupted', 0],
    ['timeout', 1],
  ] as const)('armed session, cause %s, by-key 404 → %i automatic POST(s)', (cause, expected) => {
    // An armed session (it issued the first POST) whose earlier attempts ended with `cause`.
    const armed: MachineState = {
      op: opIn({ tag: 'outcome_unknown', cause, lookup: 'not_found', attempt: 2, abandon: false }),
      session: { ...initialSession(), autoResend: 'armed' },
    };
    const t = readCycle(run(armed, { type: 'check_again' }), { tag: 'not_found' });
    expect(posts(t)).toHaveLength(expected);
  });

  it.each(['not_sent', 'unreachable'] as const)('in session: %s is not a race', (cause) => {
    const t2 = firstPostFails(failed(cause));
    const t3 =
      t2.op.phase.tag === 'outcome_unknown' && t2.op.phase.lookup === 'pending'
        ? readCycle(t2, { tag: 'not_found' })
        : t2;
    expect(posts(t3)).toEqual([]);
    expect(t3.op.phase).toMatchObject({ tag: 'outcome_unknown', cause });
  });

  it('server_error (5xx) and a config 404 never auto-resend', () => {
    const t2 = firstPostFails({ tag: 'failed', error: { kind: 'server', httpStatus: 503 } });
    expect(posts(readCycle(t2, { tag: 'not_found' }))).toEqual([]);
    const t3 = firstPostFails(failed('timeout'));
    const t4 = readCycle(t3, { tag: 'failed', error: { kind: 'config', httpStatus: 404 } });
    expect(posts(t4)).toEqual([]);
  });

  it('cancel while sending (abandon) → 404s settle → cancelled; never an automatic re-POST', () => {
    const sent = run(state(freshOp()), { type: 'send' });
    const t1 = reduce(sent, { type: 'cancel_sending' });
    let t = reduce(t1, {
      type: 'post_result',
      reqId: reqIdOf(sent, 'post'),
      outcome: failed('reset_after_send'),
    });
    for (let i = 0; i < SETTLE_RECHECK_DELAYS_MS.length; i += 1) {
      t = readCycle(t, { tag: 'not_found' });
      expect(posts(t)).toEqual([]);
      t = reduce(t, { type: 'poll_tick' });
    }
    t = readCycle(t, { tag: 'not_found' });
    expect(t.op.phase).toEqual({ tag: 'cancelled' });
    expect(posts(t)).toEqual([]);
  });

  it('"Отказаться" in outcome_unknown → final 404 → settle, never an automatic re-POST', () => {
    const t2 = firstPostFails(failed('timeout'));
    const t3 = readCycle(t2, { tag: 'failed', error: { kind: 'transport', cause: 'unreachable' } });
    const t4 = readCycle(reduce(t3, { type: 'abandon' }), { tag: 'not_found' });
    expect(t4.op.phase).toMatchObject({ abandon: true, lookup: 'settling' });
    expect(posts(t4)).toEqual([]);
  });

  it('"Отмена" during the automatic re-POST behaves like cancel while sending (abandon + settle)', () => {
    const t3 = readCycle(firstPostFails(failed('reset_after_send')), { tag: 'not_found' });
    const autoReq = reqIdOf(t3, 'post');
    const t4 = reduce(t3, { type: 'cancel_sending' });
    expect(t4.effects).toEqual([{ type: 'abortPost', reqId: autoReq }]);
    const t5 = reduce(t4, {
      type: 'post_result',
      reqId: autoReq,
      outcome: failed('reset_after_send'),
    });
    expect(t5.op.phase).toMatchObject({ tag: 'outcome_unknown', abandon: true, attempt: 2 });
    let t = readCycle(t5, { tag: 'not_found' });
    expect(t.op.phase).toMatchObject({ lookup: 'settling' });
    for (let i = 0; i < SETTLE_RECHECK_DELAYS_MS.length; i += 1) {
      t = readCycle(reduce(t, { type: 'poll_tick' }), { tag: 'not_found' });
      expect(posts(t)).toEqual([]);
    }
    expect(t.op.phase).toEqual({ tag: 'cancelled' });
  });

  it('cold start: outcome_unknown / sending → 404 → no POST before a tap, and none after it', () => {
    for (const phase of [
      { tag: 'sending', attempt: 1 },
      {
        tag: 'outcome_unknown',
        cause: 'reset_after_send',
        lookup: 'pending',
        attempt: 1,
        abandon: false,
      },
    ] satisfies Phase[]) {
      const t1 = readCycle(run(state(opIn(phase)), { type: 'cold_start' }), { tag: 'not_found' });
      expect(t1.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'not_found' });
      expect(t1.session.autoResend).toBe('off');
      expect(posts(t1)).toEqual([]);
      // The tapped resend fails the same way: a cold-started session still never auto-sends.
      const tap = reduce(t1, { type: 'send' });
      expect(posts(tap)).toHaveLength(1);
      const t2 = readCycle(
        reduce(tap, {
          type: 'post_result',
          reqId: reqIdOf(tap, 'post'),
          outcome: failed('timeout'),
        }),
        { tag: 'not_found' },
      );
      expect(posts(t2)).toEqual([]);
      expect(t2.op.phase).toMatchObject({ lookup: 'not_found' });
    }
  });

  it('nothing persisted arms it: the journal row of an armed session is identical in shape', () => {
    const t2 = firstPostFails(failed('reset_after_send'));
    const persisted = t2.effects.find((e) => e.type === 'persist');
    expect(persisted).toBeDefined();
    expect(JSON.stringify(persisted)).not.toMatch(/auto/i);
  });

  it('without the private copy there is no automatic re-POST', () => {
    const t2 = firstPostFails(failed('reset_after_send'));
    const noCopy: Transition = { ...t2, op: { ...t2.op, file: { ...t2.op.file, tempPath: null } } };
    const t3 = readCycle(noCopy, { tag: 'not_found' });
    expect(posts(t3)).toEqual([]);
    expect(t3.op.phase).toMatchObject({ lookup: 'not_found' });
  });

  it('409 on the automatic re-POST is a client bug: notice, lookup, never terminal or retried', () => {
    const t3 = readCycle(firstPostFails(failed('reset_after_send')), { tag: 'not_found' });
    const t4 = reduce(t3, {
      type: 'post_result',
      reqId: reqIdOf(t3, 'post'),
      outcome: { tag: 'rejected', httpStatus: 409, error: 'key reused for another file' },
    });
    // The server answered and the earlier race attempt may have landed: never "not sent".
    expect(t4.op.phase).toMatchObject({
      tag: 'outcome_unknown',
      cause: 'server_error',
      lookup: 'pending',
    });
    expect(t4.session.notice).toEqual({ tag: 'client_error', httpStatus: 409 });
    expect(t4.op.file.tempPath).toBe(TEMP);
    expect(t4.effects.some((e) => e.type === 'log' && e.entry.event === 'client_bug')).toBe(true);
    expect(net(t4).map((e) => e.type)).toEqual(['lookupByKey']);
    // Whatever holds the key is adopted (delete path kept); a 404 offers only the tap options.
    expect(readCycle(t4, found(view('queued', 1))).op.phase).toMatchObject({ tag: 'server' });
    const t5 = readCycle(t4, { tag: 'not_found' });
    expect(posts(t5)).toEqual([]);
    // "Cancel import" then still gets the settle re-checks instead of an instant "cancelled".
    const t6 = readCycle(reduce(t5, { type: 'abandon' }), { tag: 'not_found' });
    expect(t6.op.phase).toMatchObject({ abandon: true, lookup: 'settling' });
  });

  it('a by-key 404 while backgrounded never POSTs; foreground re-checks the key, then re-POSTs once', () => {
    const t2 = firstPostFails(failed('reset_after_send'));
    const bg = reduce(t2, { type: 'background' });
    const t3 = reduce(bg, {
      type: 'lookup_result',
      reqId: reqIdOf(t2, 'lookupByKey'),
      outcome: { tag: 'not_found' },
    });
    expect(posts(t3)).toEqual([]);
    expect(t3.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'not_found' });
    expect(t3.session.autoResend).toBe('armed');
    // Back in the foreground: a fresh by-key lookup first, never a blind POST.
    const fg = reduce(t3, { type: 'foreground' });
    expect(posts(fg)).toEqual([]);
    expect(net(fg).map((e) => e.type)).toEqual(['lookupByKey']);
    expect(fg.op.phase).toMatchObject({ tag: 'outcome_unknown', lookup: 'pending' });
    // The earlier attempt landed meanwhile → adopted, no POST at all.
    expect(readCycle(fg, found(view('queued', 1))).op.phase).toMatchObject({ tag: 'server' });
    // Still 404 → the one automatic re-POST, now in the foreground.
    const t4 = readCycle(fg, { tag: 'not_found' });
    expect(posts(t4)).toHaveLength(1);
    expect(t4.session.autoResend).toBe('used');
  });
});
