// Pure view-model and copy-table tests (no rendering).

import type { ImportView, LookupState, UnknownOutcomeCause } from '../core';
import {
  ACTION_COPY,
  APP_TITLE,
  DETAILS_COPY,
  EMPTY_COPY,
  FACT_LABELS,
  JOB_STATUS_COPY,
  LOCAL_REJECTION_COPY,
  NOTICE_COPY,
  READY_COPY,
  SENDING_COPY,
  STATUS_COPY,
  STEPS,
  VIEW_COPY,
  VIEW_TAGS,
  VIEW_TAGS_COMPLETE,
  stepCounter,
  stepText,
  type ViewTag,
} from './copy';
import { STATE_CASES } from './test-utils/cases';
import { JOB_ID, OP_ID, READY_RESULT, makeSnapshot, opView } from './test-utils/fakeController';
import { announcementFor, buildScreenModel, itemReceipt } from './viewModel';

const CAUSES: readonly UnknownOutcomeCause[] = [
  'not_sent',
  'unreachable',
  'timeout',
  'reset_after_send',
  'interrupted',
  'server_error',
];
const LOOKUPS: readonly LookupState[] = [
  'pending',
  'not_found',
  'unreachable',
  'skipped',
  'settling',
];

describe('copy table', () => {
  it('has an entry for every view tag (type level + runtime)', () => {
    // Type level: VIEW_TAGS_COMPLETE only accepts `true` when VIEW_TAGS lists every tag, and
    // VIEW_COPY is a Record<ViewTag, …>, so a missing tag does not compile.
    const complete: true = VIEW_TAGS_COMPLETE;
    expect(complete).toBe(true);
    expect(Object.keys(VIEW_COPY).sort()).toEqual([...VIEW_TAGS].sort());
    for (const tag of VIEW_TAGS) {
      expect(VIEW_COPY[tag].title.length).toBeGreaterThan(0);
      // The status line is optional: empty when the title says everything.
      expect(VIEW_COPY[tag].status).not.toBe(VIEW_COPY[tag].title);
    }
  });

  it('the render cases cover every view tag', () => {
    const covered = new Set<ViewTag>(STATE_CASES.map((state) => state.tag));
    expect([...covered].sort()).toEqual([...VIEW_TAGS].sort());
  });

  it('uses the exact required wording', () => {
    expect(LOCAL_REJECTION_COPY.not_statement.title).toBe("That's not a statement");
    expect(LOCAL_REJECTION_COPY.not_statement.status).toBe(
      'I need a PDF or CSV. Nothing was sent.',
    );
    expect(LOCAL_REJECTION_COPY.oversize.title).toBe("That file's too big");
    expect(LOCAL_REJECTION_COPY.oversize.status).toBe('I can take up to 10 MiB. Nothing was sent.');
    expect(NOTICE_COPY.file_missing).toBe('The file is no longer available — choose it again');
    expect(VIEW_COPY.empty.title).toBe('Got another statement?');
    expect(EMPTY_COPY.greetingTitle).toBe("Hi, I'm Billy!");
    expect(EMPTY_COPY.greetingStatus).toBe(
      "Send me a bank statement and I'll find your recurring charges.",
    );
    expect(EMPTY_COPY.footnote).toBe('PDF or CSV · up to 10 MiB');
    expect(VIEW_COPY.confirm.title).toBe('Send this one?');
    expect(JOB_STATUS_COPY.queued).toEqual({
      title: 'In the queue',
      status: "I'll show the report here.",
    });
    expect(JOB_STATUS_COPY.processing.title).toBe('Reading your statement…');
    expect(JOB_STATUS_COPY.ready).toEqual({ title: "Here's what I found", status: '' });
    // "Deleted" is said only once the server confirmed it; every earlier step says "not yet".
    expect(VIEW_COPY.deleted).toEqual({
      title: 'All gone',
      status: 'Deleted on the server and on this phone.',
    });
    expect(VIEW_COPY.delete_failed).toEqual({
      title: 'Not deleted yet',
      status: 'Your data may still be on the server.',
    });
    expect(STATUS_COPY.recoveredByKey).toBe('Found it after a lost reply');
    expect(READY_COPY.totalLabel).toBe('Total');
    expect(ACTION_COPY.retryDelete.label).toBe('Retry deletion');
    expect(ACTION_COPY.newImport.label).toBe('New import');
    expect(APP_TITLE).toBe('Statement Import');
    expect(DETAILS_COPY.open).toBe('Details');
    expect(DETAILS_COPY.openLabel('StreamBeam')).toBe('Details: StreamBeam');
  });

  it('steps: names, counter and full step line', () => {
    expect(STEPS).toEqual(['Choose', 'Check', 'Send', 'Processing', 'Report']);
    expect(stepCounter(0)).toBe('Step 1 of 5');
    expect(stepCounter(4)).toBe('Step 5 of 5');
    expect(stepText(3)).toBe('Step 4 of 5 · Processing');
  });
});

describe('buildScreenModel', () => {
  it('every outcome_unknown cause × lookup has a title, a status and a cause line', () => {
    for (const cause of CAUSES) {
      for (const lookup of LOOKUPS) {
        for (const abandon of [false, true]) {
          const model = buildScreenModel(
            makeSnapshot({
              tag: 'outcome_unknown',
              op: opView(),
              cause,
              lookup,
              attempt: 1,
              abandon,
            }),
          );
          expect(model.title).not.toBe('');
          expect(model.statusText).not.toBe('');
          expect(model.detail).not.toBeNull();
          expect(model.tone).toBe('warning');
        }
      }
    }
  });

  it('settling reads "Checking whether it arrived…"', () => {
    const model = buildScreenModel(
      makeSnapshot({
        tag: 'outcome_unknown',
        op: opView(),
        cause: 'timeout',
        lookup: 'settling',
        attempt: 1,
        abandon: true,
      }),
    );
    expect(model.statusText).toBe('Checking whether it arrived…');
    expect(model.buttons).toEqual([]);
  });

  it('nothing-sent causes are told truthfully', () => {
    const model = buildScreenModel(
      makeSnapshot({
        tag: 'outcome_unknown',
        op: opView(),
        cause: 'not_sent',
        lookup: 'skipped',
        attempt: 1,
        abandon: false,
      }),
    );
    expect(model.title).toBe("It didn't go out");
    expect(model.detail).toBe('It never left your phone.');
  });

  it('buttons follow snapshot.actions only (hidden when not allowed)', () => {
    const view: ImportView = {
      tag: 'outcome_unknown',
      op: opView(),
      cause: 'timeout',
      lookup: 'not_found',
      attempt: 1,
      abandon: false,
    };
    expect(buildScreenModel(makeSnapshot(view)).buttons).toEqual([]);
    const ids = buildScreenModel(makeSnapshot(view, { actions: { resend: true } })).buttons.map(
      (button) => button.id,
    );
    expect(ids).toEqual(['resend']);
  });

  it('a button blocked by its own request stays visible, disabled and busy', () => {
    const model = buildScreenModel(
      makeSnapshot(
        { tag: 'job', op: opView({ result: READY_RESULT }), jobId: JOB_ID, status: 'ready' },
        { actions: { requestDelete: true }, activity: { reading: true } },
      ),
    );
    expect(model.buttons.map((b) => [b.id, b.enabled, b.busy])).toEqual([
      ['refresh', false, true],
      ['requestDelete', true, false],
    ]);
  });

  it('a storage error leaves only "Повторить"', () => {
    const model = buildScreenModel(
      makeSnapshot(
        { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
        { actions: { retryStorage: true }, activity: { reading: true }, storageError: true },
      ),
    );
    expect(model.buttons).toEqual([]);
    expect(model.storageBanner?.retry?.id).toBe('retryStorage');
  });

  it('queued has no report; ready has rows and the exact total', () => {
    const queued = buildScreenModel(
      makeSnapshot({
        tag: 'job',
        op: opView({ result: READY_RESULT }),
        jobId: JOB_ID,
        status: 'queued',
      }),
    );
    expect(queued.report).toBeNull();
    const ready = buildScreenModel(
      makeSnapshot({
        tag: 'job',
        op: opView({ result: READY_RESULT }),
        jobId: JOB_ID,
        status: 'ready',
      }),
    );
    expect(ready.report?.total).toBe('151.99 AUD/month');
    expect(ready.report?.rows.map((row) => row.line)).toEqual([
      'StreamBeam — 19.99 AUD, monthly, last charged 1 Oct 2026',
      'BrightGrid — 132.00 AUD, monthly, last charged 3 Oct 2026',
    ]);
  });

  it('announces on phase change only, not on progress ticks', () => {
    const at = (bytesSent: number) =>
      buildScreenModel(
        makeSnapshot({
          tag: 'sending',
          op: opView(),
          attempt: 1,
          progress: { bytesSent, totalBytes: 100 },
          cancelRequested: false,
          autoRetry: false,
          notStarted: false,
        }),
      );
    expect(at(10).announceKey).toBe(at(90).announceKey);
    expect(at(10).progress?.text).toBe('Sent 10%');
    expect(at(90).progress?.fraction).toBeCloseTo(0.9);
  });

  it('automatic same-key re-POST: honest status line, own phase key, cancel still wins', () => {
    const sending = (autoRetry: boolean, cancelRequested = false, attempt = 2) =>
      buildScreenModel(
        makeSnapshot(
          {
            tag: 'sending',
            op: opView(),
            attempt,
            progress: { bytesSent: 10, totalBytes: 100 },
            cancelRequested,
            autoRetry,
            notStarted: false,
          },
          { actions: { cancelSending: !cancelRequested }, activity: { posting: true } },
        ),
      );
    const auto = sending(true);
    expect(auto.title).toBe(SENDING_COPY.autoRetry.title);
    expect(auto.statusText).toBe("The connection dropped. This won't make a duplicate.");
    expect(auto.detail).toBeNull();
    expect(auto.announcement).toBe(
      "Trying again. The connection dropped. This won't make a duplicate.",
    );
    expect(auto.buttons.map((b) => [b.id, b.enabled])).toEqual([['cancelSending', true]]);
    // A tapped resend keeps the plain copy + the "same key" note; the keys differ (announced).
    const tapped = sending(false);
    expect(tapped.title).toBe(VIEW_COPY.sending.title);
    expect(tapped.detail).toBe(SENDING_COPY.resendNote);
    expect(auto.announceKey).not.toBe(tapped.announceKey);
    // "Cancel" during the automatic re-POST: the cancelling copy wins.
    expect(sending(true, true).title).toBe(SENDING_COPY.cancelling.title);
  });

  it('abandon checking keeps one phase key and one status across pending ↔ settling', () => {
    const at = (lookup: LookupState) =>
      buildScreenModel(
        makeSnapshot({
          tag: 'outcome_unknown',
          op: opView(),
          cause: 'timeout',
          lookup,
          attempt: 1,
          abandon: true,
        }),
      );
    expect(at('pending').announceKey).toBe(at('settling').announceKey);
    expect(at('pending').statusText).toBe(at('settling').statusText);
    // A failed check is a different phase (the user can act again).
    expect(at('unreachable').announceKey).not.toBe(at('pending').announceKey);
  });

  it('announcement: no extra period after a title that already ends in punctuation', () => {
    const processing = buildScreenModel(
      makeSnapshot({
        tag: 'job',
        op: opView({ revision: 2 }),
        jobId: JOB_ID,
        status: 'processing',
      }),
    );
    expect(processing.announcement).toBe("Reading your statement… I'll show the report here.");
    const queued = buildScreenModel(
      makeSnapshot({ tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' }),
    );
    expect(queued.announcement).toBe("In the queue. I'll show the report here.");
  });

  it('announcementFor: nothing on mount, only new lines, the phase only when its key changes', () => {
    const base = { announceKey: 'job:queued', announcement: 'Queued. …', announceExtras: [] };
    expect(announcementFor(null, base)).toBeNull();
    expect(announcementFor(base, { ...base })).toBeNull();
    expect(announcementFor(base, { ...base, announceExtras: ['Notice'] })).toBe('Notice');
    expect(
      announcementFor(
        { ...base, announceExtras: ['Notice'] },
        { ...base, announceExtras: ['Notice', 'Stale'] },
      ),
    ).toBe('Stale');
    expect(
      announcementFor(base, {
        announceKey: 'job:ready',
        announcement: 'Report ready. …',
        announceExtras: ['Badge'],
      }),
    ).toBe('Badge Report ready. …');
  });

  it('a ready job with no items says so instead of "Recurring charges: 0"', () => {
    const model = buildScreenModel(
      makeSnapshot({
        tag: 'job',
        op: opView({ revision: 3, result: { currency: 'AUD', items: [] } }),
        jobId: JOB_ID,
        status: 'ready',
      }),
    );
    expect(model.statusText).toBe("I didn't find any recurring charges.");
  });

  it('itemReceipt: a receipt in words plus the raw server record with every field', () => {
    const item = READY_RESULT.items[0]!;
    const receipt = itemReceipt(item, 0, 'AUD', JOB_ID, 3);
    expect(receipt.merchant).toBe('StreamBeam');
    expect(receipt.amount).toBe('19.99 AUD');
    expect(receipt.status).toBe('ready');
    expect(receipt.summary).toEqual([
      { label: 'Last charged', value: '1 Oct 2026' },
      { label: 'Frequency', value: 'Monthly' },
    ]);
    // Every field of the API item, under its API name, unformatted; plus the job it belongs to.
    const record = Object.fromEntries(receipt.record.map((field) => [field.key, field.value]));
    expect(record).toEqual({
      id: item.id,
      merchant: item.merchant,
      amountMinor: String(item.amountMinor),
      currency: 'AUD',
      cadence: item.cadence,
      lastSeen: item.lastSeen,
      jobId: JOB_ID,
      revision: '3',
    });
    expect(Object.keys(item).every((key) => key in record)).toBe(true);
    // Screen readers get words, not API names.
    expect(receipt.record.map((field) => field.label)).not.toContain('amountMinor');
  });

  it('itemReceipt shows a normalised frequency and keeps the raw one in the record', () => {
    const item = { ...READY_RESULT.items[0]!, cadence: 'annual' };
    const receipt = itemReceipt(item, 1, 'AUD', JOB_ID, 3);
    expect(receipt.summary).toContainEqual({ label: 'Frequency', value: 'Yearly' });
    expect(receipt.record).toContainEqual({ key: 'cadence', label: 'Frequency', value: 'annual' });
    expect(receipt.position).toBe(1);
  });
});

describe('file fact', () => {
  const job = (name: string) =>
    buildScreenModel(
      makeSnapshot({
        tag: 'job',
        op: opView({ file: { name, size: 33_882, format: 'pdf', available: false } }),
        jobId: JOB_ID,
        status: 'queued',
      }),
    );

  it('shows name, size and format while the name is known (this session)', () => {
    expect(job('statement.pdf').facts).toEqual([
      { label: FACT_LABELS.file, value: 'statement.pdf · 33.1 KiB · PDF' },
    ]);
  });

  it('after a relaunch the journal has no name: «Файл: PDF, 33,1 КиБ», name omitted', () => {
    expect(job('').facts).toEqual([{ label: 'File', value: 'PDF, 33.1 KiB' }]);
  });
});

describe('empty screen: greeting and footnote', () => {
  const empty = makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true } });

  it('the greeting replaces the empty copy only while LocalUiState.greeting is on', () => {
    const greeted = buildScreenModel(empty, { pickError: null, greeting: true });
    expect(greeted.title).toBe(EMPTY_COPY.greetingTitle);
    expect(greeted.statusText).toBe(EMPTY_COPY.greetingStatus);
    expect(greeted.buttons.map((button) => button.id)).toEqual(['pickFile']);
    const later = buildScreenModel(empty, { pickError: null, greeting: false });
    expect(later.title).toBe(VIEW_COPY.empty.title);
    expect(later.statusText).toBe('');
    // Its own phase: going from the greeting to the plain empty screen is not a silent no-op.
    expect(greeted.announceKey).not.toBe(later.announceKey);
    expect(buildScreenModel(empty).title).toBe(VIEW_COPY.empty.title);
  });

  it('the greeting never leaks into another state', () => {
    for (const state of STATE_CASES.filter((item) => item.tag !== 'empty')) {
      const model = buildScreenModel(state.snapshot, { pickError: null, greeting: true });
      expect(model.title).toBe(buildScreenModel(state.snapshot).title);
    }
  });

  it('the accepted-files footnote is on the empty screen only', () => {
    expect(buildScreenModel(empty).footnote).toBe(EMPTY_COPY.footnote);
    for (const state of STATE_CASES.filter((item) => item.tag !== 'empty')) {
      expect(buildScreenModel(state.snapshot).footnote).toBeNull();
    }
  });
});

describe('confirm facts', () => {
  it('name on its own line; size and format are short facts', () => {
    const model = buildScreenModel(
      makeSnapshot({
        tag: 'confirm',
        draft: { draftId: OP_ID, name: 'statement.csv', size: 112, format: 'csv' },
      }),
    );
    expect(model.facts).toEqual([
      { label: FACT_LABELS.name, value: 'statement.csv' },
      { label: FACT_LABELS.size, value: '112 B', short: true },
      { label: FACT_LABELS.format, value: 'CSV', short: true },
    ]);
  });
});
