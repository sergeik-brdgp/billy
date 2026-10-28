// Failure cases found in review, each against the real mock and the real core: in-flight bytes
// after a cancel, journal write / load failures, mock-reset failures, superseded copies, process
// death during a write, moved app containers and the post-copy size guard.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { err, MAX_FILE_BYTES, type FilesPort, type StoredRow } from '../../src/core';
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
  type Harness,
  type HarnessOptions,
} from '../support/harness';
import { startMock, statsDelta, type RunningMock } from '../support/mock';
import { createMemoryStore, type MemoryStore } from '../support/node-ports';
import { startThrottleProxy, type ThrottleProxy } from '../support/throttle-proxy';

const T = 25_000;
const open: Harness[] = [];
const cleanups: (() => Promise<void>)[] = [];
async function harness(options?: HarnessOptions, start = true): Promise<Harness> {
  const h = await createHarness(options);
  open.push(h);
  if (start) await h.controller.start();
  return h;
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const phaseOf = (body: string): string =>
  (JSON.parse(body) as { phase: { tag: string; status?: string } }).phase.tag;

/** A store over `base` whose first upsert matching `match` fails (transient SQLITE_BUSY etc.). */
function failOnceStore(base: MemoryStore, match: (row: StoredRow) => boolean): MemoryStore {
  let failed = false;
  return {
    ...base,
    async upsert(row) {
      if (!failed && match(row)) {
        failed = true;
        return err({ kind: 'io' });
      }
      return base.upsert(row);
    },
  };
}

describe('cancel never orphans a job whose bytes are still in flight (TZ: 404 = «пока не найден»)', () => {
  it(
    'cancel at 100% progress over a slow uplink: the late job is found by a re-check, shown with "Удалить", never "cancelled"',
    async () => {
      const mock: RunningMock = await startMock();
      const proxy: ThrottleProxy = await startThrottleProxy(Number(new URL(mock.baseUrl).port), 40);
      cleanups.push(async () => {
        await proxy.close();
        await mock.close();
      });
      const h = await harness({ mock: { ...mock, baseUrl: `http://127.0.0.1:${proxy.port}` } });
      const before = await mock.stats();
      await sendFixture(h, FIXTURES.pdf, 'statement.pdf');
      await waitFor(
        h.controller,
        (s) =>
          s.view.tag === 'sending' &&
          s.view.progress !== null &&
          s.view.progress.bytesSent === s.view.progress.totalBytes,
        { label: 'progress 100%' },
      );
      await h.controller.cancelSending();
      const job = await waitFor(h.controller, (s) => s.view.tag === 'job', {
        label: 'late job found by a re-check',
      });
      expect(job.notice).toEqual({ tag: 'cancel_too_late' });
      expect(job.actions.requestDelete).toBe(true);
      expect(h.history).toContain('outcome_unknown:reset_after_send/settling');
      expect(h.history).not.toContain('cancelled');
      expect(statsDelta(before, await mock.stats()).newJobs).toBe(1);
      // The delete path works: no orphan, and a new import would not run next to it.
      await waitReady(h);
      await waitIdle(h.controller);
      await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.view.tag === 'deleted', { label: 'deleted' });
      expect(statsDelta(before, await mock.stats()).newJobs).toBe(1);
    },
    T,
  );
});

describe('journal write failures never wedge the UI', () => {
  it(
    'the write of `sending` fails once: nothing is sent, «Повторить» re-runs the send (persist first), one job',
    async () => {
      const writes: string[] = [];
      const base = failOnceStore(createMemoryStore(), (row) => phaseOf(row.body) === 'sending');
      const store: MemoryStore = {
        ...base,
        async upsert(row) {
          writes.push(phaseOf(row.body));
          return base.upsert(row);
        },
      };
      const h = await harness({ store });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const stuck = h.controller.getSnapshot();
      // Not wedged: the only (and enabled) action is «Повторить»; nothing went out.
      expect(stuck.storageError).toBe(true);
      expect(stuck.actions).toMatchObject({ retryStorage: true, cancelSending: false });
      expect(Object.values(stuck.actions).filter(Boolean)).toHaveLength(1);
      expect(stuck.view).toMatchObject({ tag: 'sending', notStarted: true });
      expect(stuck.activity.posting).toBe(false);
      await sleep(300);
      expect(h.traffic.filter((r) => r.method === 'POST')).toHaveLength(0);
      expect([...h.store.disk.values()].map(phaseOf)).toEqual(['pending_send']);

      await h.controller.retryStorage();
      const ready = await waitReady(h);
      expect(ready.storageError).toBe(false);
      expect(ready.actions.retryStorage).toBe(false);
      // pending_send, sending (failed), sending (retried, persisted BEFORE the POST), then server.
      expect(writes.slice(0, 3)).toEqual(['pending_send', 'sending', 'sending']);
      expect(writes).toContain('server');
      expect(h.traffic.filter((r) => r.method === 'POST')).toHaveLength(1);
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 1,
        newJobs: 1,
      });
    },
    T,
  );

  it(
    'the write of the 202 result fails once: not shown as in flight, retried, then the job is shown',
    async () => {
      const h = await harness(
        { store: failOnceStore(createMemoryStore(), (row) => phaseOf(row.body) === 'server') },
        true,
      );
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const failed = await waitFor(h.controller, (s) => s.actions.retryStorage, {
        label: 'storage error',
      });
      expect(failed.storageError).toBe(true);
      expect(failed.activity.posting).toBe(false);
      expect(failed.actions.cancelSending).toBe(false);
      const ready = await waitReady(h);
      expect(ready.storageError).toBe(false);
      expect(ready.actions.retryStorage).toBe(false);
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 1,
        newJobs: 1,
      });
    },
    T,
  );

  it(
    'the write of `deleted` fails once: the lane is freed and `deleted` is reached after the retry',
    async () => {
      const h = await harness({
        store: failOnceStore(createMemoryStore(), (row) => phaseOf(row.body) === 'deleted'),
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.storageError, { label: 'storage error' });
      const done = await waitFor(h.controller, (s) => s.view.tag === 'deleted', {
        label: 'deleted after retry',
      });
      expect(done.storageError).toBe(false);
      expect(phaseOf([...h.store.disk.values()][0] ?? '{}')).toBe('deleted');
    },
    T,
  );

  it(
    'manual "Повторить" re-applies the dropped result immediately',
    async () => {
      const h = await harness({
        store: failOnceStore(createMemoryStore(), (row) => phaseOf(row.body) === 'server'),
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(h.controller, (s) => s.actions.retryStorage, { label: 'storage error' });
      await h.controller.retryStorage();
      const s = h.controller.getSnapshot();
      expect(s.view.tag).toBe('job');
      expect(s.storageError).toBe(false);
    },
    T,
  );
});

describe('journal load failure blocks new imports (I9)', () => {
  it(
    'a failed loadAll at cold start: storage_unavailable, no pick / new import; retry recovers the op',
    async () => {
      const h = await harness();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      const disk = h.store.disk;
      let loads = 0;
      const flaky = createMemoryStore(disk);
      const store: MemoryStore = {
        ...flaky,
        async loadAll() {
          loads += 1;
          return loads === 1 ? err({ kind: 'io' }) : flaky.loadAll();
        },
      };
      const c = await h.relaunch(store);
      const s = c.getSnapshot();
      expect(s.view.tag).toBe('storage_unavailable');
      expect(s.storageError).toBe(true);
      expect(s.actions).toMatchObject({
        pickFile: false,
        confirmSend: false,
        newImport: false,
        retryStorage: true,
      });
      const attempt = await c.prepareFile(picked(FIXTURES.pdf, 'statement.pdf'));
      expect(attempt).toEqual({ ok: false, error: { reason: 'busy' } });
      await c.retryStorage();
      await waitReady(h);
      expect(c.getSnapshot().storageError).toBe(false);
      expect(disk.size).toBe(1);
      expect((await h.mock.state()).jobs).toHaveLength(1);
    },
    T,
  );
});

describe('mock reset (diagnostics) keeps the delete path when the reset fails', () => {
  it(
    'POST /__test/reset unreachable → result err, local op and journal kept, delete still works',
    async () => {
      const h = await harness({
        wrapHttp: (http) => ({
          request: (req) =>
            req.url.endsWith('/__test/reset')
              ? Promise.resolve({ ok: false as const, error: { cause: 'unreachable' as const } })
              : http.request(req),
        }),
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      const result = await h.controller.diagnostics.resetMockAndLocal();
      expect(result.ok).toBe(false);
      expect(viewLabel(h.controller.getSnapshot())).toBe('job:ready');
      expect(h.store.disk.size).toBe(1);
      await h.controller.requestDelete();
      await waitFor(h.controller, (s) => s.view.tag === 'deleted', { label: 'deleted' });
    },
    T,
  );

  it(
    'reset while a copy is in progress: the UI never stays in "preparing"',
    async () => {
      const gate = deferred();
      const entered = deferred();
      const h = await harness({
        wrapFiles: (files): FilesPort => ({
          ...files,
          async copyIn(source, dest, limit) {
            entered.resolve();
            await gate.promise;
            return files.copyIn(source, dest, limit);
          },
        }),
      });
      const pending = h.controller.prepareFile(picked(FIXTURES.csv, 'statement.csv'));
      await entered.promise;
      expect(h.controller.getSnapshot().view.tag).toBe('preparing');
      expect((await h.controller.diagnostics.resetMockAndLocal()).ok).toBe(true);
      gate.resolve();
      expect(await pending).toEqual({ ok: false, error: { reason: 'busy' } });
      const s = h.controller.getSnapshot();
      expect(s.view.tag).toBe('empty');
      expect(s.actions.pickFile).toBe(true);
      expect((await h.controller.prepareFile(picked(FIXTURES.csv, 'statement.csv'))).ok).toBe(true);
    },
    T,
  );
});

describe('process death during a journal write', () => {
  it(
    'dispose while `sending` is being written: the dead controller sends nothing',
    async () => {
      const gate = deferred();
      const entered = deferred();
      const base = createMemoryStore();
      const store: MemoryStore = {
        ...base,
        async upsert(row) {
          if (phaseOf(row.body) === 'sending') {
            entered.resolve();
            await gate.promise;
          }
          return base.upsert(row);
        },
      };
      const h = await harness({ store });
      const draft = await h.controller.prepareFile(picked(FIXTURES.csv, 'statement.csv'));
      if (!draft.ok) throw new Error('rejected');
      const confirm = h.controller.confirmSend(draft.value.draftId);
      await entered.promise;
      h.controller.dispose();
      gate.resolve();
      await confirm;
      await sleep(300);
      expect(h.traffic.filter((r) => r.method === 'POST')).toEqual([]);
      expect((await h.mock.stats()).createRequests).toBe(0);
    },
    T,
  );
});

describe('private copy survives a moved app container (iOS update / restore)', () => {
  it(
    'a persisted absolute tempPath from an old container is re-derived from the opId; resend works',
    async () => {
      // First POST and the one automatic same-key re-POST are both cut: tap options remain.
      const h = await harness({
        upload: { behaviour: (n) => (n <= 2 ? { dropAfterBytes: 40 } : undefined) },
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'outcome_unknown' && s.view.lookup === 'not_found',
        { label: 'not_found' },
      );
      await waitIdle(h.controller);
      // Simulate the container move: the journal holds the old absolute path.
      for (const [opId, body] of h.store.disk) {
        const op = JSON.parse(body) as { file: { tempPath: string | null } };
        op.file.tempPath = `/old-container/Library/Caches/imports/${opId}.bin`;
        h.store.disk.set(opId, JSON.stringify(op));
      }
      await h.relaunch();
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'outcome_unknown' && s.view.lookup === 'not_found',
        { label: 'not_found after relaunch' },
      );
      expect(await h.files.leftovers()).toHaveLength(1);
      const s = h.controller.getSnapshot();
      expect(s.actions.resend).toBe(true);
      await h.controller.resend();
      await waitReady(h);
      expect(h.controller.getSnapshot().notice).toBeNull();
      expect((await h.mock.stats()).newJobs).toBe(1);
    },
    T,
  );
});

describe('size limit is enforced on the private copy (R3, C5)', () => {
  function writeCsvOfSize(dir: string, name: string, size: number): string {
    const header = 'date,description,amount\n';
    const body = Buffer.alloc(size, 0x61);
    body.write(header, 0, 'latin1');
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  for (const mode of ['bounded', 'unbounded'] as const) {
    it(
      `${mode} copy: exactly 10 485 760 bytes is accepted; 10 485 761 is rejected before POST`,
      async () => {
        const h = await harness({ files: { copyMode: mode } });
        const before = await h.mock.stats();
        const equal = writeCsvOfSize(h.root, 'equal.csv', MAX_FILE_BYTES);
        const over = writeCsvOfSize(h.root, 'over.csv', MAX_FILE_BYTES + 1);
        // Declared sizes as a picker would report them.
        const accepted = await h.controller.prepareFile(picked(equal, 'equal.csv', MAX_FILE_BYTES));
        expect(accepted.ok && accepted.value.size).toBe(MAX_FILE_BYTES);
        await h.controller.cancelDraft();
        const rejected = await h.controller.prepareFile(picked(over, 'over.csv', null));
        expect(rejected.ok ? 'accepted' : rejected.error.reason).toBe('oversize');
        expect(await h.files.leftovers()).toEqual([]);
        expect(statsDelta(before, await h.mock.stats()).createRequests).toBe(0);
      },
      T,
    );
  }

  it(
    'lying picker metadata + an unbounded copy (iOS move): the post-copy size check rejects it',
    async () => {
      const h = await harness({ files: { copyMode: 'unbounded' } });
      const before = await h.mock.stats();
      const over = writeCsvOfSize(h.root, 'lying.csv', MAX_FILE_BYTES + 1);
      const rejected = await h.controller.prepareFile(picked(over, 'lying.csv', 1024));
      expect(rejected).toEqual({
        ok: false,
        error: { reason: 'oversize', size: MAX_FILE_BYTES + 1 },
      });
      expect(await h.files.leftovers()).toEqual([]);
      expect(statsDelta(before, await h.mock.stats()).createRequests).toBe(0);
    },
    T,
  );

  it(
    'a failed copy still releases the picker temp copy (R11: removed on local rejection)',
    async () => {
      const h = await harness();
      const released = h.files.releasedCount();
      const result = await h.controller.prepareFile(
        picked(join(h.root, 'missing.csv'), 'missing.csv'),
      );
      expect(result).toEqual({ ok: false, error: { reason: 'unreadable' } });
      expect(h.files.releasedCount()).toBe(released + 1);
    },
    T,
  );
});
