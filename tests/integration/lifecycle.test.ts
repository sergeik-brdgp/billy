// Cancel paths, private-copy cleanup, cold-start sweep, config / unreachable errors and log privacy,
// all against the real mock.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { statsDelta } from '../support/mock';
import {
  createHarness,
  FIXTURES,
  picked,
  sendFixture,
  sleep,
  waitFor,
  waitIdle,
  waitReady,
  type Harness,
} from '../support/harness';
import { createImportController, type ImportController } from '../../src/core';
import {
  createMemoryStore,
  type MemoryStore,
  createNodeHttp,
  createNodeUpload,
  createRecordingLogger,
  nodeIds,
  realClock,
} from '../support/node-ports';

const T = 20_000;
const open: Harness[] = [];
async function harness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const h = await createHarness(options);
  open.push(h);
  await h.controller.start();
  return h;
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('cancel paths never leave a server job without a delete path', () => {
  it(
    'cancel on the confirm screen: copy deleted, nothing sent',
    async () => {
      const h = await harness();
      const before = await h.mock.stats();
      const draft = await h.controller.prepareFile(picked(FIXTURES.csv, 'statement.csv'));
      expect(draft.ok).toBe(true);
      expect(await h.files.leftovers()).toHaveLength(1);
      await h.controller.cancelDraft();
      expect(h.controller.getSnapshot().view.tag).toBe('empty');
      expect(await h.files.leftovers()).toEqual([]);
      expect(h.store.disk.size).toBe(0);
      expect(statsDelta(before, await h.mock.stats()).createRequests).toBe(0);
    },
    T,
  );

  it(
    'cancel while sending: upload aborted → by-key 404 → cancelled, copies deleted, no job',
    async () => {
      const h = await harness({
        upload: { behaviour: () => ({ chunkBytes: 8, chunkDelayMs: 40 }) },
      });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'sending' && (s.view.progress?.bytesSent ?? 0) > 0,
        {
          label: 'progress',
        },
      );
      expect(h.controller.getSnapshot().actions.cancelSending).toBe(true);
      await h.controller.cancelSending();
      const done = await waitFor(h.controller, (s) => s.view.tag === 'cancelled', {
        label: 'cancelled',
      });
      expect(done.actions.newImport).toBe(true);
      expect(h.history).toContain('outcome_unknown:reset_after_send/pending');
      expect(await h.files.leftovers()).toEqual([]);
      const delta = statsDelta(before, await h.mock.stats());
      expect(delta.newJobs).toBe(0);
      expect(delta.createRequests).toBe(1);
      await h.controller.newImport();
      expect(h.controller.getSnapshot().view.tag).toBe('empty');
      expect(h.store.disk.size).toBe(0);
    },
    T,
  );

  it(
    '"Отказаться" after an interrupted upload: final lookup 404 → cancelled; no resurrection by a late view',
    async () => {
      // Both the first POST and the one automatic same-key re-POST are cut mid-body.
      const h = await harness({
        upload: { behaviour: (n) => (n <= 2 ? { dropAfterBytes: 40 } : undefined) },
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'outcome_unknown' && s.view.lookup === 'not_found',
        {
          label: 'not_found',
        },
      );
      expect(h.controller.getSnapshot().actions).toMatchObject({
        resend: true,
        abandon: true,
        checkAgain: true,
      });
      await h.controller.abandon();
      const cancelled = await waitFor(h.controller, (s) => s.view.tag === 'cancelled', {
        label: 'cancelled',
      });
      expect(cancelled.view.tag === 'cancelled' && cancelled.view.op.file.name).toBe('');
      expect(await h.files.leftovers()).toEqual([]);
      expect((await h.mock.stats()).newJobs).toBe(0);
    },
    T,
  );

  it(
    '"Отказаться" when the job exists after all (lost_ack + flaky lookup): job shown with "Удалить", then deleted',
    async () => {
      let failedLookups = 0;
      const h = await harness({
        wrapHttp: (http) => ({
          request: (req) => {
            // The first by-key lookup after the lost ack fails at the transport level.
            if (req.url.includes('/by-key/') && failedLookups === 0) {
              failedLookups += 1;
              return Promise.resolve({
                ok: false as const,
                error: { cause: 'unreachable' as const },
              });
            }
            return http.request(req);
          },
        }),
      });
      await h.mock.scenario('lost_ack');
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const unknown = await waitFor(
        h.controller,
        (s) => s.view.tag === 'outcome_unknown' && s.view.lookup === 'unreachable',
        { label: 'lookup unreachable' },
      );
      expect(unknown.actions.abandon).toBe(true);
      await h.controller.abandon();
      const job = await waitFor(h.controller, (s) => s.view.tag === 'job', {
        label: 'job found on abandon',
      });
      expect(job.notice).toEqual({ tag: 'cancel_too_late' });
      expect(job.view.tag === 'job' && job.view.op.recoveredByKey).toBe(true);
      expect(job.actions.requestDelete).toBe(true);
      expect(h.history).not.toContain('cancelled');
      await h.mock.scenario('happy');
      await waitReady(h);
      await waitIdle(h.controller);
      await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.view.tag === 'deleted', { label: 'deleted' });
      expect((await h.mock.state()).jobs[0]?.status).toMatch(/^delet/);
      expect((await h.mock.stats()).newJobs).toBe(1);
    },
    T,
  );
});

describe('private copies and cold start', () => {
  it(
    'cold start sweeps orphan copies not referenced by a live op',
    async () => {
      const h = await harness();
      mkdirSync(h.files.privateDir, { recursive: true });
      writeFileSync(join(h.files.privateDir, 'orphan-draft.bin'), 'x');
      await h.relaunch(createMemoryStore());
      expect(await h.files.leftovers()).toEqual([]);
    },
    T,
  );

  it(
    'relaunch while ready: no POST, identity verified by key, then one GET',
    async () => {
      const h = await harness();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      const mark = h.traffic.length;
      const before = await h.mock.stats();
      await h.relaunch();
      await waitReady(h);
      await waitIdle(h.controller);
      expect(
        h.traffic
          .slice(mark)
          .map((r) => r.method + ' ' + r.path.replace(/by-key\/.*/, 'by-key/{key}')),
      ).toEqual(['GET /imports/by-key/{key}', 'GET /imports/job-demo-001']);
      expect(statsDelta(before, await h.mock.stats()).createRequests).toBe(0);
    },
    T,
  );

  it(
    'background pauses polling; foreground verifies identity and resumes',
    async () => {
      const h = await harness();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(h.controller, (s) => s.view.tag === 'job', { label: 'job' });
      await h.controller.onBackground();
      await waitIdle(h.controller);
      const mark = h.traffic.length;
      await sleep(1500);
      expect(h.traffic.length).toBe(mark);
      await h.controller.onForeground();
      await waitReady(h);
      expect(h.traffic[mark]?.path).toMatch(/^\/imports\/by-key\//);
    },
    T,
  );
});

describe('errors stay truthful and retryable', () => {
  /** A controller over the harness's files but pointed at another base URL. */
  function controllerAt(h: Harness, baseUrl: string): ImportController {
    h.controller.dispose();
    h.controller = createImportController({
      baseUrl,
      http: createNodeHttp(),
      upload: createNodeUpload(),
      files: h.files,
      store: createMemoryStore(),
      clock: realClock,
      ids: nodeIds,
      logger: createRecordingLogger(),
    });
    return h.controller;
  }

  async function confirmCsv(controller: ImportController): Promise<void> {
    await controller.start();
    const draft = await controller.prepareFile(picked(FIXTURES.csv, 'statement.csv'));
    if (!draft.ok) throw new Error('rejected');
    await controller.confirmSend(draft.value.draftId);
  }

  it(
    'wrong base URL path (404 route not found) → config_error, not "job not found", nothing created',
    async () => {
      const h = await harness();
      // Same mock, but every route is prefixed: the mock answers 404 {"error":"route not found"}.
      const controller = controllerAt(h, `${h.mock.baseUrl}/api`);
      await confirmCsv(controller);
      const s = await waitFor(controller, (x) => x.view.tag === 'outcome_unknown', {
        label: 'outcome_unknown',
      });
      expect(s.notice).toEqual({ tag: 'config_error', httpStatus: 404 });
      expect(s.view.tag === 'outcome_unknown' && s.view.lookup).toBe('skipped');
      expect(s.actions.resend).toBe(true);
      expect((await h.mock.stats()).createRequests).toBe(0);
    },
    T,
  );

  it(
    'mock not running → unreachable; lookup unreachable; nothing terminal; "Проверить снова" offered',
    async () => {
      const h = await harness();
      const controller = controllerAt(h, `http://127.0.0.1:${await closedPort()}`);
      await confirmCsv(controller);
      const s = await waitFor(
        controller,
        (x) => x.view.tag === 'outcome_unknown' && x.view.lookup === 'unreachable',
        { label: 'unreachable' },
      );
      expect(s.view.tag === 'outcome_unknown' && s.view.cause).toBe('unreachable');
      expect(s.readError?.error).toMatchObject({ kind: 'transport', cause: 'unreachable' });
      expect(s.actions).toMatchObject({ checkAgain: true, resend: true, abandon: true });
      // The private copy is kept: a resend must send the same bytes.
      expect(await h.files.leftovers()).toHaveLength(1);
    },
    T,
  );
});

describe('privacy: logs carry only allow-listed fields (C11)', () => {
  it(
    'no file name, path, URI, key or merchant appears in any log entry',
    async () => {
      const h = await harness();
      const secretName = 'Выписка Иванов 2026.csv';
      const draft = await h.controller.prepareFile(picked(FIXTURES.csv, secretName));
      if (!draft.ok) throw new Error('rejected');
      await h.controller.confirmSend(draft.value.draftId);
      await waitReady(h);
      await waitIdle(h.controller);
      await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.view.tag === 'deleted', { label: 'deleted' });
      const text = JSON.stringify(h.logger.entries);
      expect(h.logger.entries.length).toBeGreaterThan(5);
      for (const forbidden of [
        'Выписка',
        'Иванов',
        '.csv',
        h.root,
        'StreamBeam',
        'BrightGrid',
        'Synthetic',
        'by-key',
      ]) {
        expect(text).not.toContain(forbidden);
      }
      const allowed = new Set([
        'event',
        'opId',
        'phase',
        'httpStatus',
        'revision',
        'attempt',
        'durationMs',
        'cause',
      ]);
      for (const entry of h.logger.entries) {
        for (const key of Object.keys(entry)) expect(allowed.has(key)).toBe(true);
      }
      // The non-ASCII name went out percent-encoded (header-safe, ≤ 255).
      const header = h.traffic.find((r) => r.method === 'POST')?.headers['X-File-Name'] ?? '';
      expect(header).toBe(encodeURIComponent(secretName));
    },
    T,
  );
});

/** A store over `base` that records every body it is asked to write, in order. */
function recordingStore(base: MemoryStore, writes: string[]): MemoryStore {
  return {
    ...base,
    async upsert(row) {
      writes.push(row.body);
      return base.upsert(row);
    },
    revive: () => recordingStore(base.revive(), writes),
  };
}

const phaseTag = (body: string): string =>
  (JSON.parse(body) as { phase: { tag: string } }).phase.tag;

describe('privacy: journal minimisation (the iOS journal is in iCloud / Finder backups)', () => {
  it(
    'after 202 no journal row holds the file name or the report; a cold-started ready op re-fetches the report by key → GET and shows it without the name',
    async () => {
      const writes: string[] = [];
      const h = await harness({ store: recordingStore(createMemoryStore(), writes) });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const ready = await waitReady(h);
      // In this session the name and the report live in memory.
      expect(ready.view.tag === 'job' && ready.view.op.file.name).toBe('statement.csv');
      expect(ready.view.tag === 'job' && ready.view.op.result?.items).toHaveLength(2);
      await waitIdle(h.controller);

      // Before the job exists the name is kept (a resend needs X-File-Name) ...
      const firstJobWrite = writes.findIndex((body) => phaseTag(body) === 'server');
      expect(firstJobWrite).toBeGreaterThan(0);
      expect(writes.slice(0, firstJobWrite).every((body) => body.includes('statement.csv'))).toBe(
        true,
      );
      // ... and blanked in the very write that records the job; the report is never written.
      for (const body of writes.slice(firstJobWrite)) expect(body).not.toContain('statement.csv');
      for (const body of writes) {
        for (const secret of ['StreamBeam', 'BrightGrid', 'rec-001']) {
          expect(body).not.toContain(secret);
        }
      }
      const disk = [...h.store.disk.values()].join('\n');
      expect(disk).not.toContain('statement.csv');
      expect(disk).not.toContain('StreamBeam');

      // Cold start: verify by key, then one GET re-fetches the report into memory.
      const trafficBefore = h.traffic.length;
      const writesBefore = writes.length;
      await h.relaunch();
      const again = await waitFor(
        h.controller,
        (s) => s.view.tag === 'job' && s.view.status === 'ready' && s.view.op.result !== null,
        { label: 'ready with the report after a cold start' },
      );
      if (again.view.tag !== 'job' || again.view.op.result === null) throw new Error('no report');
      expect(again.view.op.file.name).toBe('');
      expect(again.view.op.file).toMatchObject({ format: 'csv', size: 112 });
      expect(again.view.op.result.items.map((item) => item.merchant)).toEqual([
        'StreamBeam',
        'BrightGrid',
      ]);
      await waitIdle(h.controller);
      const after = h.traffic.slice(trafficBefore).map((r) => `${r.method} ${r.path}`);
      expect(after[0]).toMatch(/^GET \/imports\/by-key\//);
      expect(after).toContain(`GET /imports/${again.view.jobId}`);
      expect(after.some((line) => line.startsWith('POST'))).toBe(false);
      // Re-fetching the report into memory writes nothing.
      for (const body of writes.slice(writesBefore)) expect(body).not.toContain('StreamBeam');
      expect([...h.store.disk.values()].join('\n')).not.toContain('StreamBeam');
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 1,
        newJobs: 1,
      });
    },
    T,
  );

  it(
    'a row written by an older build (name + report inside) is rewritten minimised at cold start',
    async () => {
      const h = await harness();
      await sendFixture(h, FIXTURES.pdf, 'statement.pdf');
      const ready = await waitReady(h);
      await waitIdle(h.controller);
      if (ready.view.tag !== 'job') throw new Error('not a job');
      // Simulate the old format: the full in-memory op as the journal body.
      const [opId, body] = [...h.store.disk.entries()][0] ?? [];
      if (opId === undefined || body === undefined) throw new Error('no row');
      const legacy = {
        ...(JSON.parse(body) as Record<string, unknown>),
        file: {
          format: 'pdf',
          size: ready.view.op.file.size,
          name: 'statement.pdf',
          tempPath: null,
        },
        result: ready.view.op.result,
      };
      h.store.disk.set(opId, JSON.stringify(legacy));
      await h.relaunch();
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'job' && s.view.status === 'ready' && s.view.op.result !== null,
        { label: 'ready after relaunch' },
      );
      const disk = [...h.store.disk.values()].join('\n');
      expect(disk).not.toContain('statement.pdf');
      expect(disk).not.toContain('StreamBeam');
    },
    T,
  );

  it(
    'a failed legacy rewrite is logged and retried on foreground (an idle ready op writes nothing else)',
    async () => {
      const h = await harness();
      await sendFixture(h, FIXTURES.pdf, 'statement.pdf');
      const ready = await waitReady(h);
      await waitIdle(h.controller);
      if (ready.view.tag !== 'job') throw new Error('not a job');
      const [opId, body] = [...h.store.disk.entries()][0] ?? [];
      if (opId === undefined || body === undefined) throw new Error('no row');
      const legacy = {
        ...(JSON.parse(body) as Record<string, unknown>),
        file: {
          format: 'pdf',
          size: ready.view.op.file.size,
          name: 'statement.pdf',
          tempPath: null,
        },
        result: ready.view.op.result,
      };
      h.store.disk.set(opId, JSON.stringify(legacy));
      // The first write of the new process fails (the start-up rewrite).
      const base = createMemoryStore(h.store.disk);
      let failNext = true;
      const flaky: MemoryStore = {
        ...base,
        async upsert(row) {
          if (failNext) {
            failNext = false;
            return { ok: false, error: { kind: 'io' } };
          }
          return base.upsert(row);
        },
      };
      await h.relaunch(flaky);
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'job' && s.view.status === 'ready' && s.view.op.result !== null,
        { label: 'ready after relaunch' },
      );
      await waitIdle(h.controller);
      expect(h.logger.entries.some((e) => e.event === 'journal_rewrite_failed')).toBe(true);
      expect([...h.store.disk.values()].join('\n')).toContain('statement.pdf');
      await h.controller.onForeground();
      await waitIdle(h.controller);
      const disk = [...h.store.disk.values()].join('\n');
      expect(disk).not.toContain('statement.pdf');
      expect(disk).not.toContain('StreamBeam');
    },
    T,
  );
});
