// Billy's "how I got here" log (src/ui/trace.ts): a pure fold over controller snapshots. Lines only
// for states the app observed, never a file name, and the same object back when nothing changed
// (ImportScreen sets state from it during render).

import type { ImportSnapshot, ImportView, OperationView, OpId } from '../core';
import { advanceTrace, EMPTY_TRACE, type Trace } from './trace';
import { JOB_ID, READY_RESULT, makeSnapshot, opView } from './test-utils/fakeController';

const sending = (op: OperationView = opView({ revision: 0 }), attempt = 1): ImportView => ({
  tag: 'sending',
  op,
  attempt,
  progress: { bytesSent: 10, totalBytes: 112 },
  cancelRequested: false,
  autoRetry: false,
  notStarted: false,
});
const job = (
  status: 'queued' | 'processing' | 'ready',
  op: OperationView = opView({
    revision: status === 'ready' ? 3 : 1,
    result: status === 'ready' ? READY_RESULT : null,
  }),
): ImportView => ({ tag: 'job', op, jobId: JOB_ID, status });
const readyOp = opView({ revision: 3, result: READY_RESULT });

/** Folds the snapshots from the empty trace; returns every intermediate trace. */
function fold(snapshots: readonly ImportSnapshot[], from: Trace = EMPTY_TRACE): Trace[] {
  const out: Trace[] = [];
  let trace = from;
  for (const snapshot of snapshots) {
    trace = advanceTrace(trace, snapshot);
    out.push(trace);
  }
  return out;
}
const texts = (trace: Trace): string[] => trace.lines.map((line) => line.text);
const last = (traces: readonly Trace[]): Trace => {
  const trace = traces.at(-1);
  if (trace === undefined) throw new Error('no traces');
  return trace;
};

describe('advanceTrace', () => {
  it('happy path: one line per observed state, settled only once the report is in', () => {
    const traces = fold([
      makeSnapshot(sending()),
      makeSnapshot(job('queued')),
      makeSnapshot(job('processing')),
      makeSnapshot(job('ready')),
    ]);
    expect(texts(last(traces))).toEqual([
      'Sending 112 B',
      'The server queued it',
      'The server is reading it',
      'Report ready · 2 charges',
    ]);
    expect(traces.map((trace) => trace.settled)).toEqual([false, false, false, true]);
    expect(last(traces).opId).toBe(readyOp.opId);
  });

  it('ready without the report in memory is not settled (the report is being fetched again)', () => {
    const trace = last(
      fold([makeSnapshot(sending()), makeSnapshot(job('ready', opView({ revision: 3 })))]),
    );
    expect(texts(trace)).toEqual(['Sending 112 B', 'Fetching the report again']);
    expect(trace.settled).toBe(false);
  });

  it('lost ack: the dropped reply, the by-key lookup and the recovery, each said once', () => {
    const recovered = opView({ recoveredByKey: true });
    const outcome = (lookup: 'pending' | 'settling'): ImportView => ({
      tag: 'outcome_unknown',
      op: opView({ revision: 0 }),
      cause: 'reset_after_send',
      lookup,
      attempt: 1,
      abandon: false,
    });
    const traces = fold([
      makeSnapshot(sending()),
      makeSnapshot(outcome('pending')),
      makeSnapshot(outcome('settling')),
      makeSnapshot(job('queued', recovered)),
      makeSnapshot(job('processing', { ...recovered, revision: 2 })),
      makeSnapshot(job('ready', { ...recovered, revision: 3, result: READY_RESULT })),
    ]);
    expect(texts(last(traces))).toEqual([
      'Sending 112 B',
      'The connection dropped',
      'Asking the server by key',
      'Found the job by key',
      'The server queued it',
      'The server is reading it',
      'Report ready · 2 charges',
    ]);
    // Looking up by key is work in progress; the recovery stays one line across later states.
    expect(traces[1]?.settled).toBe(false);
    expect(texts(last(traces)).filter((text) => text === 'Found the job by key')).toHaveLength(1);
  });

  it('a stale reply the core discarded is logged once, with its revisions', () => {
    const stale = {
      count: 1,
      last: {
        source: 'get',
        status: 'processing',
        revision: 2,
        currentRevision: 3,
        reason: 'stale_revision',
      },
    } as const;
    const traces = fold([
      makeSnapshot(sending()),
      makeSnapshot(job('ready')),
      makeSnapshot(job('ready'), { version: 2, diagnostics: { ignoredViews: stale } }),
      makeSnapshot(job('ready'), { version: 3, diagnostics: { ignoredViews: stale } }),
    ]);
    expect(texts(last(traces))).toEqual([
      'Sending 112 B',
      'Report ready · 2 charges',
      'Ignored an older reply (processing r2 after r3)',
    ]);
    expect(last(traces).settled).toBe(true);
    // The same counter again is not a new discard.
    expect(traces[3]).toBe(traces[2]);
  });

  it('discards for other reasons and earlier imports are not logged as stale replies', () => {
    const tombstone = {
      count: 3,
      last: {
        source: 'get',
        status: 'processing',
        revision: 2,
        currentRevision: 3,
        reason: 'tombstone',
      },
    } as const;
    // The session counter already stood at 2 before this import began.
    const traces = fold([
      makeSnapshot(sending(), { diagnostics: { ignoredViews: { ...tombstone, count: 2 } } }),
      makeSnapshot(job('ready'), { diagnostics: { ignoredViews: tombstone } }),
    ]);
    expect(texts(last(traces))).toEqual(['Sending 112 B', 'Report ready · 2 charges']);
    expect(last(traces).ignoredSeen).toBe(3);
  });

  it('delete failure then retry: "deleted" only once the server confirmed it', () => {
    const traces = fold([
      makeSnapshot(sending()),
      makeSnapshot(job('ready')),
      makeSnapshot({ tag: 'delete_requested', op: readyOp, jobId: JOB_ID }),
      makeSnapshot({ tag: 'delete_failed', op: readyOp, jobId: JOB_ID, cause: 'http_5xx' }),
      makeSnapshot({ tag: 'delete_requested', op: readyOp, jobId: JOB_ID }),
      makeSnapshot({ tag: 'deleting', op: readyOp, jobId: JOB_ID }),
      makeSnapshot({ tag: 'deleted', op: readyOp, jobId: JOB_ID }),
    ]);
    expect(texts(last(traces))).toEqual([
      'Sending 112 B',
      'Report ready · 2 charges',
      'Asked the server to delete',
      "Delete didn't go through",
      'Asked the server to delete again',
      'The server is deleting',
      'Deleted on the server',
    ]);
    // Nothing before the server's answer says "Deleted".
    for (const trace of traces.slice(0, -1)) {
      expect(texts(trace).some((text) => text.startsWith('Deleted'))).toBe(false);
    }
    // A failed delete waits for the user; a delete in flight does not.
    expect(traces.map((trace) => trace.settled)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it('a send that never started (journal write failed) is not logged as "Sending"', () => {
    const view: ImportView = { ...sending(), notStarted: true } as ImportView;
    const trace = advanceTrace(EMPTY_TRACE, makeSnapshot(view, { storageError: true }));
    expect(texts(trace)).toEqual(["Couldn't save my notes, so nothing was sent"]);
    expect(texts(trace).some((text) => text.startsWith('Sending'))).toBe(false);
  });

  it('an op first met in any state but "sending" was brought back by the journal', () => {
    const trace = last(fold([makeSnapshot(job('processing'))]));
    expect(texts(trace)).toEqual(['Picked up after a restart', 'The server is reading it']);
    const fresh = last(fold([makeSnapshot(sending())]));
    expect(texts(fresh)).toEqual(['Sending 112 B']);
  });

  it('a new op starts a new log; no op on screen clears it', () => {
    const first = last(fold([makeSnapshot(sending()), makeSnapshot(job('ready'))]));
    const otherOp = opView({ opId: 'op-0002' as OpId, revision: 0 });
    const second = advanceTrace(first, makeSnapshot(sending(otherOp)));
    expect(second.opId).toBe('op-0002');
    expect(texts(second)).toEqual(['Sending 112 B']);
    expect(second.settled).toBe(false);

    const cleared = advanceTrace(first, makeSnapshot({ tag: 'empty' }));
    expect(cleared.opId).toBeNull();
    expect(cleared.lines).toEqual([]);
    // Already empty: the very same object.
    expect(advanceTrace(cleared, makeSnapshot({ tag: 'empty' }))).toBe(cleared);
    expect(advanceTrace(EMPTY_TRACE, makeSnapshot({ tag: 'starting' }))).toBe(EMPTY_TRACE);
  });

  it('returns the same object when nothing new was observed (progress ticks, refreshes)', () => {
    const start = advanceTrace(EMPTY_TRACE, makeSnapshot(sending()));
    const tick = advanceTrace(
      start,
      makeSnapshot({ ...sending(), progress: { bytesSent: 90, totalBytes: 112 } } as ImportView, {
        version: 2,
      }),
    );
    expect(tick).toBe(start);
    const ready = advanceTrace(tick, makeSnapshot(job('ready')));
    expect(advanceTrace(ready, makeSnapshot(job('ready'), { version: 9 }))).toBe(ready);
    expect(advanceTrace(ready, makeSnapshot(job('ready'), { activity: { reading: true } }))).toBe(
      ready,
    );
  });

  it('never puts the file name in a line (privacy)', () => {
    const named = opView({
      file: { name: 'statement.csv', size: 112, format: 'csv', available: true },
    });
    const views: ImportView[] = [
      sending({ ...named, revision: 0 }),
      sending({ ...named, revision: 0 }, 2),
      {
        tag: 'outcome_unknown',
        op: named,
        cause: 'timeout',
        lookup: 'not_found',
        attempt: 2,
        abandon: false,
      },
      job('queued', { ...named, recoveredByKey: true }),
      job('processing', { ...named, recoveredByKey: true }),
      job('ready', { ...named, recoveredByKey: true, revision: 3, result: READY_RESULT }),
      { tag: 'delete_requested', op: named, jobId: JOB_ID },
      { tag: 'delete_failed', op: named, jobId: JOB_ID, cause: 'timeout' },
      { tag: 'deleting', op: named, jobId: JOB_ID },
      { tag: 'deleted', op: named, jobId: JOB_ID },
      { tag: 'lost', op: { ...named, opId: 'op-0003' as OpId }, jobId: JOB_ID },
      {
        tag: 'rejected_by_server',
        op: { ...named, opId: 'op-0004' as OpId },
        httpStatus: 415,
        error: 'unsupported',
      },
      { tag: 'cancelled', op: { ...named, opId: 'op-0005' as OpId } },
    ];
    const traces = fold(views.map((view) => makeSnapshot(view)));
    const all = traces.flatMap(texts);
    expect(all.length).toBeGreaterThan(10);
    for (const text of all) {
      expect(text).not.toContain('statement');
      expect(text).not.toContain('.csv');
      expect(text).not.toContain('StreamBeam');
    }
  });
});
