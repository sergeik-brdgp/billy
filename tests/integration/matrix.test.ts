// Acceptance matrix (assignment) + extra rows, each through the real core, Node adapters
// and the REAL unchanged mock. Every test asserts exact GET /__test/state counter deltas.

import { describe, expect, it } from 'vitest';

import { MAX_FILE_BYTES } from '../../src/core';
import {
  deleteFailure,
  differentialValidator,
  happy,
  interruptedUpload,
  keyPersistedBeforePost,
  lostAckInSession,
  lostAckRelaunch,
  noteFor,
  repeatedDelete,
  resetSafety,
  spoofedAndOversize,
  staleStatus,
} from '../support/scenarios';
import type { InterruptedChecks, ScenarioResult } from '../support/scenarios';

const T = 20_000;

describe('matrix notes are derived from the run, not hard-coded', () => {
  it('interrupted_upload prints the measured automatic re-POST count', () => {
    const checks: InterruptedChecks = {
      deltasWithoutTap: {
        createRequests: 3,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: 1,
        deleteRequests: 0,
      },
      sawAutoRetry: true,
      appPosts: 3,
      autoPosts: 2,
      sameKey: false,
      sameFileName: false,
      localSize: 1,
    };
    const result: ScenarioResult<InterruptedChecks> = {
      id: 'interrupted_upload',
      title: '',
      deltas: checks.deltasWithoutTap,
      finalView: 'job:ready',
      history: [],
      checks,
    };
    const note = noteFor(result);
    expect(note).toContain('app POSTs=3 (2 automatic,');
  });
});

describe('acceptance matrix (real mock, exact counter deltas)', () => {
  for (const format of ['csv', 'pdf'] as const) {
    it(
      `happy (${format}): файл реально отправлен; 202 не объявлен готовым отчётом; после ready видны данные mock`,
      async () => {
        const r = await happy(format);
        expect(r.deltas).toEqual({
          createRequests: 1,
          newJobs: 1,
          duplicateHits: 0,
          acceptedBytes: r.checks.localSize,
          deleteRequests: 0,
        });
        expect(r.checks.serverBytes).toBe(r.checks.localSize);
        // 202 is shown as queued, never as a report.
        expect(r.history.slice(0, 6)).toEqual([
          'starting',
          'empty',
          'preparing',
          'confirm',
          'sending',
          'job:queued',
        ]);
        expect(r.checks.firstJobView).toBe('job:queued');
        expect(r.checks.reportBeforeReady).toBe(false);
        expect(r.finalView).toBe('job:ready');
        expect(r.checks.revision).toBe(3);
        expect(r.checks.items).toEqual([
          'StreamBeam — 19.99 AUD, monthly, last charged 1 Oct 2026',
          'BrightGrid — 132.00 AUD, monthly, last charged 3 Oct 2026',
        ]);
        expect(r.checks.total).toBe('151.99 AUD/month');
        // Private copy removed once the server confirmed the job.
        expect(r.checks.leftovers).toEqual([]);
        expect(r.checks.postHeaders?.['Content-Type']).toBe('application/octet-stream');
        expect(r.checks.postHeaders?.['X-File-Name']).toBe(`statement.${format}`);
        expect(r.checks.postHeaders?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
      },
      T,
    );
  }

  it(
    'lost_ack: первый POST создал job без ответа; GET по ключу находит его; newJobs=1',
    async () => {
      const r = await lostAckInSession();
      expect(r.checks.deltasBeforeAnyTap).toEqual({
        createRequests: 1,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: 112,
        deleteRequests: 0,
      });
      expect(r.checks.sawOutcomeUnknown).toBe(true);
      expect(r.checks.recoveredByKey).toBe(true);
      expect(r.checks.appPosts).toBe(1);
      expect(r.checks.keyStable).toBe(true);
      expect(r.deltas.newJobs).toBe(1);
      expect(r.deltas.createRequests).toBe(1);
      expect(r.finalView).toBe('job:ready');
    },
    T,
  );

  it(
    'lost_ack + relaunch: после relaunch GET по ключу находит job без повторной отправки; newJobs=1',
    async () => {
      const r = await lostAckRelaunch();
      expect(r.checks.persistedPhaseAtDeath).toBe('sending');
      expect(r.checks.deltasBeforeAnyTap).toEqual({
        createRequests: 1,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: 112,
        deleteRequests: 0,
      });
      expect(r.checks.sawOutcomeUnknown).toBe(true);
      expect(r.checks.recoveredByKey).toBe(true);
      expect(r.checks.appPosts).toBe(1);
      expect(r.checks.keyStable).toBe(true);
      expect(r.deltas).toEqual({
        createRequests: 1,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: 112,
        deleteRequests: 0,
      });
      expect(r.finalView).toBe('job:ready');
    },
    T,
  );

  it(
    'stale_status: после ready/revision 3 приходит processing/revision 2; UI не откатывается',
    async () => {
      const r = await staleStatus();
      expect(r.checks.afterFirstRefresh).toEqual({ view: 'job:ready', revision: 3, ignored: 0 });
      expect(r.checks.afterSecondRefresh).toEqual({ view: 'job:ready', revision: 3, ignored: 1 });
      expect(r.checks.lastIgnored).toEqual({
        source: 'get',
        status: 'processing',
        revision: 2,
        currentRevision: 3,
        reason: 'stale_revision',
      });
      expect(r.checks.viewsAfterReady).toEqual(['job:ready']);
      expect(r.deltas).toEqual({
        createRequests: 1,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: 112,
        deleteRequests: 0,
      });
    },
    T,
  );

  it(
    'delete_failure: DELETE вернул 503; UI не утверждает удаление; после happy повтор с тем же ключом доходит до deleted',
    async () => {
      const r = await deleteFailure();
      expect(r.checks.afterFailure).toBe('delete_failed:http_5xx');
      expect(r.checks.deleteRequestsAfterFailure).toBe(1);
      expect(r.checks.claimedDeletedBeforeHappy).toBe(false);
      expect(r.checks.sameDeleteKey).toBe(true);
      expect(r.checks.deletingBeforeDeleted).toBe(true);
      expect(r.checks.deletedFrom).toMatch(/^(get|by_key):deleted\/r5$/);
      expect(r.checks.nameCleared).toBe(true);
      expect(r.checks.resultCleared).toBe(true);
      expect(r.checks.leftovers).toEqual([]);
      expect(r.deltas).toEqual({
        createRequests: 1,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: 112,
        deleteRequests: 2,
      });
      expect(r.finalView).toBe('deleted');
    },
    T,
  );

  it(
    'spoofed + oversize: оба файла отвергнуты до POST; createRequests до и после равны',
    async () => {
      const r = await spoofedAndOversize();
      expect(r.checks.oversizeBytes).toBeGreaterThan(MAX_FILE_BYTES);
      expect(r.checks.spoofed).toBe('not_statement');
      expect(r.checks.finalViewAfterSpoofed).toBe('local_rejection:not_statement');
      expect(r.checks.oversizeKnownSize).toBe('oversize');
      expect(r.checks.oversizeUnknownSize).toBe('oversize');
      expect(r.checks.oversizeLyingMetadata).toBe('oversize');
      expect(r.checks.leftovers).toEqual([]);
      expect(r.deltas).toEqual({
        createRequests: 0,
        newJobs: 0,
        duplicateHits: 0,
        acceptedBytes: 0,
        deleteRequests: 0,
      });
    },
    T,
  );
});

describe('extra rows beyond the TZ matrix (real mock)', () => {
  for (const action of ['refresh', 'delete'] as const) {
    it(
      `reset safety (${action}): чужой job-demo-001 после /__test/reset не трогается; наш → lost`,
      async () => {
        const r = await resetSafety(action);
        expect(r.checks.ourJobId).toBe('job-demo-001');
        expect(r.checks.foreignJobId).toBe('job-demo-001');
        expect(r.checks.requestsAfterReset).toEqual(['GET /imports/by-key/{key}']);
        expect(r.checks.touchedForeignJob).toBe(false);
        expect(r.checks.foreignStatus).not.toMatch(/delet/);
        expect(r.finalView).toBe('lost');
        expect(r.deltas.deleteRequests).toBe(0);
      },
      T,
    );
  }

  for (const crashAt of [1, 2] as const) {
    it(
      `key persisted before POST: crash after upsert #${crashAt} → key on disk, no request sent`,
      async () => {
        const r = await keyPersistedBeforePost(crashAt);
        expect(r.checks.deltasAfterCrash.createRequests).toBe(0);
        expect(r.checks.persistedPhase).toBe(crashAt === 1 ? 'pending_send' : 'sending');
        expect(r.checks.persistedKeyLength).toBe(36);
        // Relaunch looks the key up but never POSTs on its own.
        expect(r.checks.deltasAfterRelaunchBeforeTap.createRequests).toBe(0);
        expect(r.checks.viewAfterRelaunch).toBe('outcome_unknown:interrupted/not_found');
        expect(r.checks.resendUsedPersistedKey).toBe(true);
        expect(r.deltas).toEqual({
          createRequests: 1,
          newJobs: 1,
          duplicateHits: 0,
          acceptedBytes: 112,
          deleteRequests: 0,
        });
      },
      T,
    );
  }

  it(
    'interrupted mid-body upload: 404 by key = race → ONE automatic same-key re-POST, no tap → createRequests +2, newJobs +1',
    async () => {
      const r = await interruptedUpload();
      expect(r.checks.appPosts).toBe(2);
      expect(r.checks.autoPosts).toBe(1);
      expect(noteFor(r)).toContain('app POSTs=2 (1 automatic,');
      expect(r.checks.sameKey).toBe(true);
      expect(r.checks.sameFileName).toBe(true);
      expect(r.checks.sawAutoRetry).toBe(true);
      expect(r.checks.deltasWithoutTap).toEqual({
        createRequests: 2,
        newJobs: 1,
        duplicateHits: 0,
        acceptedBytes: r.checks.localSize,
        deleteRequests: 0,
      });
      expect(r.deltas).toEqual(r.checks.deltasWithoutTap);
      // Never `not_found` with tap options: the 404 went straight to the automatic re-POST.
      expect(r.history.slice(0, 8)).toEqual([
        'starting',
        'empty',
        'preparing',
        'confirm',
        'sending',
        'outcome_unknown:reset_after_send/pending',
        'sending',
        'job:queued',
      ]);
      expect(r.finalView).toBe('job:ready');
    },
    T,
  );

  it(
    'repeated DELETE with deleted/5 body → deleting (revision unchanged) → GET deleted/5 → deleted',
    async () => {
      const r = await repeatedDelete();
      expect(r.checks.afterDelete202).toEqual({
        view: 'deleting',
        revision: 3,
        body: 'deleted/r5',
      });
      expect(r.checks.deletedFrom).toMatch(/^(get|by_key):deleted\/r5$/);
      expect(r.deltas.deleteRequests).toBe(2);
      expect(r.deltas.newJobs).toBe(1);
      expect(r.finalView).toBe('deleted');
    },
    T,
  );

  it(
    'differential validator: 7-case table, client verdict == mock verdict (202/415)',
    async () => {
      const r = await differentialValidator();
      expect(r.checks).toHaveLength(7);
      for (const row of r.checks) {
        expect({ name: row.name, server: row.server }).toEqual({
          name: row.name,
          server: row.client === 'accept' ? 202 : 415,
        });
      }
      expect(r.checks.map((row) => row.client)).toEqual([
        'accept',
        'reject',
        'accept',
        'reject',
        'reject',
        'reject',
        'reject',
      ]);
    },
    T,
  );
});
