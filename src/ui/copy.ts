// Every user-visible string of the import screen (English only; target market Australia), in exhaustive typed tables.
// Each table is a Record keyed by a core union (view tag, job status, cause, lookup state,
// notice, action, …), so adding a state to the core without copy is a type error here.
// Interpolated strings are small pure functions next to the static text.

import type {
  ApiError,
  AvailableActions,
  DeleteFailureCause,
  ImportView,
  IgnoreReason,
  LocalRejection,
  LookupState,
  MockMode,
  Notice,
  ServerStatus,
  UnknownOutcomeCause,
  ViewSource,
} from '../core';

export type ViewTag = ImportView['tag'];
export type ActionId = keyof AvailableActions;

/** Runtime list of every view tag; the type check below fails if the core adds a tag. */
export const VIEW_TAGS = [
  'starting',
  'storage_unavailable',
  'empty',
  'preparing',
  'local_rejection',
  'confirm',
  'sending',
  'outcome_unknown',
  'job',
  'delete_requested',
  'deleting',
  'delete_failed',
  'deleted',
  'lost',
  'rejected_by_server',
  'cancelled',
] as const satisfies readonly ViewTag[];

type MissingViewTag = Exclude<ViewTag, (typeof VIEW_TAGS)[number]>;
/** Compile-time proof that VIEW_TAGS lists every tag (`never` when complete). */
export const VIEW_TAGS_COMPLETE: [MissingViewTag] extends [never] ? true : MissingViewTag = true;

export interface StateCopy {
  readonly title: string;
  readonly status: string;
}

export const APP_TITLE = 'Statement Import';

/**
 * Base copy per view tag. Tags with variants (job, outcome_unknown, local_rejection,
 * delete_failed, rejected_by_server) are refined by the tables below.
 */
export const VIEW_COPY: Readonly<Record<ViewTag, StateCopy>> = {
  starting: {
    title: 'One sec…',
    status: '',
  },
  storage_unavailable: {
    title: "I can't read my notes",
    status: 'No new imports until I can. Try again?',
  },
  empty: {
    title: 'Got another statement?',
    status: '',
  },
  preparing: {
    title: 'Taking a look…',
    status: '',
  },
  local_rejection: {
    title: "I can't use this file",
    status: 'Nothing was sent.',
  },
  confirm: {
    title: 'Send this one?',
    status: '',
  },
  sending: {
    title: 'Sending…',
    status: '',
  },
  outcome_unknown: {
    title: 'Did it get through?',
    status: '',
  },
  job: {
    title: 'The server has it',
    status: '',
  },
  delete_requested: {
    title: 'Deleting…',
    status: "It's not gone until the server confirms.",
  },
  deleting: {
    title: 'Deleting on the server…',
    status: "It's not gone until the server confirms.",
  },
  delete_failed: {
    title: 'Not deleted yet',
    status: 'Your data may still be on the server.',
  },
  deleted: {
    title: 'All gone',
    status: 'Deleted on the server and on this phone.',
  },
  lost: {
    title: "I can't find that job",
    status: "The server doesn't know it anymore, so I cleared the report here.",
  },
  rejected_by_server: {
    title: 'The server said no',
    status: '',
  },
  cancelled: {
    title: 'Cancelled',
    // A by-key 404 means "not found", not "not accepted" (TZ): one neutral wording for every cancel.
    status: 'No job was found on the server.',
  },
};

export const JOB_STATUS_COPY: Readonly<Record<ServerStatus, StateCopy>> = {
  queued: {
    title: 'In the queue',
    status: "I'll show the report here.",
  },
  processing: {
    title: 'Reading your statement…',
    status: "I'll show the report here.",
  },
  ready: {
    title: "Here's what I found",
    status: '',
  },
};

export const LOCAL_REJECTION_COPY: Readonly<Record<LocalRejection['reason'], StateCopy>> = {
  not_statement: {
    title: "That's not a statement",
    status: 'I need a PDF or CSV. Nothing was sent.',
  },
  oversize: {
    title: "That file's too big",
    status: 'I can take up to 10 MiB. Nothing was sent.',
  },
  unreadable: {
    title: "I couldn't read that file",
    status: 'Nothing was sent. Try picking it again.',
  },
};

/** Size line for an oversize rejection (null size = copy aborted at the limit). */
export function oversizeSizeText(sizeText: string | null): string {
  return sizeText === null ? 'Size: over 10 MiB' : `Size: ${sizeText}`;
}

/** What the failed attempt tells us about the server side. */
export const OUTCOME_CAUSE_COPY: Readonly<Record<UnknownOutcomeCause, string>> = {
  not_sent: 'It never left your phone.',
  unreachable: "I couldn't reach the server.",
  timeout: 'No answer in time — it may have arrived.',
  reset_after_send: 'The connection dropped — it may have arrived.',
  interrupted: 'The app closed mid-upload — it may have arrived.',
  server_error: 'Server error — a job may exist.',
};

/** State of the by-key lookup. */
export const OUTCOME_LOOKUP_COPY: Readonly<Record<LookupState, string>> = {
  pending: 'Checking with the server…',
  not_found: "Not there yet. Sending again won't make a duplicate.",
  unreachable: "Can't reach the server. Try again.",
  skipped: "Sending again won't make a duplicate.",
  settling: 'Checking whether it arrived…',
};

/** Lookup states that would suggest "Send again" when the private copy is gone. */
export const OUTCOME_NO_FILE_COPY: Readonly<Record<'not_found' | 'skipped', string>> = {
  not_found: 'Not there yet. Cancel and pick the file again.',
  skipped: 'Cancel and pick the file again.',
};

export const OUTCOME_TITLE_COPY = {
  notSent: "It didn't go out",
  unknown: 'Did it get through?',
  cancelling: 'Cancelling…',
} as const;

export const SENDING_COPY = {
  cancelling: {
    title: 'Stopping…',
    status: 'Checking whether it arrived…',
  },
  /**
   * The one automatic same-key re-POST after a by-key 404 race: honest about why it
   * happens without a tap and why it cannot create a second job.
   */
  autoRetry: {
    title: 'Trying again',
    status: "The connection dropped. This won't make a duplicate.",
  },
  /**
   * The `sending` write failed before the POST ("Send" waits for "Retry"): nothing was
   * sent, and the screen must not claim it is sending.
   */
  notStarted: {
    title: 'Not sent yet',
    status: "I couldn't save my notes first.",
  },
  progress: (percent: string): string => `Sent ${percent}`,
  resendNote: "Sending again — this won't make a duplicate.",
} as const;

export const DELETE_FAILURE_COPY: Readonly<Record<DeleteFailureCause, string>> = {
  http_5xx: 'The server returned an error to the delete request.',
  client_error: 'The server rejected the delete request.',
  not_sent: "The delete request didn't leave the device.",
  unreachable: 'The server is unreachable.',
  timeout: "The server didn't respond in time.",
  reset_after_send: 'The connection dropped during the request.',
  interrupted: 'The request was interrupted when the app was closed.',
};

export function rejectedByServerText(httpStatus: number): string {
  switch (httpStatus) {
    case 409:
      return 'This key was already used with a different file (409).';
    case 413:
      return 'The file is too large for the server (413).';
    case 415:
      return "The server didn't recognise the file format (415).";
    default:
      return `Server response code: ${httpStatus}.`;
  }
}

export const READY_COPY = {
  /** Second line of a report row: `Monthly · 1 Oct 2026`. */
  rowMeta: (cadence: string, lastSeen: string): string =>
    `${cadence.charAt(0).toUpperCase()}${cadence.slice(1)} · ${lastSeen}`,
  reportHeading: 'Recurring charges',
  totalLabel: 'Total',
  noItems: "I didn't find any recurring charges.",
  /**
   * Ready, but the report is not in memory yet: the journal never stores it (privacy), so after a
   * relaunch it is fetched again from the server (by key, then GET).
   */
  loading: 'Fetching the report…',
  /** The re-fetch failed (the stale label below says why); the core retries with backoff. */
  loadFailed: "Couldn't load the report. Retrying…",
} as const;

export function noticeText(notice: Notice): string {
  switch (notice.tag) {
    case 'config_error':
      return `The server is unreachable or its address is misconfigured (code ${notice.httpStatus}).`;
    case 'file_missing':
      return NOTICE_COPY.file_missing;
    case 'cancel_too_late':
      return NOTICE_COPY.cancel_too_late;
    case 'client_error':
      return `The server rejected the app's request (code ${notice.httpStatus}).`;
  }
}

/** Static part of every notice (exhaustive by tag). */
export const NOTICE_COPY: Readonly<Record<Notice['tag'], string>> = {
  config_error: 'The server is unreachable or its address is misconfigured',
  file_missing: 'The file is no longer available — choose it again',
  cancel_too_late:
    'Too late to cancel: the server already has the file. You can delete the import.',
  client_error: "The server rejected the app's request",
};

export const STATUS_COPY = {
  lastKnown: 'Last known status',
  recoveredByKey: 'Found it after a lost reply',
  storageError: "Couldn't save on this device. The last action didn't complete.",
  pickerFailed: "Couldn't open the file picker. Try again?",
  busy: "Let's finish this one first.",
} as const;

export interface ActionCopy {
  readonly label: string;
  readonly hint: string;
}

export const ACTION_COPY: Readonly<Record<ActionId, ActionCopy>> = {
  pickFile: { label: 'Choose file', hint: 'Opens the system file picker' },
  confirmSend: { label: 'Send', hint: 'Sends the file to the server' },
  cancelDraft: { label: 'Cancel', hint: "Doesn't send the file and deletes its copy" },
  cancelSending: {
    label: 'Cancel',
    hint: 'Stops the upload and checks whether the file arrived',
  },
  checkAgain: { label: 'Check again', hint: 'Looks up the job on the server by key' },
  resend: {
    label: 'Send again',
    hint: "Sends the same file with the same key; a second job won't be created",
  },
  abandon: { label: 'Cancel import', hint: 'Cancels the import after checking the server' },
  refresh: { label: 'Refresh status', hint: "Requests the job's current status" },
  requestDelete: {
    label: 'Delete import',
    hint: 'Asks you to confirm deleting the data on the server',
  },
  retryDelete: {
    label: 'Retry deletion',
    hint: 'Repeats the delete request with the same key',
  },
  newImport: { label: 'New import', hint: 'Returns to choosing a file' },
  retryStorage: { label: 'Retry', hint: 'Retries reading and writing the log on this device' },
};

/** Context-specific labels for the same action. */
export const ACTION_LABEL_VARIANTS = {
  pickAnother: 'Choose another file',
  close: 'Close',
  refreshShort: 'Refresh',
} as const;

export const DELETE_CONFIRM_COPY = {
  title: 'Delete import?',
  body: "The job and its report will be deleted on the server. You can't undo this.",
  confirm: 'Delete on server',
  keep: "Don't delete",
} as const;

export const STEPS = ['Choose', 'Check', 'Send', 'Processing', 'Report'] as const;
export function stepText(index: number): string {
  return `Step ${index + 1} of ${STEPS.length} · ${STEPS[index] ?? ''}`;
}
/** `Step 2 of 5` (no step name). */
export function stepCounter(index: number): string {
  return `Step ${index + 1} of ${STEPS.length}`;
}

/**
 * Billy's log of what really happened to this import (a "how I got here" trace). Every line comes
 * from a state the app observed — nothing is invented about the server's internals.
 */
export const TRACE_COPY = {
  summary: (count: number): string => `How I got here · ${count} ${count === 1 ? 'step' : 'steps'}`,
  showHint: 'Shows what happened to this import, step by step',
  restart: 'Picked up after a restart',
  sending: (size: string): string => `Sending ${size}`,
  resending: 'Sending again with the same key',
  lookup: 'Asking the server by key',
  notFound: 'Not found by key yet',
  recovered: 'Found the job by key',
  queued: 'The server queued it',
  processing: 'The server is reading it',
  ready: (count: number): string => `Report ready · ${count} ${count === 1 ? 'charge' : 'charges'}`,
  refetch: 'Fetching the report again',
  ignored: (status: string, revision: number, current: number): string =>
    `Ignored an older reply (${status} r${revision} after r${current})`,
  deleteAsked: 'Asked the server to delete',
  deleteAskedAgain: 'Asked the server to delete again',
  notStarted: "Couldn't save my notes, so nothing was sent",
  deleting: 'The server is deleting',
  deleteFailed: "Delete didn't go through",
  deleted: 'Deleted on the server',
  lost: "The server doesn't know this job",
  rejected: (code: number): string => `The server rejected it (${code})`,
  cancelled: 'Cancelled',
} as const;

/** What went wrong with a POST, as one short log line. */
export const TRACE_CAUSE_COPY: Readonly<Record<UnknownOutcomeCause, string>> = {
  not_sent: "It didn't go out",
  unreachable: "Couldn't reach the server",
  timeout: 'No reply in time',
  reset_after_send: 'The connection dropped',
  interrupted: 'The app closed mid-upload',
  server_error: 'Server error',
};

/** First empty screen of a session: Billy says hello (the onboarding). Later: VIEW_COPY.empty. */
export const EMPTY_COPY = {
  greetingTitle: "Hi, I'm Billy!",
  greetingStatus: "Send me a bank statement and I'll find your recurring charges.",
  /** Small print under the button, not the headline. */
  footnote: 'PDF or CSV · up to 10 MiB',
} as const;

export const FACT_LABELS = {
  name: 'Name',
  size: 'Size',
  format: 'Format',
  file: 'File',
} as const;

/**
 * Value of the "File" fact. Once the server has the job the device no longer stores the file name
 * (privacy: the journal is in the iOS backup), so after a relaunch only format and size are shown.
 */
export const FILE_FACT_COPY = {
  withName: (name: string, size: string, format: string): string => `${name} · ${size} · ${format}`,
  /** "File: PDF, 33.1 KiB". */
  withoutName: (format: string, size: string): string => `${format}, ${size}`,
} as const;

export const DETAILS_COPY = {
  open: 'Details',
  /** Screen-reader label: every row has the same visible text, so name the merchant. */
  openLabel: (merchant: string): string => `Details: ${merchant}`,
  openHint: 'Opens the receipt for this charge',
  title: 'Recurring charge',
  close: 'Close',
  closeHint: 'Closes the details',
  recordHeading: 'Server record',
  statusLabel: (status: string): string => `Job status: ${status}`,
  id: 'ID',
  merchant: 'Merchant',
  amountMinor: 'Amount in minor units',
  currency: 'Currency',
  cadence: 'Frequency',
  lastSeen: 'Last charged',
  jobId: 'Job',
  revision: 'Revision',
} as const;

export const PRIVACY_COVER_COPY = {
  text: 'Content hidden',
} as const;

/** Screens drawn by the composition root (src/main) instead of the import screen. */
export const FALLBACK_COPY = {
  crash: {
    title: 'Something went wrong',
    text: "The screen couldn't be shown. Try again or restart the app.",
  },
  config: {
    title: 'Server address is misconfigured',
    text:
      'EXPO_PUBLIC_MOCK_URL must look like http://host:port with no path. ' +
      'Fix the value and rebuild the app (in a dev build, restarting Metro is enough).',
  },
  retry: 'Try again',
  retryHint: 'Shows the import screen again',
} as const;

// ---------------------------------------------------------------------------------------------
// Diagnostics (dev tool)

export const MOCK_MODE_COPY: Readonly<Record<MockMode, string>> = {
  happy: 'happy',
  lost_ack: 'lost_ack',
  stale_status: 'stale_status',
  delete_failure: 'delete_failure',
};

export const VIEW_SOURCE_COPY: Readonly<Record<ViewSource, string>> = {
  post: 'POST',
  by_key: 'by key',
  get: 'GET',
  delete: 'DELETE',
};

export const IGNORE_REASON_COPY: Readonly<Record<IgnoreReason, string>> = {
  stale_revision: 'stale revision',
  tombstone: 'after the delete request',
  terminal: 'operation finished',
  unexpected: 'unexpected response',
};

export const DIAGNOSTICS_COPY = {
  toggleOpen: 'Diagnostics (dev) — show',
  toggleClose: 'Diagnostics (dev) — hide',
  toggleHint: 'Developer tool: mock scenarios and counters',
  baseUrl: 'Server address',
  mode: 'Current scenario',
  modeUnknown: 'unknown',
  scenarios: 'Mock scenario',
  scenarioHint: (mode: string): string => `Switches the mock to the ${mode} scenario`,
  counters: 'Mock counters',
  jobs: 'Jobs on the server',
  noJobs: 'No jobs',
  jobLine: (jobId: string, status: string, revision: number, bytes: number): string =>
    `${jobId}: ${status} r${revision}, ${bytes} B`,
  localSize: 'Local file size',
  localState: 'Local state',
  noValue: '—',
  lastRawView: 'Last server response',
  ignored: 'Discarded responses',
  extraOps: 'Extra operations in the log',
  reload: 'Refresh diagnostics',
  reloadHint: 'Re-reads the mock state',
  loading: 'Loading the mock state…',
  reset: 'Reset mock and local state',
  resetHint: 'Asks for confirmation',
  resetConfirmTitle: 'Reset mock and local state?',
  resetConfirmBody:
    'Any upload will be stopped and the mock reset. Local operations are deleted only if the mock reset succeeds.',
  resetConfirm: 'Reset',
  resetCancel: "Don't reset",
  resetDone: 'Mock and local state have been reset.',
  resetFailed: 'Reset failed, local state kept',
  requestFailed: 'Request failed',
} as const;

const TRANSPORT_CAUSE_COPY: Readonly<Record<UnknownOutcomeCause, string>> = {
  not_sent: 'request not sent',
  unreachable: 'server unreachable',
  timeout: 'no response in time',
  reset_after_send: 'connection dropped',
  interrupted: 'request interrupted',
  server_error: 'server error',
};

/** Short reason for a failed read / diagnostics request (no URLs, no names). */
export function apiErrorText(error: ApiError): string {
  switch (error.kind) {
    case 'transport':
      return TRANSPORT_CAUSE_COPY[error.cause];
    case 'config':
      return `address misconfigured (code ${error.httpStatus})`;
    case 'server':
      return `server error (code ${error.httpStatus})`;
    case 'protocol':
      return `unexpected server response (code ${error.httpStatus})`;
  }
}
