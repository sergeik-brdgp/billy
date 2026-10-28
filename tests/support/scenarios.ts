// Acceptance-matrix scenarios run through the real core + Node adapters against a fresh in-process
// mock. Shared by tests/integration (assertions) and scripts/matrix.mjs (table for the docs).
// Each scenario returns mock counter deltas, the final UI state and scenario-specific observations.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeOperation } from '../../src/core/codec';
import {
  formatItemLine,
  formatMonthlyTotal,
  type HttpPort,
  type IgnoredView,
  type ImportSnapshot,
  type MockStats,
  type Operation,
} from '../../src/core';
import {
  createHarness,
  FIXTURES,
  picked,
  sendFixture,
  sleep,
  viewLabel,
  waitFor,
  waitIdle,
  waitReady,
  writeOversize,
  type Harness,
} from './harness';
import { statsDelta } from './mock';
import { createMemoryStore, type RecordedRequest } from './node-ports';

export interface ScenarioResult<C> {
  readonly id: string;
  /** Matrix wording (assignment) or wording for the extra rows. */
  readonly title: string;
  readonly deltas: MockStats;
  readonly finalView: string;
  readonly history: readonly string[];
  readonly checks: C;
}

const posts = (traffic: readonly RecordedRequest[]): RecordedRequest[] =>
  traffic.filter((r) => r.method === 'POST' && r.path === '/imports');

function persistedOps(h: Harness): Operation[] {
  const ops: Operation[] = [];
  for (const body of h.store.disk.values()) {
    const decoded = decodeOperation(body);
    if (decoded.ok) ops.push(decoded.value);
  }
  return ops;
}

function onlyPersisted(h: Harness): Operation {
  const ops = persistedOps(h);
  const [op] = ops;
  if (ops.length !== 1 || op === undefined)
    throw new Error(`expected 1 persisted op, got ${ops.length}`);
  return op;
}

async function run<C>(
  id: string,
  title: string,
  body: (h: Harness, before: MockStats) => Promise<C>,
  options: Parameters<typeof createHarness>[0] = {},
): Promise<ScenarioResult<C>> {
  const h = await createHarness(options);
  try {
    await h.controller.start();
    const before = await h.mock.stats();
    const checks = await body(h, before);
    const after = await h.mock.stats();
    return {
      id,
      title,
      deltas: statsDelta(before, after),
      finalView: viewLabel(h.controller.getSnapshot()),
      history: [...h.history],
      checks,
    };
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------------------------------------
// happy

export interface HappyChecks {
  readonly localSize: number;
  readonly serverBytes: number | null;
  readonly firstJobView: string | null;
  /** Did any snapshot show a report (result) while the job was not ready? Must be false. */
  readonly reportBeforeReady: boolean;
  readonly items: readonly string[];
  readonly total: string;
  readonly revision: number;
  readonly leftovers: readonly string[];
  readonly postHeaders: Readonly<Record<string, string>> | null;
}

export function happy(format: 'csv' | 'pdf'): Promise<ScenarioResult<HappyChecks>> {
  const path = FIXTURES[format];
  return run(
    `happy_${format}`,
    `happy (${format.toUpperCase()}): файл реально отправлен; 202 не объявлен готовым отчётом; после ready видны данные mock`,
    async (h) => {
      await sendFixture(h, path, `statement.${format}`);
      const ready = await waitReady(h);
      if (ready.view.tag !== 'job') throw new Error('not a job view');
      const result = ready.view.op.result;
      if (result === null) throw new Error('ready without result');
      const state = await h.mock.state();
      return {
        localSize: statSync(path).size,
        serverBytes: state.jobs[0]?.bytes ?? null,
        firstJobView: h.history.find((label) => label.startsWith('job:')) ?? null,
        reportBeforeReady: h.snapshots.some(
          (s) => s.view.tag === 'job' && s.view.status !== 'ready' && s.view.op.result !== null,
        ),
        items: result.items.map((item) => formatItemLine(item, result.currency)),
        total: formatMonthlyTotal(result),
        revision: ready.view.op.revision,
        leftovers: await h.files.leftovers(),
        postHeaders: posts(h.traffic)[0]?.headers ?? null,
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// lost_ack

export interface LostAckChecks {
  readonly deltasBeforeAnyTap: MockStats;
  readonly recoveredByKey: boolean;
  readonly appPosts: number;
  readonly keyStable: boolean;
  readonly sawOutcomeUnknown: boolean;
  readonly persistedPhaseAtDeath?: string;
}

export function lostAckInSession(): Promise<ScenarioResult<LostAckChecks>> {
  return run(
    'lost_ack',
    'lost_ack: первый POST создал job без ответа; GET по ключу находит его; newJobs=1',
    async (h, before) => {
      await h.mock.scenario('lost_ack');
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const recovered = await waitFor(h.controller, (s) => s.view.tag === 'job', {
        label: 'recovered job',
      });
      const deltasBeforeAnyTap = statsDelta(before, await h.mock.stats());
      await waitReady(h);
      const op = onlyPersisted(h);
      return {
        deltasBeforeAnyTap,
        recoveredByKey: recovered.view.tag === 'job' && recovered.view.op.recoveredByKey,
        appPosts: posts(h.traffic).length,
        keyStable: posts(h.traffic).every((r) => r.headers['Idempotency-Key'] === op.key),
        sawOutcomeUnknown: h.history.some((label) =>
          label.startsWith('outcome_unknown:reset_after_send'),
        ),
      };
    },
  );
}

export function lostAckRelaunch(): Promise<ScenarioResult<LostAckChecks>> {
  // Upserts: #1 pending_send, #2 sending, #3 outcome_unknown → the process dies before #3 lands.
  const store = createMemoryStore(new Map(), { nthUpsert: 3, when: 'before_write' });
  return run(
    'lost_ack_relaunch',
    'lost_ack + relaunch: ответ потерян, приложение убито; после relaunch GET по ключу находит job; newJobs=1',
    async (h, before) => {
      await h.mock.scenario('lost_ack');
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(h.controller, (s) => s.storageError, {
        label: 'process death after the lost ack',
      });
      const persistedPhaseAtDeath = onlyPersisted(h).phase.tag;
      const postsBeforeRelaunch = posts(h.traffic).length;
      await h.relaunch();
      const recovered = await waitFor(h.controller, (s) => s.view.tag === 'job', {
        label: 'recovered job',
      });
      const deltasBeforeAnyTap = statsDelta(before, await h.mock.stats());
      await waitReady(h);
      const op = onlyPersisted(h);
      const appPosts = posts(h.traffic).length;
      if (appPosts !== postsBeforeRelaunch) throw new Error('relaunch re-sent the file');
      return {
        deltasBeforeAnyTap,
        recoveredByKey: recovered.view.tag === 'job' && recovered.view.op.recoveredByKey,
        appPosts,
        keyStable: posts(h.traffic).every((r) => r.headers['Idempotency-Key'] === op.key),
        sawOutcomeUnknown: h.history.some((label) =>
          label.startsWith('outcome_unknown:interrupted'),
        ),
        persistedPhaseAtDeath,
      };
    },
    { store },
  );
}

// ---------------------------------------------------------------------------------------------
// stale_status

export interface StaleChecks {
  readonly afterFirstRefresh: {
    readonly view: string;
    readonly revision: number;
    readonly ignored: number;
  };
  readonly afterSecondRefresh: {
    readonly view: string;
    readonly revision: number;
    readonly ignored: number;
  };
  readonly lastIgnored: IgnoredView | null;
  /** Every UI state shown after the first ready (must be only `job:ready`). */
  readonly viewsAfterReady: readonly string[];
}

function revisionOf(s: ImportSnapshot): number {
  return s.diagnostics.revision ?? -1;
}

export function staleStatus(): Promise<ScenarioResult<StaleChecks>> {
  return run(
    'stale_status',
    'stale_status: после ready/revision 3 приходит processing/revision 2; UI не откатывается',
    async (h) => {
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      const readyIndex = h.snapshots.length;
      await h.mock.scenario('stale_status');
      await h.controller.refresh();
      const first = await waitIdle(h.controller, 'first refresh');
      await h.controller.refresh();
      const second = await waitIdle(h.controller, 'second refresh');
      return {
        afterFirstRefresh: {
          view: viewLabel(first),
          revision: revisionOf(first),
          ignored: first.diagnostics.ignoredViews.count,
        },
        afterSecondRefresh: {
          view: viewLabel(second),
          revision: revisionOf(second),
          ignored: second.diagnostics.ignoredViews.count,
        },
        lastIgnored: second.diagnostics.ignoredViews.last,
        viewsAfterReady: [...new Set(h.snapshots.slice(readyIndex).map(viewLabel))],
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// delete_failure

export interface DeleteFailureChecks {
  readonly afterFailure: string;
  readonly deleteRequestsAfterFailure: number;
  readonly claimedDeletedBeforeHappy: boolean;
  readonly deleteKeys: readonly string[];
  readonly sameDeleteKey: boolean;
  readonly deletingBeforeDeleted: boolean;
  /** Source of the server view that produced `deleted` (must be a GET / by-key view). */
  readonly deletedFrom: string | null;
  readonly nameCleared: boolean;
  readonly resultCleared: boolean;
  readonly leftovers: readonly string[];
}

export function deleteFailure(): Promise<ScenarioResult<DeleteFailureChecks>> {
  return run(
    'delete_failure',
    'delete_failure: DELETE вернул 503; UI не утверждает удаление; после happy повтор с тем же ключом доходит до deleted',
    async (h, before) => {
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      await h.mock.scenario('delete_failure');
      await h.controller.requestDelete();
      const failed = await waitFor(h.controller, (s) => s.view.tag === 'delete_failed', {
        label: 'delete_failed',
      });
      const deleteRequestsAfterFailure =
        (await h.mock.stats()).deleteRequests - before.deleteRequests;
      const claimedDeletedBeforeHappy = h.history.includes('deleted');
      await h.mock.scenario('happy');
      await h.controller.retryDelete();
      const deleted = await waitFor(h.controller, (s) => s.view.tag === 'deleted', {
        label: 'deleted',
        timeoutMs: 8000,
      });
      const deleteKeys = h.traffic
        .filter((r) => r.method === 'DELETE')
        .map((r) => r.headers['Idempotency-Key'] ?? '');
      const firstDeleted = h.snapshots.find((s) => s.view.tag === 'deleted');
      const iDeleting = h.history.indexOf('deleting');
      const iDeleted = h.history.indexOf('deleted');
      return {
        afterFailure: viewLabel(failed),
        deleteRequestsAfterFailure,
        claimedDeletedBeforeHappy,
        deleteKeys,
        sameDeleteKey:
          deleteKeys.length === 2 && deleteKeys[0] === deleteKeys[1] && deleteKeys[0] !== '',
        deletingBeforeDeleted: iDeleting >= 0 && iDeleting < iDeleted,
        deletedFrom: firstDeleted?.diagnostics.lastRawView
          ? `${firstDeleted.diagnostics.lastRawView.source}:${firstDeleted.diagnostics.lastRawView.view.status}/r${firstDeleted.diagnostics.lastRawView.view.revision}`
          : null,
        nameCleared: deleted.view.tag === 'deleted' && deleted.view.op.file.name === '',
        resultCleared: deleted.view.tag === 'deleted' && deleted.view.op.result === null,
        leftovers: await h.files.leftovers(),
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// spoofed + oversize

export interface RejectionChecks {
  readonly spoofed: string;
  readonly oversizeKnownSize: string;
  readonly oversizeUnknownSize: string;
  readonly oversizeLyingMetadata: string;
  readonly finalViewAfterSpoofed: string;
  readonly leftovers: readonly string[];
  readonly oversizeBytes: number;
}

export function spoofedAndOversize(): Promise<ScenarioResult<RejectionChecks>> {
  return run(
    'spoofed_oversize',
    'spoofed + oversize: оба файла отвергнуты до POST; createRequests до и после равны',
    async (h) => {
      const verdict = (r: Awaited<ReturnType<typeof h.controller.prepareFile>>): string =>
        r.ok ? `accepted:${r.value.format}` : r.error.reason;
      const spoofed = verdict(
        await h.controller.prepareFile(
          picked(FIXTURES.spoofed, 'spoofed.pdf', statSync(FIXTURES.spoofed).size),
        ),
      );
      const finalViewAfterSpoofed = viewLabel(h.controller.getSnapshot());
      const big = writeOversize(h.root);
      const known = verdict(
        await h.controller.prepareFile(picked(big.path, 'oversize.csv', big.size)),
      );
      const unknown = verdict(
        await h.controller.prepareFile(picked(big.path, 'oversize.csv', null)),
      );
      const lying = verdict(await h.controller.prepareFile(picked(big.path, 'oversize.csv', 1024)));
      return {
        spoofed,
        oversizeKnownSize: known,
        oversizeUnknownSize: unknown,
        oversizeLyingMetadata: lying,
        finalViewAfterSpoofed,
        leftovers: await h.files.leftovers(),
        oversizeBytes: big.size,
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// reset safety

export interface ResetSafetyChecks {
  readonly ourJobId: string | null;
  readonly foreignJobId: string | null;
  readonly requestsAfterReset: readonly string[];
  readonly touchedForeignJob: boolean;
  readonly foreignStatus: string | null;
}

export function resetSafety(
  action: 'refresh' | 'delete',
): Promise<ScenarioResult<ResetSafetyChecks>> {
  return run(
    `reset_safety_${action}`,
    `reset safety (${action}): после /__test/reset чужой job получает job-demo-001; наш ${action} → lost, чужой не тронут`,
    async (h) => {
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const ready = await waitReady(h);
      await waitIdle(h.controller);
      const ourJobId = ready.diagnostics.jobId;
      await h.mock.reset();
      const foreign = await h.mock.rawCreate('foreign-client-key-0001', readFileSync(FIXTURES.csv));
      const foreignJobId = (foreign.body as { jobId?: string }).jobId ?? null;
      const mark = h.traffic.length;
      if (action === 'refresh') await h.controller.refresh();
      else await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.view.tag === 'lost', { label: 'lost' });
      const after = h.traffic.slice(mark);
      const state = await h.mock.state();
      return {
        ourJobId,
        foreignJobId,
        requestsAfterReset: after.map(
          (r) => `${r.method} ${r.path.replace(/by-key\/[^/]+$/, 'by-key/{key}')}`,
        ),
        touchedForeignJob: after.some(
          (r) => foreignJobId !== null && r.path === `/imports/${foreignJobId}`,
        ),
        foreignStatus: state.jobs.find((job) => job.jobId === foreignJobId)?.status ?? null,
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// key persisted before POST

export interface KeyPersistedChecks {
  readonly deltasAfterCrash: MockStats;
  readonly persistedPhase: string;
  readonly persistedKeyLength: number;
  readonly deltasAfterRelaunchBeforeTap: MockStats;
  readonly viewAfterRelaunch: string;
  readonly resendUsedPersistedKey: boolean;
}

export function keyPersistedBeforePost(
  crashAt: 1 | 2,
): Promise<ScenarioResult<KeyPersistedChecks>> {
  // Upsert #1 = op with key in pending_send, #2 = phase sending (right before the POST).
  const store = createMemoryStore(new Map(), { nthUpsert: crashAt, when: 'after_write' });
  return run(
    `key_persisted_crash_${crashAt}`,
    `key persisted before POST: crash after upsert #${crashAt} → key on disk, no request; relaunch does not POST; tap resend uses the same key`,
    async (h, before) => {
      const draft = await h.controller.prepareFile(picked(FIXTURES.csv, 'statement.csv'));
      if (!draft.ok) throw new Error('fixture rejected');
      await h.controller.confirmSend(draft.value.draftId);
      await sleep(200);
      const deltasAfterCrash = statsDelta(before, await h.mock.stats());
      const persisted = onlyPersisted(h);
      await h.relaunch();
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'outcome_unknown' && s.view.lookup === 'not_found',
        { label: 'outcome_unknown/not_found after relaunch' },
      );
      await sleep(300);
      const deltasAfterRelaunchBeforeTap = statsDelta(before, await h.mock.stats());
      const viewAfterRelaunch = viewLabel(h.controller.getSnapshot());
      await h.controller.resend();
      await waitReady(h);
      return {
        deltasAfterCrash,
        persistedPhase: persisted.phase.tag,
        persistedKeyLength: persisted.key.length,
        deltasAfterRelaunchBeforeTap,
        viewAfterRelaunch,
        resendUsedPersistedKey:
          posts(h.traffic).length === 1 &&
          posts(h.traffic)[0]?.headers['Idempotency-Key'] === persisted.key,
      };
    },
    { store },
  );
}

// ---------------------------------------------------------------------------------------------
// interrupted mid-body upload

export interface InterruptedChecks {
  /** Counter deltas once the job exists — no tap was made (the re-POST was automatic). */
  readonly deltasWithoutTap: MockStats;
  /** The UI showed the honest auto-retry sending state (`autoRetry: true`). */
  readonly sawAutoRetry: boolean;
  /** POSTs the app sent (the dropped one + the one automatic re-POST). */
  readonly appPosts: number;
  /** Automatic re-POSTs the core issued (`post_auto_resend` log entries) — measured, not assumed. */
  readonly autoPosts: number;
  readonly sameKey: boolean;
  readonly sameFileName: boolean;
  readonly localSize: number;
}

export function interruptedUpload(): Promise<ScenarioResult<InterruptedChecks>> {
  return run(
    'interrupted_upload',
    'interrupted mid-body upload: соединение оборвано посреди тела → по ключу 404 («пока не найден») → один автоматический POST с тем же ключом без нажатия → newJobs=1',
    async (h, before) => {
      // No tap anywhere in this scenario: never call resend().
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      const deltasWithoutTap = statsDelta(before, await h.mock.stats());
      const sent = posts(h.traffic);
      return {
        deltasWithoutTap,
        sawAutoRetry: h.snapshots.some((s) => s.view.tag === 'sending' && s.view.autoRetry),
        appPosts: sent.length,
        autoPosts: h.logger.entries.filter((e) => e.event === 'post_auto_resend').length,
        sameKey:
          sent.length === 2 &&
          sent[0]?.headers['Idempotency-Key'] === sent[1]?.headers['Idempotency-Key'],
        sameFileName:
          sent.length === 2 && sent[0]?.headers['X-File-Name'] === sent[1]?.headers['X-File-Name'],
        localSize: statSync(FIXTURES.csv).size,
      };
    },
    { upload: { behaviour: (attempt) => (attempt === 1 ? { dropAfterBytes: 50 } : undefined) } },
  );
}

// ---------------------------------------------------------------------------------------------
// repeated DELETE whose 202 body says deleted/5

export interface RepeatedDeleteChecks {
  readonly afterDelete202: {
    readonly view: string;
    readonly revision: number | null;
    readonly body: string;
  } | null;
  readonly deletedFrom: string | null;
}

/** HTTP wrapper: the first DELETE is sent, its response "lost", and the transport retries it 1.1 s later. */
function duplicateFirstDelete(http: HttpPort): HttpPort {
  let duplicated = false;
  return {
    async request(req) {
      if (req.method !== 'DELETE' || duplicated) return http.request(req);
      duplicated = true;
      await http.request(req);
      await sleep(1100);
      return http.request(req);
    },
  };
}

export function repeatedDelete(): Promise<ScenarioResult<RepeatedDeleteChecks>> {
  return run(
    'repeated_delete',
    'repeated DELETE: 202 с телом deleted/5 → только deleting (ревизия не меняется) → GET deleted/5 → deleted',
    async (h) => {
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.view.tag === 'deleted', { label: 'deleted' });
      const afterDelete = h.snapshots.find((s) => s.diagnostics.lastRawView?.source === 'delete');
      const firstDeleted = h.snapshots.find((s) => s.view.tag === 'deleted');
      const raw = afterDelete?.diagnostics.lastRawView;
      return {
        afterDelete202:
          afterDelete && raw
            ? {
                view: viewLabel(afterDelete),
                revision: afterDelete.diagnostics.revision,
                body: `${raw.view.status}/r${raw.view.revision}`,
              }
            : null,
        deletedFrom: firstDeleted?.diagnostics.lastRawView
          ? `${firstDeleted.diagnostics.lastRawView.source}:${firstDeleted.diagnostics.lastRawView.view.status}/r${firstDeleted.diagnostics.lastRawView.view.revision}`
          : null,
      };
    },
    { wrapHttp: duplicateFirstDelete },
  );
}

// ---------------------------------------------------------------------------------------------
// differential validator

export interface DifferentialRow {
  readonly name: string;
  readonly client: string;
  readonly server: number;
}

export const DIFFERENTIAL_CASES: readonly { readonly name: string; readonly bytes: Uint8Array }[] =
  [
    { name: '%PDF-…', bytes: Buffer.from('%PDF-1.7\n%synthetic\n') },
    { name: '%PDF (4 bytes)', bytes: Buffer.from('%PDF') },
    {
      name: 'date,description,amount\\n…',
      bytes: Buffer.from('date,description,amount\n2026-10-01,X,-1.00\n'),
    },
    {
      name: 'date,description,amount\\r\\n…',
      bytes: Buffer.from('date,description,amount\r\n2026-10-01,X,-1.00\r\n'),
    },
    {
      name: 'UTF-8 BOM + date,…',
      bytes: Buffer.from('\ufeffdate,description,amount\n2026-10-01,X,-1.00\n'),
    },
    { name: 'empty', bytes: new Uint8Array(0) },
    { name: 'not a pdf', bytes: Buffer.from('not a pdf') },
  ];

export function differentialValidator(
  cases: readonly { readonly name: string; readonly bytes: Uint8Array }[] = DIFFERENTIAL_CASES,
): Promise<ScenarioResult<readonly DifferentialRow[]>> {
  return run(
    'differential_validator',
    'differential validator: вердикт клиента == вердикт mock (202/415)',
    async (h) => {
      const rows: DifferentialRow[] = [];
      let index = 0;
      for (const testCase of cases) {
        index += 1;
        const path = join(h.root, `case-${index}.bin`);
        writeFileSync(path, testCase.bytes);
        const verdict = await h.controller.prepareFile(
          picked(path, `case-${index}.bin`, testCase.bytes.length),
        );
        if (verdict.ok) await h.controller.cancelDraft();
        const server = await h.mock.rawCreate(
          `differential-key-${String(index).padStart(4, '0')}`,
          testCase.bytes,
        );
        rows.push({
          name: testCase.name,
          client: verdict.ok
            ? 'accept'
            : verdict.error.reason === 'not_statement'
              ? 'reject'
              : verdict.error.reason,
          server: server.status,
        });
      }
      return rows;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// The matrix (scripts/matrix.mjs)

export interface MatrixRow {
  readonly id: string;
  readonly title: string;
  readonly deltas: MockStats;
  readonly finalView: string;
}

export const MATRIX: readonly (() => Promise<ScenarioResult<unknown>>)[] = [
  () => happy('csv'),
  () => happy('pdf'),
  lostAckInSession,
  lostAckRelaunch,
  staleStatus,
  deleteFailure,
  spoofedAndOversize,
  () => resetSafety('refresh'),
  () => resetSafety('delete'),
  () => keyPersistedBeforePost(1),
  () => keyPersistedBeforePost(2),
  interruptedUpload,
  repeatedDelete,
];

const fmt = (d: MockStats): string =>
  `createRequests +${d.createRequests}, newJobs +${d.newJobs}, duplicateHits +${d.duplicateHits}`;

/** One-line key observation per row for the matrix table. */
export function noteFor(result: ScenarioResult<unknown>): string {
  const c = result.checks as Record<string, unknown>;
  switch (result.id) {
    case 'happy_csv':
    case 'happy_pdf': {
      const h = c as unknown as HappyChecks;
      return `server bytes ${String(h.serverBytes)} = local ${h.localSize}; first job view ${String(h.firstJobView)}; ${h.total}`;
    }
    case 'lost_ack':
    case 'lost_ack_relaunch': {
      const l = c as unknown as LostAckChecks;
      return `before any tap: ${fmt(l.deltasBeforeAnyTap)}; recoveredByKey=${String(l.recoveredByKey)}; app POSTs=${l.appPosts}`;
    }
    case 'stale_status': {
      const s = c as unknown as StaleChecks;
      return s.lastIgnored
        ? `ignored: ${s.lastIgnored.status} r${s.lastIgnored.revision} ≤ r${s.lastIgnored.currentRevision}; UI states after ready: ${s.viewsAfterReady.join(', ')}`
        : 'no view ignored';
    }
    case 'delete_failure': {
      const d = c as unknown as DeleteFailureChecks;
      return `after 503: ${d.afterFailure} (deleteRequests +${d.deleteRequestsAfterFailure}); same delete key=${String(d.sameDeleteKey)}; deleted from ${String(d.deletedFrom)}`;
    }
    case 'spoofed_oversize': {
      const r = c as unknown as RejectionChecks;
      return `spoofed → ${r.spoofed}; oversize (known / unknown / lying size) → ${r.oversizeKnownSize} / ${r.oversizeUnknownSize} / ${r.oversizeLyingMetadata}; copies left ${r.leftovers.length}`;
    }
    case 'reset_safety_refresh':
    case 'reset_safety_delete': {
      const r = c as unknown as ResetSafetyChecks;
      return `after reset: ${r.requestsAfterReset.join(', ')}; foreign ${String(r.foreignJobId)} touched=${String(r.touchedForeignJob)}`;
    }
    case 'key_persisted_crash_1':
    case 'key_persisted_crash_2': {
      const k = c as unknown as KeyPersistedChecks;
      return `after crash: createRequests +${k.deltasAfterCrash.createRequests} (journal: ${k.persistedPhase}); after relaunch, before tap: +${k.deltasAfterRelaunchBeforeTap.createRequests}; resend used persisted key=${String(k.resendUsedPersistedKey)}`;
    }
    case 'interrupted_upload': {
      const i = c as unknown as InterruptedChecks;
      return `no tap: ${fmt(i.deltasWithoutTap)}; app POSTs=${i.appPosts} (${i.autoPosts} automatic, same key=${String(i.sameKey)}); auto-retry shown=${String(i.sawAutoRetry)}`;
    }
    case 'repeated_delete': {
      const r = c as unknown as RepeatedDeleteChecks;
      return r.afterDelete202
        ? `after DELETE 202 body ${r.afterDelete202.body}: ${r.afterDelete202.view} at r${String(r.afterDelete202.revision)}; deleted from ${String(r.deletedFrom)}`
        : 'no DELETE body seen';
    }
    default:
      return '';
  }
}
