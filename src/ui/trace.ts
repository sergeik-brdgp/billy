// Billy's "how I got here" log: a pure fold over controller snapshots. A line is added only when the
// app observes something new about the current import (a state, a recovery by key, a discarded
// stale reply). Nothing here guesses at what the server does inside; no file name, URI or merchant
// is ever put in a line. In memory only: after a restart the log starts with "Picked up after a
// restart" and the state the journal recovered.

import { formatSize, type ImportSnapshot, type OperationView } from '../core';
import { TRACE_CAUSE_COPY, TRACE_COPY } from './copy';

export interface TraceLine {
  readonly key: string;
  readonly text: string;
}

export interface Trace {
  /** The op the lines belong to (null: no import on screen). */
  readonly opId: string | null;
  readonly lines: readonly TraceLine[];
  /** Discarded-reply count already logged (diagnostics counter is per session). */
  readonly ignoredSeen: number;
  /** The import has stopped moving: no "working on it" line. */
  readonly settled: boolean;
}

export const EMPTY_TRACE: Trace = { opId: null, lines: [], ignoredSeen: 0, settled: true };

function opOf(snapshot: ImportSnapshot): OperationView | null {
  const view = snapshot.view;
  return 'op' in view ? view.op : null;
}

/** States that wait for the user (or are final): the last line is not "in progress". */
function isSettled(snapshot: ImportSnapshot): boolean {
  const view = snapshot.view;
  switch (view.tag) {
    case 'job':
      return view.status === 'ready' && view.op.result !== null;
    case 'outcome_unknown':
      return view.lookup !== 'pending' && view.lookup !== 'settling';
    case 'delete_failed':
    case 'deleted':
    case 'lost':
    case 'rejected_by_server':
    case 'cancelled':
      return true;
    default:
      return false;
  }
}

export function advanceTrace(prev: Trace, snapshot: ImportSnapshot): Trace {
  const op = opOf(snapshot);
  const ignored = snapshot.diagnostics.ignoredViews;
  if (op === null) {
    return prev.opId === null && prev.lines.length === 0
      ? prev
      : { ...EMPTY_TRACE, ignoredSeen: ignored.count };
  }

  const view = snapshot.view;
  const fresh = prev.opId !== op.opId;
  const lines: TraceLine[] = fresh ? [] : [...prev.lines];
  let ignoredSeen = fresh ? ignored.count : prev.ignoredSeen;
  const push = (key: string, text: string, once = false): void => {
    if (once ? lines.some((line) => line.key === key) : lines.at(-1)?.key === key) return;
    lines.push({ key, text });
  };

  // An op is created by «Send» in this session; meeting it first in any other state means the
  // journal brought it back after a restart.
  if (fresh && view.tag !== 'sending') push('restart', TRACE_COPY.restart);

  switch (view.tag) {
    case 'sending':
      // The journal write before the POST failed: nothing went out, so don't claim "Sending".
      if (view.notStarted && snapshot.storageError) push('not_started', TRACE_COPY.notStarted);
      else if (view.attempt > 1 || view.autoRetry) {
        push(`send:${view.attempt}`, TRACE_COPY.resending);
      } else push('send:1', TRACE_COPY.sending(formatSize(op.file.size)));
      break;
    case 'outcome_unknown':
      push(`unknown:${view.attempt}`, TRACE_CAUSE_COPY[view.cause], true);
      if (view.lookup === 'pending' || view.lookup === 'settling') {
        push('lookup', TRACE_COPY.lookup);
      } else if (view.lookup === 'not_found') {
        push('not_found', TRACE_COPY.notFound);
      }
      break;
    case 'job':
      if (op.recoveredByKey) push('recovered', TRACE_COPY.recovered, true);
      if (view.status === 'queued') push('queued', TRACE_COPY.queued, true);
      else if (view.status === 'processing') push('processing', TRACE_COPY.processing, true);
      else if (op.result !== null) push('ready', TRACE_COPY.ready(op.result.items.length), true);
      else push('refetch', TRACE_COPY.refetch, true);
      break;
    case 'delete_requested':
      push(
        'delete_asked',
        lines.some((line) => line.key === 'delete_asked')
          ? TRACE_COPY.deleteAskedAgain
          : TRACE_COPY.deleteAsked,
      );
      break;
    case 'deleting':
      push('deleting', TRACE_COPY.deleting);
      break;
    case 'delete_failed':
      push('delete_failed', TRACE_COPY.deleteFailed);
      break;
    case 'deleted':
      push('deleted', TRACE_COPY.deleted, true);
      break;
    case 'lost':
      push('lost', TRACE_COPY.lost, true);
      break;
    case 'rejected_by_server':
      push('rejected', TRACE_COPY.rejected(view.httpStatus), true);
      break;
    case 'cancelled':
      push('cancelled', TRACE_COPY.cancelled, true);
      break;
    default:
      break;
  }

  // A stale reply the core discarded (e.g. processing r2 after ready r3): worth saying out loud.
  if (ignored.count > ignoredSeen && ignored.last !== null) {
    const last = ignored.last;
    if (last.reason === 'stale_revision') {
      push(
        `ignored:${ignored.count}`,
        TRACE_COPY.ignored(last.status, last.revision, last.currentRevision),
      );
    }
    ignoredSeen = ignored.count;
  }

  const settled = isSettled(snapshot);
  const unchanged =
    !fresh &&
    lines.length === prev.lines.length &&
    ignoredSeen === prev.ignoredSeen &&
    settled === prev.settled;
  return unchanged ? prev : { opId: op.opId, lines, ignoredSeen, settled };
}
