// The bounded in-session same-key re-POST (owner decision on the TZ rule «404 означает
// «пока не найден». При гонке повторяйте POST с тем же ключом»), against the real mock:
//   (a) reset_after_send + by-key 404 → exactly one automatic re-POST → ready, newJobs = 1;
//   (b) the automatic re-POST fails too → tap options, no third POST without a tap;
//   (c) cancel / abandon → never an automatic re-POST;
//   (d) cold start with outcome_unknown → no POST before a tap (C7 unchanged);
//   (e) not_sent / unreachable are not a race → no automatic re-POST;
//   (f) lost_ack race: the first POST commits late (slow uplink) → the re-POST is a duplicate hit,
//       same jobId, newJobs = 1.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeOperation } from '../../src/core/codec';
import type { UploadPort } from '../../src/core';
import {
  createHarness,
  FIXTURES,
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
import { createMemoryStore, type RecordedRequest } from '../support/node-ports';
import { startThrottleProxy } from '../support/throttle-proxy';

const T = 25_000;
const open: Harness[] = [];
const cleanups: (() => Promise<void>)[] = [];
async function harness(options?: HarnessOptions): Promise<Harness> {
  const h = await createHarness(options);
  open.push(h);
  await h.controller.start();
  return h;
}
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const posts = (h: Harness): RecordedRequest[] =>
  h.traffic.filter((r) => r.method === 'POST' && r.path === '/imports');
const autoLogs = (h: Harness): number =>
  h.logger.entries.filter((e) => e.event === 'post_auto_resend').length;
const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** Waits until the op sits in outcome_unknown with the tap options (lookup said 404). */
const waitNotFound = (h: Harness, label = 'outcome_unknown/not_found') =>
  waitFor(h.controller, (s) => s.view.tag === 'outcome_unknown' && s.view.lookup === 'not_found', {
    label,
  });

describe('(a) reset_after_send + by-key 404 → one automatic same-key re-POST', () => {
  it(
    'no tap: two POSTs with the same key, name and bytes; ready; newJobs = 1',
    async () => {
      const h = await harness({
        upload: { behaviour: (n) => (n === 1 ? { dropAfterBytes: 50 } : undefined) },
      });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitReady(h);
      await waitIdle(h.controller);
      const sent = posts(h);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.headers['Idempotency-Key']).toBe(sent[0]?.headers['Idempotency-Key']);
      expect(sent[1]?.headers['X-File-Name']).toBe(sent[0]?.headers['X-File-Name']);
      expect(autoLogs(h)).toBe(1);
      // Same bytes: the job holds exactly the fixture (size + sha256).
      const state = await h.mock.state();
      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0]?.bytes).toBe(statSync(FIXTURES.csv).size);
      expect(state.jobs[0]?.sha256).toBe(sha256(FIXTURES.csv));
      expect(statsDelta(before, state.stats)).toMatchObject({ createRequests: 2, newJobs: 1 });
      // The honest sending state was shown, then never the tap options.
      expect(h.snapshots.some((s) => s.view.tag === 'sending' && s.view.autoRetry)).toBe(true);
      expect(h.history).not.toContain('outcome_unknown:reset_after_send/not_found');
      // Nothing about it is persisted (a fresh session must never inherit the permission).
      for (const body of h.store.disk.values()) expect(body).not.toMatch(/auto/i);
      expect(await h.files.leftovers()).toEqual([]);
    },
    T,
  );
});

describe('(b) the automatic re-POST fails too', () => {
  it(
    'tap options; no third POST without a tap; the tap then creates the one job',
    async () => {
      const h = await harness({
        upload: { behaviour: (n) => (n <= 2 ? { dropAfterBytes: 40 } : undefined) },
      });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const unknown = await waitNotFound(h);
      expect(unknown.actions).toMatchObject({ checkAgain: true, resend: true, abandon: true });
      expect(unknown.view.tag === 'outcome_unknown' && unknown.view.attempt).toBe(2);
      await sleep(1500);
      expect(posts(h)).toHaveLength(2);
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 2,
        newJobs: 0,
      });
      // "Проверить снова" → another 404 → still no POST.
      await h.controller.checkAgain();
      await waitNotFound(h, 'not_found after check again');
      await sleep(300);
      expect(posts(h)).toHaveLength(2);
      await h.controller.resend();
      await waitReady(h);
      expect(posts(h)).toHaveLength(3);
      expect(new Set(posts(h).map((r) => r.headers['Idempotency-Key'])).size).toBe(1);
      expect(autoLogs(h)).toBe(1);
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 3,
        newJobs: 1,
      });
    },
    T,
  );
});

describe('(c) cancel / abandon never auto-resend', () => {
  it(
    'cancel while the first POST runs: abandon + settle → cancelled; one POST only',
    async () => {
      const h = await harness({
        upload: { behaviour: () => ({ chunkBytes: 8, chunkDelayMs: 40 }) },
      });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(
        h.controller,
        (s) => s.view.tag === 'sending' && (s.view.progress?.bytesSent ?? 0) > 0,
        { label: 'progress' },
      );
      await h.controller.cancelSending();
      await waitFor(h.controller, (s) => s.view.tag === 'cancelled', { label: 'cancelled' });
      await sleep(300);
      expect(posts(h)).toHaveLength(1);
      expect(autoLogs(h)).toBe(0);
      expect(statsDelta(before, await h.mock.stats()).newJobs).toBe(0);
    },
    T,
  );

  it(
    '"Отмена" during the automatic re-POST behaves like cancel while sending; no third POST',
    async () => {
      const h = await harness({
        upload: {
          behaviour: (n) =>
            n === 1 ? { dropAfterBytes: 40 } : { chunkBytes: 8, chunkDelayMs: 40 },
        },
      });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      const auto = await waitFor(
        h.controller,
        (s) =>
          s.view.tag === 'sending' && s.view.autoRetry && (s.view.progress?.bytesSent ?? 0) > 0,
        { label: 'automatic re-POST in progress' },
      );
      expect(auto.actions.cancelSending).toBe(true);
      await h.controller.cancelSending();
      await waitFor(h.controller, (s) => s.view.tag === 'cancelled', { label: 'cancelled' });
      // The settle rule ran (404 is «пока не найден»), and nothing was sent again.
      expect(h.history).toContain('outcome_unknown:reset_after_send/settling');
      await sleep(300);
      expect(posts(h)).toHaveLength(2);
      expect(statsDelta(before, await h.mock.stats()).newJobs).toBe(0);
      expect(await h.files.leftovers()).toEqual([]);
    },
    T,
  );

  it(
    '"Отказаться" after the failed automatic re-POST: final 404s → cancelled, no POST',
    async () => {
      const h = await harness({
        upload: { behaviour: (n) => (n <= 2 ? { dropAfterBytes: 40 } : undefined) },
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitNotFound(h);
      await h.controller.abandon();
      await waitFor(h.controller, (s) => s.view.tag === 'cancelled', { label: 'cancelled' });
      expect(posts(h)).toHaveLength(2);
    },
    T,
  );
});

describe('(d) cold start never auto-sends (C7)', () => {
  it(
    'process dies right before the automatic re-POST is persisted → relaunch: 404, no POST before a tap',
    async () => {
      // Upserts: #1 pending_send, #2 sending(1), #3 outcome_unknown, #4 sending(2) of the automatic
      // re-POST → the process dies before #4 lands, so that POST never leaves either.
      const store = createMemoryStore(new Map(), { nthUpsert: 4, when: 'before_write' });
      const h = await harness({
        store,
        upload: { behaviour: (n) => (n === 1 ? { dropAfterBytes: 50 } : undefined) },
      });
      const before = await h.mock.stats();
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitFor(h.controller, (s) => s.storageError, { label: 'process death' });
      await sleep(200);
      expect(posts(h)).toHaveLength(1);
      const [body] = [...h.store.disk.values()];
      const persisted = body === undefined ? null : decodeOperation(body);
      expect(persisted?.ok && persisted.value.phase).toMatchObject({
        tag: 'outcome_unknown',
        cause: 'reset_after_send',
      });

      await h.relaunch();
      const after = await waitNotFound(h, 'not_found after relaunch');
      expect(viewLabel(after)).toBe('outcome_unknown:reset_after_send/not_found');
      expect(after.actions.resend).toBe(true);
      await sleep(1500);
      expect(posts(h)).toHaveLength(1);
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 1,
        newJobs: 0,
      });
      await h.controller.resend();
      await waitReady(h);
      expect(posts(h)).toHaveLength(2);
      expect(statsDelta(before, await h.mock.stats())).toMatchObject({
        createRequests: 2,
        newJobs: 1,
      });
    },
    T,
  );

  it(
    'relaunch after a tapped resend failed again: still no automatic POST in that session',
    async () => {
      // n=1 cut, auto n=2 cut (in-session); relaunch; tapped n=3 cut → 404 → tap options only.
      const h = await harness({
        upload: { behaviour: (n) => (n <= 3 ? { dropAfterBytes: 40 } : undefined) },
      });
      await sendFixture(h, FIXTURES.csv, 'statement.csv');
      await waitNotFound(h);
      await waitIdle(h.controller);
      await h.relaunch();
      await waitNotFound(h, 'not_found after relaunch');
      await h.controller.resend();
      await waitFor(
        h.controller,
        (s) =>
          s.view.tag === 'outcome_unknown' && s.view.lookup === 'not_found' && s.view.attempt === 3,
        { label: 'tapped resend cut, 404' },
      );
      await sleep(1000);
      expect(posts(h)).toHaveLength(3);
      expect(autoLogs(h)).toBe(1);
    },
    T,
  );
});

describe('(e) not_sent / unreachable are not a race', () => {
  for (const cause of ['unreachable', 'not_sent'] as const) {
    it(
      `first POST ${cause} (nothing received) → no automatic re-POST`,
      async () => {
        let uploads = 0;
        const failFirst = (upload: UploadPort): UploadPort => ({
          upload(req) {
            uploads += 1;
            if (uploads === 1) return Promise.resolve({ ok: false as const, error: { cause } });
            return upload.upload(req);
          },
        });
        const h = await harness({ wrapUpload: failFirst });
        const before = await h.mock.stats();
        await sendFixture(h, FIXTURES.csv, 'statement.csv');
        const s = await waitFor(
          h.controller,
          (x) =>
            x.view.tag === 'outcome_unknown' &&
            (x.view.lookup === 'not_found' || x.view.lookup === 'skipped'),
          { label: 'tap options' },
        );
        // unreachable: the genuine by-key 404 came back; not_sent: nothing to look up.
        expect(viewLabel(s)).toBe(
          cause === 'unreachable'
            ? 'outcome_unknown:unreachable/not_found'
            : 'outcome_unknown:not_sent/skipped',
        );
        await sleep(1000);
        expect(uploads).toBe(1);
        expect(autoLogs(h)).toBe(0);
        expect(statsDelta(before, await h.mock.stats()).createRequests).toBe(0);
        expect(s.actions.resend).toBe(true);
      },
      T,
    );
  }
});

describe('(f) lost_ack race: the first POST commits late over a slow uplink', () => {
  it(
    'first POST times out with its bytes still in flight → by-key 404 → automatic re-POST hits the duplicate: same jobId, newJobs = 1',
    async () => {
      const mock: RunningMock = await startMock();
      // ~34 KB PDF at 17 B/ms ≈ 2 s per upload through the proxy; the first one gives up at 600 ms.
      const proxy = await startThrottleProxy(Number(new URL(mock.baseUrl).port), 17);
      cleanups.push(async () => {
        await proxy.close();
        await mock.close();
      });
      let uploads = 0;
      const shortFirstTimeout = (upload: UploadPort): UploadPort => ({
        upload(req) {
          uploads += 1;
          return upload.upload(uploads === 1 ? { ...req, timeoutMs: 600 } : req);
        },
      });
      const h = await harness({
        mock: { ...mock, baseUrl: `http://127.0.0.1:${proxy.port}` },
        wrapUpload: shortFirstTimeout,
      });
      const before = await mock.stats();
      await sendFixture(h, FIXTURES.pdf, 'statement.pdf');
      const job = await waitFor(h.controller, (s) => s.view.tag === 'job', {
        label: 'job',
        timeoutMs: 15_000,
      });
      const state = await mock.state();
      expect(h.history).toContain('outcome_unknown:timeout/pending');
      expect(h.snapshots.some((s) => s.view.tag === 'sending' && s.view.autoRetry)).toBe(true);
      expect(posts(h)).toHaveLength(2);
      expect(new Set(posts(h).map((r) => r.headers['Idempotency-Key'])).size).toBe(1);
      expect(statsDelta(before, state.stats)).toMatchObject({
        createRequests: 2,
        newJobs: 1,
        duplicateHits: 1,
        acceptedBytes: statSync(FIXTURES.pdf).size,
      });
      expect(state.jobs).toHaveLength(1);
      expect(job.diagnostics.jobId).toBe(state.jobs[0]?.jobId);
      // The 202 of the duplicate is a normal POST answer, not a by-key recovery.
      expect(job.view.tag === 'job' && job.view.op.recoveredByKey).toBe(false);
    },
    T,
  );
});
