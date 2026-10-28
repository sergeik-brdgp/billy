// One representative snapshot per view tag (plus variants), with the title and the exact
// buttons the screen must show. Shared by the render tests and the large-font scan.

import type { ImportSnapshot } from '../../core';
import {
  EMPTY_COPY,
  JOB_STATUS_COPY,
  LOCAL_REJECTION_COPY,
  OUTCOME_LOOKUP_COPY,
  OUTCOME_TITLE_COPY,
  SENDING_COPY,
  VIEW_COPY,
  type ViewTag,
} from '../copy';
import { JOB_ID, OP_ID, READY_RESULT, makeSnapshot, opView } from './fakeController';

export interface StateCase {
  readonly name: string;
  readonly tag: ViewTag;
  readonly snapshot: ImportSnapshot;
  readonly title: string;
  readonly status?: string;
  /** Accessible names of the buttons, in order (diagnostics disabled). */
  readonly buttons: readonly string[];
}

const readyOp = opView({ revision: 3, result: READY_RESULT });

export const STATE_CASES: readonly StateCase[] = [
  {
    name: 'starting',
    tag: 'starting',
    snapshot: makeSnapshot({ tag: 'starting' }),
    title: VIEW_COPY.starting.title,
    buttons: [],
  },
  {
    name: 'storage_unavailable',
    tag: 'storage_unavailable',
    snapshot: makeSnapshot(
      { tag: 'storage_unavailable' },
      { actions: { retryStorage: true }, storageError: true },
    ),
    title: VIEW_COPY.storage_unavailable.title,
    buttons: ['Retry'],
  },
  {
    name: 'empty',
    tag: 'empty',
    snapshot: makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true } }),
    // A freshly mounted screen is the first empty screen of the session: Billy says hello.
    title: EMPTY_COPY.greetingTitle,
    status: EMPTY_COPY.greetingStatus,
    buttons: ['Choose file'],
  },
  {
    name: 'preparing',
    tag: 'preparing',
    snapshot: makeSnapshot({ tag: 'preparing' }),
    title: VIEW_COPY.preparing.title,
    buttons: [],
  },
  {
    name: 'local_rejection spoofed',
    tag: 'local_rejection',
    snapshot: makeSnapshot(
      { tag: 'local_rejection', rejection: { reason: 'not_statement' } },
      { actions: { pickFile: true, newImport: true } },
    ),
    title: LOCAL_REJECTION_COPY.not_statement.title,
    status: LOCAL_REJECTION_COPY.not_statement.status,
    buttons: ['Choose another file', 'Close'],
  },
  {
    name: 'local_rejection oversize',
    tag: 'local_rejection',
    snapshot: makeSnapshot(
      { tag: 'local_rejection', rejection: { reason: 'oversize', size: 12_582_912 } },
      { actions: { pickFile: true, newImport: true } },
    ),
    title: LOCAL_REJECTION_COPY.oversize.title,
    status: 'Size: 12.0 MiB',
    buttons: ['Choose another file', 'Close'],
  },
  {
    name: 'local_rejection unreadable',
    tag: 'local_rejection',
    snapshot: makeSnapshot(
      { tag: 'local_rejection', rejection: { reason: 'unreadable' } },
      { actions: { pickFile: true, newImport: true } },
    ),
    title: LOCAL_REJECTION_COPY.unreadable.title,
    buttons: ['Choose another file', 'Close'],
  },
  {
    name: 'confirm',
    tag: 'confirm',
    snapshot: makeSnapshot(
      {
        tag: 'confirm',
        draft: { draftId: OP_ID, name: 'statement.csv', size: 112, format: 'csv' },
      },
      { actions: { confirmSend: true, cancelDraft: true } },
    ),
    title: VIEW_COPY.confirm.title,
    buttons: ['Send', 'Cancel'],
  },
  {
    name: 'sending',
    tag: 'sending',
    snapshot: makeSnapshot(
      {
        tag: 'sending',
        op: opView({ revision: 0 }),
        attempt: 1,
        progress: { bytesSent: 45, totalBytes: 100 },
        cancelRequested: false,
        autoRetry: false,
        notStarted: false,
      },
      { actions: { cancelSending: true }, activity: { posting: true } },
    ),
    title: VIEW_COPY.sending.title,
    status: SENDING_COPY.progress('45%'),
    buttons: ['Cancel'],
  },
  {
    name: 'sending, cancel requested',
    tag: 'sending',
    snapshot: makeSnapshot(
      {
        tag: 'sending',
        op: opView({ revision: 0 }),
        attempt: 1,
        progress: null,
        cancelRequested: true,
        autoRetry: false,
        notStarted: false,
      },
      { activity: { posting: true } },
    ),
    title: SENDING_COPY.cancelling.title,
    // Still visible (disabled, busy) while the upload stops.
    buttons: ['Cancel'],
  },
  {
    name: 'sending, automatic same-key re-POST',
    tag: 'sending',
    snapshot: makeSnapshot(
      {
        tag: 'sending',
        op: opView({ revision: 0 }),
        attempt: 2,
        progress: { bytesSent: 10, totalBytes: 100 },
        cancelRequested: false,
        autoRetry: true,
        notStarted: false,
      },
      { actions: { cancelSending: true }, activity: { posting: true } },
    ),
    title: SENDING_COPY.autoRetry.title,
    status: SENDING_COPY.autoRetry.status,
    // The user can still cancel the automatic re-POST (abandon + settle rule).
    buttons: ['Cancel'],
  },
  {
    name: 'outcome_unknown not found',
    tag: 'outcome_unknown',
    snapshot: makeSnapshot(
      {
        tag: 'outcome_unknown',
        op: opView({ revision: 0 }),
        cause: 'timeout',
        lookup: 'not_found',
        attempt: 1,
        abandon: false,
      },
      { actions: { checkAgain: true, resend: true, abandon: true } },
    ),
    title: OUTCOME_TITLE_COPY.unknown,
    status: OUTCOME_LOOKUP_COPY.not_found,
    buttons: ['Check again', 'Send again', 'Cancel import'],
  },
  {
    name: 'outcome_unknown settling',
    tag: 'outcome_unknown',
    snapshot: makeSnapshot({
      tag: 'outcome_unknown',
      op: opView({ revision: 0 }),
      cause: 'reset_after_send',
      lookup: 'settling',
      attempt: 1,
      abandon: true,
    }),
    title: OUTCOME_TITLE_COPY.cancelling,
    status: OUTCOME_LOOKUP_COPY.settling,
    buttons: [],
  },
  {
    name: 'job queued (202)',
    tag: 'job',
    snapshot: makeSnapshot(
      { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
      { actions: { refresh: true, requestDelete: true } },
    ),
    title: JOB_STATUS_COPY.queued.title,
    status: JOB_STATUS_COPY.queued.status,
    buttons: ['Delete import'],
  },
  {
    name: 'job processing',
    tag: 'job',
    snapshot: makeSnapshot(
      { tag: 'job', op: opView({ revision: 2 }), jobId: JOB_ID, status: 'processing' },
      { actions: { requestDelete: true }, activity: { reading: true } },
    ),
    title: JOB_STATUS_COPY.processing.title,
    buttons: ['Delete import'],
  },
  {
    name: 'job ready',
    tag: 'job',
    snapshot: makeSnapshot(
      { tag: 'job', op: readyOp, jobId: JOB_ID, status: 'ready' },
      { actions: { refresh: true, requestDelete: true } },
    ),
    title: JOB_STATUS_COPY.ready.title,
    buttons: ['Details: StreamBeam', 'Details: BrightGrid', 'Refresh status', 'Delete import'],
  },
  {
    name: 'delete_requested',
    tag: 'delete_requested',
    snapshot: makeSnapshot(
      { tag: 'delete_requested', op: readyOp, jobId: JOB_ID },
      { activity: { deleting: true } },
    ),
    title: VIEW_COPY.delete_requested.title,
    buttons: [],
  },
  {
    name: 'deleting',
    tag: 'deleting',
    snapshot: makeSnapshot(
      { tag: 'deleting', op: readyOp, jobId: JOB_ID },
      { actions: { refresh: true } },
    ),
    title: VIEW_COPY.deleting.title,
    buttons: [],
  },
  {
    name: 'delete_failed',
    tag: 'delete_failed',
    snapshot: makeSnapshot(
      { tag: 'delete_failed', op: readyOp, jobId: JOB_ID, cause: 'http_5xx' },
      { actions: { retryDelete: true, refresh: true } },
    ),
    title: VIEW_COPY.delete_failed.title,
    status: VIEW_COPY.delete_failed.status,
    buttons: ['Retry deletion', 'Refresh status'],
  },
  {
    name: 'deleted',
    tag: 'deleted',
    snapshot: makeSnapshot(
      {
        tag: 'deleted',
        op: opView({ revision: 5, file: { name: '', size: 112, format: 'csv', available: false } }),
        jobId: JOB_ID,
      },
      { actions: { newImport: true, pickFile: true } },
    ),
    title: VIEW_COPY.deleted.title,
    status: VIEW_COPY.deleted.status,
    buttons: ['New import'],
  },
  {
    name: 'lost',
    tag: 'lost',
    snapshot: makeSnapshot(
      { tag: 'lost', op: opView(), jobId: JOB_ID },
      { actions: { newImport: true, pickFile: true } },
    ),
    title: VIEW_COPY.lost.title,
    buttons: ['New import'],
  },
  {
    name: 'rejected_by_server',
    tag: 'rejected_by_server',
    snapshot: makeSnapshot(
      { tag: 'rejected_by_server', op: opView(), httpStatus: 415, error: 'unsupported' },
      { actions: { newImport: true, pickFile: true } },
    ),
    title: VIEW_COPY.rejected_by_server.title,
    buttons: ['New import'],
  },
  {
    name: 'cancelled',
    tag: 'cancelled',
    snapshot: makeSnapshot(
      { tag: 'cancelled', op: opView() },
      { actions: { newImport: true, pickFile: true } },
    ),
    title: VIEW_COPY.cancelled.title,
    buttons: ['New import'],
  },
];
