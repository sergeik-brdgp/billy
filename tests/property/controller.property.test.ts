// Property test of the imperative shell: the real controller with fake ports whose responses are
// deferred and resolved in random order. Checks, after every step of a random interleaving of user
// commands, responses, timer ticks and relaunches:
//   I5  at most one POST, one DELETE and one read in flight (per live controller);
//   I6  when a POST / DELETE leaves, the journal already holds `sending` / `delete_requested`;
//   I7  a POST only leaves during a user "Отправить" / "Отправить снова", or as the one automatic
//       same-key re-POST right after a genuine by-key 404 — at most once per op per controller
//       instance, and only in the instance that sent that op's first POST (never after relaunch);
//   I9  at most one non-terminal op in the journal; "Новый импорт" never offered next to one.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createImportController,
  err,
  ok,
  type ClockPort,
  type FilesPort,
  type HttpPort,
  type HttpResponse,
  type ImportController,
  type Result,
  type StorePort,
  type TransportError,
  type UploadPort,
} from '../../src/core';
import { decodeOperation } from '../../src/core/codec';
import { createMemoryStore, type MemoryStore } from '../support/node-ports';

type Kind = 'post' | 'lookup' | 'get' | 'del';

const TERMINAL = new Set(['deleted', 'lost', 'cancelled', 'rejected_by_server']);
const isTerminalTag = (tag: string): boolean => TERMINAL.has(tag);

interface Pending {
  readonly kind: Kind;
  readonly instance: number;
  readonly resolve: (value: Result<HttpResponse, TransportError>) => void;
  settled: boolean;
}

const CSV = Uint8Array.from('date,description,amount\n2026-10-01,X,-1\n', (c) => c.charCodeAt(0));

function fakeFiles(): FilesPort {
  const disk = new Map<string, Uint8Array>([['picker://statement.csv', CSV]]);
  return {
    pathFor: (opId) => `/private/imports/${opId}.bin`,
    async copyIn(source, dest, limit) {
      const bytes = disk.get(source.uri);
      if (!bytes) return err({ kind: 'unreadable' });
      if (bytes.length > limit) return err({ kind: 'too_large' });
      disk.set(dest, bytes);
      return ok({ bytes: bytes.length });
    },
    async releasePicked() {},
    exists: async (path) => disk.has(path),
    size: async (path) => {
      const bytes = disk.get(path);
      return bytes ? ok(bytes.length) : err({ kind: 'not_found' });
    },
    readHeader: async (path, n) => {
      const bytes = disk.get(path);
      return bytes ? ok(bytes.subarray(0, n)) : err({ kind: 'not_found' });
    },
    delete: async (path) => {
      disk.delete(path);
      return ok(undefined);
    },
    listPrivate: async () => ok([...disk.keys()].filter((p) => p.startsWith('/private/'))),
    async sweepPlatformCaches() {},
  };
}

function fakeClock(): ClockPort & { fire(): void } {
  let timers: { id: number; fn: () => void }[] = [];
  let next = 1;
  let now = 1_000;
  return {
    now: () => now,
    setTimeout(fn) {
      const id = next++;
      timers.push({ id, fn });
      return id;
    },
    clearTimeout(handle) {
      timers = timers.filter((t) => t.id !== handle);
    },
    fire() {
      now += 3_000;
      const due = timers;
      timers = [];
      for (const t of due) t.fn();
    },
  };
}

const view = (status: string, revision: number, jobId = 'job-demo-001'): HttpResponse => ({
  status: 200,
  bodyText: JSON.stringify(
    status === 'ready'
      ? { jobId, status, revision, currency: 'AUD', items: [] }
      : { jobId, status, revision },
  ),
});

function responseFor(kind: Kind, seed: number): Result<HttpResponse, TransportError> {
  const statuses = ['queued', 'processing', 'ready', 'deleting', 'deleted'];
  switch (kind) {
    case 'post': {
      const accepted = ok({
        status: 202,
        bodyText: '{"jobId":"job-demo-001","status":"queued","revision":1}',
      });
      const other: Result<HttpResponse, TransportError>[] = [
        err({ cause: 'reset_after_send' }),
        err({ cause: 'timeout' }),
        ok({ status: 415, bodyText: '{"error":"unsupported file bytes"}' }),
        ok({ status: 503, bodyText: '{}' }),
      ];
      return seed % 10 < 6 ? accepted : (other[seed % 4] as Result<HttpResponse, TransportError>);
    }
    case 'lookup':
    case 'get': {
      const pick = seed % 12;
      if (pick < 9)
        return ok(
          view(
            statuses[seed % 5] ?? 'ready',
            seed % 6,
            seed % 13 === 0 ? 'job-demo-002' : 'job-demo-001',
          ),
        );
      if (pick === 9) return ok({ status: 404, bodyText: '{"error":"job not found"}' });
      if (pick === 10) return ok({ status: 404, bodyText: '{"error":"route not found"}' });
      return err({ cause: 'timeout' });
    }
    case 'del':
      return [
        ok({ status: 202, bodyText: '{"jobId":"job-demo-001","status":"deleting","revision":4}' }),
        ok({ status: 202, bodyText: '{"jobId":"job-demo-001","status":"deleted","revision":5}' }),
        ok({ status: 503, bodyText: '{"error":"temporary delete failure"}' }),
        ok({ status: 404, bodyText: '{"error":"job not found"}' }),
        err({ cause: 'reset_after_send' }),
      ][seed % 5] as Result<HttpResponse, TransportError>;
    default:
      throw new Error(kind satisfies never);
  }
}

type Command =
  | 'pickAndSend'
  | 'cancelDraft'
  | 'cancelSending'
  | 'checkAgain'
  | 'resend'
  | 'abandon'
  | 'refresh'
  | 'requestDelete'
  | 'retryDelete'
  | 'newImport'
  | 'onForeground'
  | 'onBackground';

type Step =
  | { readonly k: 'cmd'; readonly cmd: Command }
  | {
      readonly k: 'resolve';
      readonly index: number;
      readonly seed: number;
      readonly anyInstance: boolean;
    }
  | { readonly k: 'fire' }
  | { readonly k: 'relaunch' };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .constantFrom<Command>(
        'pickAndSend',
        'pickAndSend',
        'cancelDraft',
        'cancelSending',
        'checkAgain',
        'resend',
        'abandon',
        'refresh',
        'requestDelete',
        'requestDelete',
        'requestDelete',
        'retryDelete',
        'retryDelete',
        'refresh',
        'newImport',
        'onForeground',
        'onBackground',
      )
      .map((cmd) => ({ k: 'cmd' as const, cmd })),
  },
  {
    weight: 6,
    arbitrary: fc
      .tuple(fc.nat(10), fc.nat(1000), fc.nat(9))
      // Mostly answer the live controller; sometimes answer a request of a dead one (late response).
      .map(([index, seed, any]) => ({
        k: 'resolve' as const,
        index,
        seed,
        anyInstance: any === 0,
      })),
  },
  { weight: 2, arbitrary: fc.constant<Step>({ k: 'fire' }) },
  { weight: 1, arbitrary: fc.constant<Step>({ k: 'relaunch' }) },
);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

function journalPhase(store: MemoryStore): string[] {
  const phases: string[] = [];
  for (const body of store.disk.values()) {
    const decoded = decodeOperation(body);
    if (decoded.ok) phases.push(decoded.value.phase.tag);
  }
  return phases;
}

const coverage = { views: new Set<string>(), requests: new Map<Kind, number>() };
let autoTotal = 0;

async function runScenario(steps: readonly Step[]): Promise<void> {
  const pending: Pending[] = [];
  const violations: string[] = [];
  let instance = 0;
  let userMaySend = false;
  let userSending: Command | null = null;
  /** Every key that was ever POSTed (across instances). */
  const postedKeys = new Set<string>();
  /** Keys whose first POST left during "Отправить" in the live controller instance. */
  let firstSentHere = new Set<string>();
  /** Automatic POSTs per key in the live controller instance. */
  let autoPosts = new Map<string, number>();
  /** The response being delivered right now (an automatic POST may only follow a by-key 404). */
  let delivering: { kind: Kind; jobNotFound: boolean } | null = null;
  let store = createMemoryStore();
  const files = fakeFiles();
  const clock = fakeClock();

  const issue = (
    kind: Kind,
    signal?: AbortSignal,
    key?: string,
  ): Promise<Result<HttpResponse, TransportError>> =>
    new Promise((resolve) => {
      const entry: Pending = { kind, instance, resolve, settled: false };
      const phases = journalPhase(store);
      if (kind === 'post') {
        const k = key ?? '';
        if (userMaySend) {
          if (userSending === 'pickAndSend' && !firstSentHere.has(k) && !postedKeys.has(k)) {
            firstSentHere.add(k);
          }
        } else {
          const n = autoPosts.get(k) ?? 0;
          if (delivering?.kind !== 'lookup' || !delivering.jobNotFound)
            violations.push('I7: automatic POST not right after a by-key 404');
          if (!firstSentHere.has(k))
            violations.push('I7: automatic POST in an instance that did not send the first POST');
          if (n >= 1) violations.push('I7: second automatic POST for the same op');
          autoPosts.set(k, n + 1);
          autoTotal += 1;
        }
        postedKeys.add(k);
        if (!phases.includes('sending'))
          violations.push(`I6: POST while journal = ${phases.join(',')}`);
      }
      if (kind === 'del' && !phases.includes('delete_requested')) {
        violations.push(`I6: DELETE while journal = ${phases.join(',')}`);
      }
      signal?.addEventListener('abort', () => {
        if (entry.settled) return;
        entry.settled = true;
        resolve(err({ cause: 'reset_after_send' }));
      });
      pending.push(entry);
      coverage.requests.set(kind, (coverage.requests.get(kind) ?? 0) + 1);
    });

  const http: HttpPort = {
    request: (req) =>
      issue(req.method === 'DELETE' ? 'del' : req.url.includes('/by-key/') ? 'lookup' : 'get'),
  };
  const upload: UploadPort = {
    upload: (req) => issue('post', req.signal, req.headers['Idempotency-Key']),
  };
  // The journal write lands one macrotask later, so a runner that did not await it would be caught.
  const slowStore = (): StorePort => ({
    loadAll: () => store.loadAll(),
    remove: (opId) => store.remove(opId),
    upsert: async (row) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return store.upsert(row);
    },
  });
  const make = (): ImportController =>
    createImportController({
      baseUrl: 'http://mock.test',
      http,
      upload,
      files,
      store: slowStore(),
      clock,
      ids: { uuid: () => globalThis.crypto.randomUUID() },
      logger: { log: () => undefined },
    });

  let controller = make();
  await controller.start();

  const check = (label: string): void => {
    const live = pending.filter((p) => !p.settled && p.instance === instance);
    const count = (kinds: Kind[]): number => live.filter((p) => kinds.includes(p.kind)).length;
    if (count(['post']) > 1) violations.push(`I5 post @${label}`);
    if (count(['del']) > 1) violations.push(`I5 delete @${label}`);
    if (count(['lookup', 'get']) > 1) violations.push(`I5 read @${label}`);
    const nonTerminal = journalPhase(store).filter((tag) => !isTerminalTag(tag));
    if (nonTerminal.length > 1) violations.push(`I9 journal ${nonTerminal.join(',')} @${label}`);
    const snap = controller.getSnapshot();
    coverage.views.add(snap.view.tag);
    const activeView = ![
      'empty',
      'starting',
      'preparing',
      'confirm',
      'local_rejection',
      'deleted',
      'lost',
      'rejected_by_server',
      'cancelled',
    ].includes(snap.view.tag);
    if (activeView && (snap.actions.newImport || snap.actions.pickFile))
      violations.push(`I9 newImport next to ${snap.view.tag}`);
  };

  for (const step of steps) {
    switch (step.k) {
      case 'cmd': {
        userMaySend = step.cmd === 'pickAndSend' || step.cmd === 'resend';
        userSending = step.cmd;
        if (step.cmd === 'pickAndSend') {
          const draft = await controller.prepareFile({
            uri: 'picker://statement.csv',
            name: 'statement.csv',
            declaredSize: CSV.length,
          });
          if (draft.ok) await controller.confirmSend(draft.value.draftId);
        } else {
          await controller[step.cmd]();
        }
        await settle();
        userMaySend = false;
        userSending = null;
        break;
      }
      case 'resolve': {
        const open = pending.filter(
          (p) => !p.settled && (step.anyInstance || p.instance === instance),
        );
        const target = open[step.index % Math.max(1, open.length)];
        if (target) {
          target.settled = true;
          const response = responseFor(target.kind, step.seed);
          delivering = {
            kind: target.kind,
            jobNotFound:
              response.ok &&
              response.value.status === 404 &&
              response.value.bodyText === '{"error":"job not found"}',
          };
          target.resolve(response);
        }
        await settle();
        delivering = null;
        break;
      }
      case 'fire':
        clock.fire();
        await settle();
        break;
      case 'relaunch':
        controller.dispose();
        instance += 1;
        // A new process: nothing it inherits may let it auto-send.
        firstSentHere = new Set();
        autoPosts = new Map();
        store = store.revive();
        controller = make();
        await controller.start();
        await settle();
        break;
    }
    check(step.k === 'cmd' ? step.cmd : step.k);
  }
  controller.dispose();
  expect(violations).toEqual([]);
}

describe('controller runner under random interleavings (I5, I6, I7 incl. auto re-POST, I9)', () => {
  it('holds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 10, maxLength: 80 }), (steps) =>
        runScenario(steps),
      ),
      // Fixed seed: reproducible results (FC_SEED=<n> explores other interleavings locally).
      { numRuns: 500, seed: Number(process.env.FC_SEED ?? 20261027) },
    );
    // Not vacuous: every request kind was exercised and the interesting states were reached.
    expect(coverage.requests.get('post') ?? 0).toBeGreaterThan(100);
    expect(coverage.requests.get('lookup') ?? 0).toBeGreaterThan(100);
    expect(coverage.requests.get('get') ?? 0).toBeGreaterThan(30);
    expect(coverage.requests.get('del') ?? 0).toBeGreaterThan(10);
    // The automatic same-key re-POST really happened through the real runner (fixed seed). The
    // race-focused reducer property exercises it hundreds of times; here it proves the wiring.
    expect(autoTotal).toBeGreaterThan(0);
    // (`cancelled` / `lost` are rarer here; their reachability is asserted in the reducer property.)
    for (const tag of [
      'sending',
      'outcome_unknown',
      'job',
      'delete_failed',
      'deleting',
      'deleted',
    ]) {
      expect(coverage.views).toContain(tag);
    }
  }, 60_000);
});
