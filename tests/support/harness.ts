// Test harness: the real core (createImportController) wired to Node adapters and the real mock.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createImportController,
  type FilesPort,
  type HttpPort,
  type ImportController,
  type ImportSnapshot,
  type PickedFile,
  type UploadPort,
} from '../../src/core';
import { startMock, type RunningMock } from './mock';
import {
  createMemoryStore,
  createNodeFiles,
  createNodeHttp,
  createNodeUpload,
  createRecordingLogger,
  nodeIds,
  realClock,
  type MemoryStore,
  type NodeFiles,
  type NodeFilesOptions,
  type NodeUploadOptions,
  type RecordedRequest,
  type RecordingLogger,
} from './node-ports';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const FIXTURE_DIR = join(REPO_ROOT, 'mock-kit', 'fixtures');
export const FIXTURES = {
  csv: join(FIXTURE_DIR, 'statement.csv'),
  pdf: join(FIXTURE_DIR, 'statement.pdf'),
  spoofed: join(FIXTURE_DIR, 'spoofed.pdf'),
} as const;

export function picked(path: string, name: string, declaredSize: number | null = null): PickedFile {
  return { uri: path, name, declaredSize };
}

/** Same bytes as `mock-kit/make-oversize.mjs`, written to a temp dir (never into mock-kit/). */
export function writeOversize(dir: string): { path: string; size: number } {
  const header = 'date,description,amount\n';
  const row = '2026-09-01,Synthetic,-1.00\n';
  const limit = 10 * 1024 * 1024;
  const rows = Math.ceil((limit + 1 - Buffer.byteLength(header)) / Buffer.byteLength(row));
  const file = Buffer.from(header + row.repeat(rows));
  const path = join(dir, 'oversize.csv');
  writeFileSync(path, file);
  return { path, size: file.length };
}

/** Short human label of the current UI state, e.g. `job:ready`, `outcome_unknown:not_found`. */
export function viewLabel(snapshot: ImportSnapshot): string {
  const view = snapshot.view;
  switch (view.tag) {
    case 'job':
      return `job:${view.status}`;
    case 'outcome_unknown':
      return `outcome_unknown:${view.cause}/${view.lookup}`;
    case 'local_rejection':
      return `local_rejection:${view.rejection.reason}`;
    case 'delete_failed':
      return `delete_failed:${view.cause}`;
    default:
      return view.tag;
  }
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly label?: string;
}

export function waitFor(
  controller: ImportController,
  predicate: (snapshot: ImportSnapshot) => boolean,
  options: WaitOptions = {},
): Promise<ImportSnapshot> {
  const { timeoutMs = 8000, label = 'condition' } = options;
  return new Promise((resolvePromise, reject) => {
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(`Timed out waiting for ${label}; view=${viewLabel(controller.getSnapshot())}`),
      );
    }, timeoutMs);
    const check = (): boolean => {
      const snapshot = controller.getSnapshot();
      if (!predicate(snapshot)) return false;
      clearTimeout(timer);
      unsubscribe();
      resolvePromise(snapshot);
      return true;
    };
    if (check()) return;
    unsubscribe = controller.subscribe(() => {
      check();
    });
  });
}

/** No request in flight. */
export function waitIdle(controller: ImportController, label = 'idle'): Promise<ImportSnapshot> {
  return waitFor(
    controller,
    (s) => !s.activity.reading && !s.activity.posting && !s.activity.deleting,
    { label },
  );
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HarnessOptions {
  readonly mock?: RunningMock;
  readonly store?: MemoryStore;
  readonly upload?: NodeUploadOptions;
  /** Wrap the HTTP port (e.g. to simulate a transport-level retry). */
  readonly wrapHttp?: (http: HttpPort) => HttpPort;
  /** Wrap the upload port (e.g. to fail one attempt with a given transport cause). */
  readonly wrapUpload?: (upload: UploadPort) => UploadPort;
  /** Wrap the files port the controller sees (e.g. to gate a copy). */
  readonly wrapFiles?: (files: NodeFiles) => FilesPort;
  /** Node files port behaviour (e.g. an unbounded "move" copy like the iOS adapter). */
  readonly files?: NodeFilesOptions;
  /**
   * Abandon re-check delays. Tests default to a shorter schedule than production
   * (`SETTLE_RECHECK_DELAYS_MS`) to keep the suite fast; the rule is the same.
   */
  readonly settleDelaysMs?: readonly number[];
}

export const TEST_SETTLE_DELAYS_MS: readonly number[] = [300, 600, 1200];

export interface Harness {
  readonly mock: RunningMock;
  readonly root: string;
  readonly files: NodeFiles;
  store: MemoryStore;
  readonly logger: RecordingLogger;
  /** Every request the app sent (method, path, headers), in order. */
  readonly traffic: RecordedRequest[];
  /** Distinct view labels in the order they were observed. */
  readonly history: string[];
  /** Every snapshot observed (for "what did the UI show right after X" checks). */
  readonly snapshots: ImportSnapshot[];
  controller: ImportController;
  /** Simulated relaunch: the old controller dies, a new one starts over the same journal + files. */
  relaunch(store?: MemoryStore): Promise<ImportController>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const mock = options.mock ?? (await startMock());
  const ownsMock = options.mock === undefined;
  const root = mkdtempSync(join(tmpdir(), 'sir-files-'));
  const files = createNodeFiles(root, options.files);
  const controllerFiles = options.wrapFiles ? options.wrapFiles(files) : files;
  const logger = createRecordingLogger();
  const traffic: RecordedRequest[] = [];
  const history: string[] = [];
  const snapshots: ImportSnapshot[] = [];
  const onRequest = (request: RecordedRequest): void => {
    traffic.push(request);
  };
  const baseHttp = createNodeHttp({ onRequest });
  const http = options.wrapHttp ? options.wrapHttp(baseHttp) : baseHttp;
  const baseUpload = createNodeUpload({ ...options.upload, onRequest });
  const upload = options.wrapUpload ? options.wrapUpload(baseUpload) : baseUpload;

  const make = (store: MemoryStore): ImportController => {
    const controller = createImportController({
      baseUrl: mock.baseUrl,
      http,
      upload,
      files: controllerFiles,
      store,
      clock: realClock,
      ids: nodeIds,
      logger,
      settleDelaysMs: options.settleDelaysMs ?? TEST_SETTLE_DELAYS_MS,
    });
    const record = (): void => {
      const snapshot = controller.getSnapshot();
      snapshots.push(snapshot);
      const label = viewLabel(snapshot);
      if (history[history.length - 1] !== label) history.push(label);
    };
    record();
    controller.subscribe(record);
    return controller;
  };

  const harness: Harness = {
    mock,
    root,
    files,
    store: options.store ?? createMemoryStore(),
    logger,
    traffic,
    history,
    snapshots,
    controller: undefined as unknown as ImportController,
    async relaunch(store) {
      harness.controller.dispose();
      harness.store = store ?? harness.store.revive();
      harness.controller = make(harness.store);
      await harness.controller.start();
      return harness.controller;
    },
    async close() {
      harness.controller.dispose();
      rmSync(root, { recursive: true, force: true });
      if (ownsMock) await mock.close();
    },
  };
  harness.controller = make(harness.store);
  return harness;
}

/** Picks a fixture and confirms it; resolves once the POST was issued. */
export async function sendFixture(h: Harness, path: string, name: string): Promise<void> {
  const draft = await h.controller.prepareFile(picked(path, name));
  if (!draft.ok) throw new Error(`prepareFile rejected: ${draft.error.reason}`);
  await h.controller.confirmSend(draft.value.draftId);
}

export async function waitReady(h: Harness, label = 'ready'): Promise<ImportSnapshot> {
  return waitFor(h.controller, (s) => s.view.tag === 'job' && s.view.status === 'ready', { label });
}
