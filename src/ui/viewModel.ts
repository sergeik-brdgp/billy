// Pure view model: controller snapshot → what the screen shows.
// No React here, so every state's copy and buttons are unit-testable without rendering.
//
// Button rule: each view lists its candidate actions (display order + style). A candidate is
// shown when `snapshot.actions[id]` is true, or — disabled and marked busy — while a request of
// its own kind is in flight (so a button does not vanish and shift the layout under a finger
// mid-tap). Whether a button is ENABLED comes only from `snapshot.actions`.

import {
  assertNever,
  formatDate,
  formatCadence,
  formatFileFormat,
  formatItemLine,
  formatMoney,
  formatMonthlyTotal,
  formatPercent,
  formatSize,
  type ImportSnapshot,
  type ImportView,
  type JobId,
  type OperationView,
  type ReadyItem,
} from '../core';
import {
  ACTION_COPY,
  ACTION_LABEL_VARIANTS,
  DELETE_FAILURE_COPY,
  DETAILS_COPY,
  EMPTY_COPY,
  FACT_LABELS,
  FILE_FACT_COPY,
  JOB_STATUS_COPY,
  LOCAL_REJECTION_COPY,
  NOTICE_COPY,
  OUTCOME_CAUSE_COPY,
  OUTCOME_LOOKUP_COPY,
  OUTCOME_NO_FILE_COPY,
  OUTCOME_TITLE_COPY,
  READY_COPY,
  SENDING_COPY,
  STATUS_COPY,
  VIEW_COPY,
  apiErrorText,
  noticeText,
  oversizeSizeText,
  rejectedByServerText,
  stepText,
  type ActionId,
  type ViewTag,
} from './copy';
import type { Tone } from './theme';

export type ButtonKind = 'primary' | 'secondary' | 'destructive';

export interface ButtonModel {
  readonly id: ActionId;
  readonly label: string;
  readonly hint: string;
  readonly kind: ButtonKind;
  readonly enabled: boolean;
  /** Shown disabled because a request of its own kind is in flight. */
  readonly busy: boolean;
}

export interface Fact {
  readonly label: string;
  readonly value: string;
  /** Short value: sits beside the next short fact in one row (size · format). */
  readonly short?: boolean;
}

export interface ReportRow {
  readonly id: string;
  /** The whole row as one sentence (screen-reader label). */
  readonly line: string;
  readonly merchant: string;
  /** `19.99 AUD`. */
  readonly amount: string;
  /** `Monthly · 1 Oct 2026`. */
  readonly meta: string;
}

export interface ReportModel {
  readonly heading: string;
  readonly rows: readonly ReportRow[];
  readonly totalLabel: string;
  /** `151.99 AUD/month`. */
  readonly total: string;
}

/** One field of the server record exactly as the API sent it (`amountMinor` → `1999`). */
export interface RecordField {
  /** The API field name, shown as is. */
  readonly key: string;
  /** What screen readers say instead of the API name. */
  readonly label: string;
  readonly value: string;
}

/**
 * The "Details" card: a receipt in words (formatted) plus the raw server record. Together they
 * cover every server field of the item; nothing here offers to change or cancel anything.
 */
export interface ReceiptModel {
  readonly merchant: string;
  /** Position in the report: the avatar keeps the row's colour. */
  readonly position: number;
  /** `19.99 AUD`. */
  readonly amount: string;
  /** Last charged / Frequency, formatted (the currency is in the amount). */
  readonly summary: readonly Fact[];
  readonly record: readonly RecordField[];
  /** Job status the record belongs to (only a ready job has items). */
  readonly status: 'ready';
}

export interface StepModel {
  readonly index: number;
  readonly count: number;
  readonly text: string;
  /** The current step ended in an error (local rejection). */
  readonly failed: boolean;
}

export interface ProgressModel {
  /** 0..1, or null while the total is unknown (indeterminate). */
  readonly fraction: number | null;
  readonly text: string | null;
}

export interface ScreenModel {
  readonly tag: ViewTag;
  readonly step: StepModel | null;
  readonly title: string;
  /** Live-region status line. */
  readonly statusText: string;
  /** Secondary explanation (cause, size, …). */
  readonly detail: string | null;
  readonly tone: Tone;
  /** Set when the last read failed: the status is the last known one. */
  readonly stale: { readonly label: string; readonly reason: string } | null;
  readonly badge: string | null;
  readonly notice: string | null;
  readonly facts: readonly Fact[];
  /** Small print under the actions (e.g. accepted files on the empty screen). */
  readonly footnote: string | null;
  readonly progress: ProgressModel | null;
  readonly report: ReportModel | null;
  readonly buttons: readonly ButtonModel[];
  readonly storageBanner: { readonly text: string; readonly retry: ButtonModel | null } | null;
  /**
   * Changes only when the phase changes (not on progress ticks, not on the settle re-checks of
   * an abandon): drives the phase announcement.
   */
  readonly announceKey: string;
  /** `title. status` — what a screen reader hears on a phase change (both platforms). */
  readonly announcement: string;
  /**
   * Other lines a screen reader must hear when they appear or change: storage error, notice,
   * recovered-by-key badge, "Last known status" (in this order).
   */
  readonly announceExtras: readonly string[];
}

/**
 * What to announce when the screen model goes from `prev` to `next` (null: nothing). Not on the
 * first render (the screen is read anyway), only lines that are new, and the phase only when its
 * key changed. iOS speaks this through `announceForAccessibility`; Android hears the same lines
 * through the live regions on the status block and the notice boxes.
 */
export function announcementFor(
  prev: Pick<ScreenModel, 'announceKey' | 'announcement' | 'announceExtras'> | null,
  next: Pick<ScreenModel, 'announceKey' | 'announcement' | 'announceExtras'>,
): string | null {
  if (prev === null) return null;
  const parts = next.announceExtras.filter((line) => !prev.announceExtras.includes(line));
  if (next.announceKey !== prev.announceKey) parts.push(next.announcement);
  return parts.length === 0 ? null : parts.join(' ');
}

/** Screen-local state the core does not know about. */
export interface LocalUiState {
  readonly pickError: 'failed' | 'busy' | null;
  /**
   * The first empty screen of this app session: Billy says hello (the whole onboarding). Kept in
   * memory only — no "seen" flag on disk, so a cold start never branches on anything but the journal.
   */
  readonly greeting?: boolean;
}

const NO_LOCAL_STATE: LocalUiState = { pickError: null };

interface Candidate {
  readonly id: ActionId;
  readonly kind: ButtonKind;
  readonly label?: string;
}

interface Base {
  readonly title: string;
  readonly statusText: string;
  readonly detail: string | null;
  readonly tone: Tone;
  readonly step: number | null;
  readonly failed?: boolean;
  readonly variant: string;
  readonly candidates: readonly Candidate[];
  readonly facts?: readonly Fact[];
  readonly progress?: ProgressModel | null;
  readonly report?: ReportModel | null;
  readonly op?: OperationView;
}

const STEP_COUNT = 5;

function fileFacts(op: OperationView): readonly Fact[] {
  const size = formatSize(op.file.size);
  const format = formatFileFormat(op.file.format);
  // No name once the server has the job and the app was relaunched (it is not in the journal).
  const value =
    op.file.name === ''
      ? FILE_FACT_COPY.withoutName(format, size)
      : FILE_FACT_COPY.withName(op.file.name, size, format);
  return [{ label: FACT_LABELS.file, value }];
}

export function reportModel(op: OperationView): ReportModel | null {
  const result = op.result;
  if (result === null) return null;
  return {
    heading: READY_COPY.reportHeading,
    rows: result.items.map((item) => ({
      id: item.id,
      line: formatItemLine(item, result.currency),
      merchant: item.merchant,
      amount: formatMoney(item.amountMinor, result.currency),
      meta: READY_COPY.rowMeta(formatCadence(item.cadence), formatDate(item.lastSeen)),
    })),
    totalLabel: READY_COPY.totalLabel,
    total: formatMonthlyTotal(result),
  };
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The "Details" card for one report item: the receipt (formatted) and the server record (raw,
 * every field the API sent for the item plus the job it came from).
 */
export function itemReceipt(
  item: ReadyItem,
  position: number,
  currency: string,
  jobId: JobId,
  revision: number,
): ReceiptModel {
  return {
    merchant: item.merchant,
    position,
    amount: formatMoney(item.amountMinor, currency),
    summary: [
      { label: DETAILS_COPY.lastSeen, value: formatDate(item.lastSeen) },
      { label: DETAILS_COPY.cadence, value: capitalise(formatCadence(item.cadence)) },
    ],
    record: [
      { key: 'id', label: DETAILS_COPY.id, value: item.id },
      { key: 'merchant', label: DETAILS_COPY.merchant, value: item.merchant },
      { key: 'amountMinor', label: DETAILS_COPY.amountMinor, value: String(item.amountMinor) },
      { key: 'currency', label: DETAILS_COPY.currency, value: currency },
      { key: 'cadence', label: DETAILS_COPY.cadence, value: item.cadence },
      { key: 'lastSeen', label: DETAILS_COPY.lastSeen, value: item.lastSeen },
      { key: 'jobId', label: DETAILS_COPY.jobId, value: jobId },
      { key: 'revision', label: DETAILS_COPY.revision, value: String(revision) },
    ],
    status: 'ready',
  };
}

function outcomeTitle(view: Extract<ImportView, { tag: 'outcome_unknown' }>): string {
  if (view.abandon || view.lookup === 'settling') return OUTCOME_TITLE_COPY.cancelling;
  if (view.cause === 'not_sent' || view.cause === 'unreachable') return OUTCOME_TITLE_COPY.notSent;
  return OUTCOME_TITLE_COPY.unknown;
}

/**
 * While an abandon is being checked the core cycles the lookup pending → settling → pending (the
 * by-key re-checks after 1 s / 3 s / 10 s). For the user that is one step, "checking": one
 * stable status line and one announcement for the whole settle window, no flicker.
 */
function abandonChecking(view: Extract<ImportView, { tag: 'outcome_unknown' }>): boolean {
  return view.abandon && (view.lookup === 'pending' || view.lookup === 'settling');
}

function outcomeStatus(view: Extract<ImportView, { tag: 'outcome_unknown' }>): string {
  if (abandonChecking(view)) return OUTCOME_LOOKUP_COPY.settling;
  // Without the private copy "Send again" is impossible: do not suggest it.
  if (!view.op.file.available && (view.lookup === 'not_found' || view.lookup === 'skipped')) {
    return OUTCOME_NO_FILE_COPY[view.lookup];
  }
  return OUTCOME_LOOKUP_COPY[view.lookup];
}

function baseFor(snapshot: ImportSnapshot): Base {
  const view = snapshot.view;
  const refreshIfStale: readonly Candidate[] =
    snapshot.readError !== null
      ? [{ id: 'refresh', kind: 'secondary', label: ACTION_LABEL_VARIANTS.refreshShort }]
      : [];
  switch (view.tag) {
    case 'starting':
      return {
        ...copyOf('starting'),
        detail: null,
        tone: 'neutral',
        step: null,
        variant: '',
        candidates: [],
      };
    case 'storage_unavailable':
      return {
        ...copyOf('storage_unavailable'),
        detail: null,
        tone: 'danger',
        step: null,
        variant: '',
        candidates: [{ id: 'retryStorage', kind: 'primary' }],
      };
    case 'empty':
      return {
        ...copyOf('empty'),
        detail: null,
        tone: 'neutral',
        step: 0,
        variant: '',
        candidates: [{ id: 'pickFile', kind: 'primary' }],
      };
    case 'preparing':
      return {
        ...copyOf('preparing'),
        detail: null,
        tone: 'progress',
        step: 1,
        variant: '',
        candidates: [],
      };
    case 'local_rejection': {
      const rejection = view.rejection;
      const copy = LOCAL_REJECTION_COPY[rejection.reason];
      return {
        title: copy.title,
        statusText: copy.status,
        detail:
          rejection.reason === 'oversize'
            ? oversizeSizeText(rejection.size === null ? null : formatSize(rejection.size))
            : null,
        tone: 'danger',
        step: 1,
        failed: true,
        variant: rejection.reason,
        candidates: [
          { id: 'pickFile', kind: 'primary', label: ACTION_LABEL_VARIANTS.pickAnother },
          { id: 'newImport', kind: 'secondary', label: ACTION_LABEL_VARIANTS.close },
        ],
      };
    }
    case 'confirm':
      return {
        ...copyOf('confirm'),
        detail: null,
        tone: 'neutral',
        step: 1,
        variant: '',
        candidates: [
          { id: 'confirmSend', kind: 'primary' },
          { id: 'cancelDraft', kind: 'secondary' },
        ],
        facts: [
          { label: FACT_LABELS.name, value: view.draft.name },
          { label: FACT_LABELS.size, value: formatSize(view.draft.size), short: true },
          { label: FACT_LABELS.format, value: formatFileFormat(view.draft.format), short: true },
        ],
      };
    case 'sending': {
      const progress = view.progress;
      const percent =
        progress === null ? null : formatPercent(progress.bytesSent, progress.totalBytes);
      const fraction =
        progress !== null && progress.totalBytes > 0
          ? Math.min(1, Math.max(0, progress.bytesSent / progress.totalBytes))
          : null;
      const notStarted = view.notStarted && snapshot.storageError;
      const copy = notStarted
        ? SENDING_COPY.notStarted
        : view.cancelRequested
          ? SENDING_COPY.cancelling
          : view.autoRetry
            ? SENDING_COPY.autoRetry
            : VIEW_COPY.sending;
      return {
        title: copy.title,
        statusText: copy.status,
        // The auto-retry status already says "same key"; the note is for a tapped resend.
        detail: view.attempt > 1 && !view.autoRetry ? SENDING_COPY.resendNote : null,
        tone: 'progress',
        step: 2,
        variant: notStarted
          ? 'not_started'
          : view.cancelRequested
            ? 'cancelling'
            : view.autoRetry
              ? 'auto_retry'
              : 'active',
        candidates: [{ id: 'cancelSending', kind: 'secondary' }],
        facts: fileFacts(view.op),
        progress: notStarted
          ? null
          : {
              fraction,
              text: percent === null ? null : SENDING_COPY.progress(percent),
            },
        op: view.op,
      };
    }
    case 'outcome_unknown':
      return {
        title: outcomeTitle(view),
        statusText: outcomeStatus(view),
        detail: OUTCOME_CAUSE_COPY[view.cause],
        tone: 'warning',
        step: 2,
        variant: `${view.cause}:${abandonChecking(view) ? 'abandon_checking' : `${view.lookup}:${view.abandon ? 'abandon' : 'open'}`}`,
        candidates: [
          { id: 'checkAgain', kind: 'primary' },
          { id: 'resend', kind: 'secondary' },
          { id: 'abandon', kind: 'secondary' },
        ],
        facts: fileFacts(view.op),
        op: view.op,
      };
    case 'job': {
      const copy = JOB_STATUS_COPY[view.status];
      const report = view.status === 'ready' ? reportModel(view.op) : null;
      // Ready without the report in memory (after a relaunch): "loading" only while the last read
      // did not fail; otherwise say it failed — nothing is pretending to load.
      const reportLoadFailed =
        view.status === 'ready' && report === null && snapshot.readError !== null;
      const deleteCandidate: Candidate = { id: 'requestDelete', kind: 'destructive' };
      return {
        title: copy.title,
        statusText: reportLoadFailed
          ? READY_COPY.loadFailed
          : view.status === 'ready' && report === null
            ? READY_COPY.loading
            : report === null
              ? copy.status
              : report.rows.length === 0
                ? READY_COPY.noItems
                : '',
        detail: view.status === 'ready' && report === null ? copy.status : null,
        tone: view.status === 'ready' ? 'success' : 'progress',
        step: view.status === 'ready' ? 4 : 3,
        variant: reportLoadFailed ? 'ready:load_failed' : view.status,
        candidates:
          view.status === 'ready'
            ? [{ id: 'refresh', kind: 'secondary' }, deleteCandidate]
            : [...refreshIfStale, deleteCandidate],
        facts: fileFacts(view.op),
        report,
        op: view.op,
      };
    }
    case 'delete_requested':
      return {
        ...copyOf('delete_requested'),
        detail: null,
        tone: 'progress',
        step: 4,
        variant: '',
        candidates: [],
        op: view.op,
      };
    case 'deleting':
      return {
        ...copyOf('deleting'),
        detail: null,
        tone: 'progress',
        step: 4,
        variant: '',
        candidates: refreshIfStale,
        op: view.op,
      };
    case 'delete_failed':
      return {
        ...copyOf('delete_failed'),
        detail: DELETE_FAILURE_COPY[view.cause],
        tone: 'danger',
        step: 4,
        variant: view.cause,
        candidates: [
          { id: 'retryDelete', kind: 'primary' },
          { id: 'refresh', kind: 'secondary' },
        ],
        op: view.op,
      };
    case 'deleted':
      return {
        ...copyOf('deleted'),
        detail: null,
        tone: 'success',
        step: null,
        variant: '',
        candidates: [{ id: 'newImport', kind: 'primary' }],
      };
    case 'lost':
      return {
        ...copyOf('lost'),
        detail: null,
        tone: 'warning',
        step: null,
        variant: '',
        candidates: [{ id: 'newImport', kind: 'primary' }],
      };
    case 'rejected_by_server':
      return {
        ...copyOf('rejected_by_server'),
        detail: rejectedByServerText(view.httpStatus),
        tone: 'danger',
        step: null,
        variant: String(view.httpStatus),
        candidates: [{ id: 'newImport', kind: 'primary' }],
      };
    case 'cancelled':
      return {
        ...copyOf('cancelled'),
        detail: null,
        tone: 'neutral',
        step: null,
        variant: '',
        candidates: [{ id: 'newImport', kind: 'primary' }],
      };
    default:
      return assertNever(view, 'view');
  }
}

function copyOf(tag: ViewTag): { readonly title: string; readonly statusText: string } {
  const copy = VIEW_COPY[tag];
  return { title: copy.title, statusText: copy.status };
}

/** A request of this action's own kind is running (the button stays, disabled + busy). */
function blockedByOwnRequest(id: ActionId, snapshot: ImportSnapshot): boolean {
  switch (id) {
    case 'refresh':
    case 'checkAgain':
      return snapshot.activity.reading;
    case 'requestDelete':
    case 'retryDelete':
      return snapshot.activity.deleting;
    case 'cancelSending':
      return snapshot.activity.posting;
    case 'pickFile':
    case 'confirmSend':
    case 'cancelDraft':
    case 'resend':
    case 'abandon':
    case 'newImport':
    case 'retryStorage':
      return false;
    default:
      return assertNever(id, 'action');
  }
}

function toButton(candidate: Candidate, snapshot: ImportSnapshot): ButtonModel | null {
  const enabled = snapshot.actions[candidate.id];
  // While storage is broken every other action is off (core rule): show only "Retry".
  const busy =
    !enabled && !snapshot.actions.retryStorage && blockedByOwnRequest(candidate.id, snapshot);
  if (!enabled && !busy) return null;
  const copy = ACTION_COPY[candidate.id];
  return {
    id: candidate.id,
    label: candidate.label ?? copy.label,
    hint: copy.hint,
    kind: candidate.kind,
    enabled,
    busy,
  };
}

export function buildScreenModel(
  snapshot: ImportSnapshot,
  local: LocalUiState = NO_LOCAL_STATE,
): ScreenModel {
  const view = snapshot.view;
  const greeting = view.tag === 'empty' && local.greeting === true;
  const base: Base = greeting
    ? {
        ...baseFor(snapshot),
        title: EMPTY_COPY.greetingTitle,
        statusText: EMPTY_COPY.greetingStatus,
        variant: 'greeting',
      }
    : baseFor(snapshot);
  const buttons = base.candidates
    .map((candidate) => toButton(candidate, snapshot))
    .filter((button): button is ButtonModel => button !== null);

  let notice: string | null = null;
  if (snapshot.notice !== null) notice = noticeText(snapshot.notice);
  else if (view.tag === 'outcome_unknown' && !view.op.file.available) {
    notice = NOTICE_COPY.file_missing;
  } else if (local.pickError === 'failed') notice = STATUS_COPY.pickerFailed;
  else if (local.pickError === 'busy') notice = STATUS_COPY.busy;

  const op = base.op;
  const storageBanner =
    snapshot.storageError && view.tag !== 'storage_unavailable'
      ? {
          text: STATUS_COPY.storageError,
          retry: toButton({ id: 'retryStorage', kind: 'primary' }, snapshot),
        }
      : null;

  const badge = op?.recoveredByKey === true ? STATUS_COPY.recoveredByKey : null;
  const stale =
    snapshot.readError !== null
      ? { label: STATUS_COPY.lastKnown, reason: apiErrorText(snapshot.readError.error) }
      : null;
  const announceExtras = [
    storageBanner?.text ?? null,
    notice,
    badge,
    stale === null ? null : `${stale.label}: ${stale.reason}.`,
  ].filter((line): line is string => line !== null);

  return {
    tag: view.tag,
    step:
      base.step === null
        ? null
        : {
            index: base.step,
            count: STEP_COUNT,
            text: stepText(base.step),
            failed: base.failed ?? false,
          },
    title: base.title,
    statusText: base.statusText,
    detail: base.detail,
    tone: base.tone,
    stale,
    badge,
    notice,
    facts: base.facts ?? [],
    footnote: view.tag === 'empty' ? EMPTY_COPY.footnote : null,
    progress: base.progress ?? null,
    report: base.report ?? null,
    buttons,
    storageBanner,
    announceKey: `${view.tag}:${base.variant}`,
    // The title alone when it says everything (no empty status line, no dangling period).
    // Titles that already end in punctuation («Sending…», «Did it get through?») get no extra period.
    announcement:
      base.statusText === ''
        ? base.title
        : `${base.title}${/[.…!?]$/.test(base.title) ? '' : '.'} ${base.statusText}`,
    announceExtras,
  };
}
