// Test double of ImportController for UI tests: a snapshot setter plus recorded commands.
// Framework-agnostic (no jest globals) so it typechecks with the app sources; tests assert on
// `fake.calls`. Snapshots are built with the same shape the core produces.

import {
  ok,
  type AvailableActions,
  type DiagnosticsSnapshot,
  type ImportController,
  type ImportSnapshot,
  type ImportView,
  type JobId,
  type MockMode,
  type MockState,
  type OperationView,
  type OpId,
  type PickedFile,
  type ReadyResult,
} from '../../core';

export const NO_ACTIONS: AvailableActions = {
  pickFile: false,
  confirmSend: false,
  cancelDraft: false,
  cancelSending: false,
  checkAgain: false,
  resend: false,
  abandon: false,
  refresh: false,
  requestDelete: false,
  retryDelete: false,
  newImport: false,
  retryStorage: false,
};

export const OP_ID = 'op-0001' as OpId;
export const JOB_ID = 'job-demo-001' as JobId;

/** The mock's fixed ready answer (TZ): StreamBeam 19.99 + BrightGrid 132.00 = 151.99 AUD. */
export const READY_RESULT: ReadyResult = {
  currency: 'AUD',
  items: [
    {
      id: 'rec-001',
      merchant: 'StreamBeam',
      amountMinor: 1999,
      cadence: 'monthly',
      lastSeen: '2026-10-01',
    },
    {
      id: 'rec-002',
      merchant: 'BrightGrid',
      amountMinor: 13200,
      cadence: 'monthly',
      lastSeen: '2026-10-03',
    },
  ],
};

export function opView(overrides: Partial<OperationView> = {}): OperationView {
  return {
    opId: OP_ID,
    revision: 1,
    recoveredByKey: false,
    file: { name: 'statement.csv', size: 112, format: 'csv', available: true },
    result: null,
    ...overrides,
  };
}

export function diagnosticsSnapshot(
  overrides: Partial<DiagnosticsSnapshot> = {},
): DiagnosticsSnapshot {
  return {
    baseUrl: 'http://127.0.0.1:8787',
    opId: null,
    jobId: null,
    revision: null,
    localSize: null,
    lastRawView: null,
    ignoredViews: { count: 0, last: null },
    extraOperations: 0,
    ...overrides,
  };
}

export interface SnapshotOverrides {
  readonly actions?: Partial<AvailableActions>;
  readonly activity?: Partial<ImportSnapshot['activity']>;
  readonly readError?: ImportSnapshot['readError'];
  readonly notice?: ImportSnapshot['notice'];
  readonly storageError?: boolean;
  readonly diagnostics?: Partial<DiagnosticsSnapshot>;
  readonly version?: number;
}

export function makeSnapshot(view: ImportView, overrides: SnapshotOverrides = {}): ImportSnapshot {
  return {
    version: overrides.version ?? 1,
    view,
    actions: { ...NO_ACTIONS, ...overrides.actions },
    activity: { posting: false, deleting: false, reading: false, ...overrides.activity },
    readError: overrides.readError ?? null,
    notice: overrides.notice ?? null,
    storageError: overrides.storageError ?? false,
    diagnostics: diagnosticsSnapshot(overrides.diagnostics),
  };
}

export const DEFAULT_MOCK_STATE: MockState = {
  mode: 'happy',
  stats: { createRequests: 1, newJobs: 1, duplicateHits: 0, acceptedBytes: 112, deleteRequests: 0 },
  jobs: [{ jobId: JOB_ID, status: 'ready', revision: 3, bytes: 112, sha256: 'x' }],
};

export interface FakeController {
  readonly controller: ImportController;
  /** Command names in call order, e.g. `['confirmSend:op-0001', 'refresh']`. */
  readonly calls: string[];
  /** Replace the snapshot and notify subscribers (wrap in `act`). */
  set(snapshot: ImportSnapshot): void;
  mockState: MockState;
}

export function createFakeController(initial: ImportSnapshot): FakeController {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const record = (name: string) => async (): Promise<void> => {
    calls.push(name);
    await Promise.resolve();
  };

  const fake: FakeController = {
    calls,
    mockState: DEFAULT_MOCK_STATE,
    set(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    controller: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: record('start'),
      onForeground: record('onForeground'),
      onBackground: record('onBackground'),
      prepareFile: async (picked: PickedFile) => {
        calls.push(`prepareFile:${picked.declaredSize ?? 'unknown'}`);
        await Promise.resolve();
        return ok({ draftId: OP_ID, name: picked.name, size: 112, format: 'csv' as const });
      },
      confirmSend: async (draftId: OpId) => {
        calls.push(`confirmSend:${draftId}`);
        await Promise.resolve();
      },
      cancelDraft: record('cancelDraft'),
      cancelSending: record('cancelSending'),
      checkAgain: record('checkAgain'),
      resend: record('resend'),
      abandon: record('abandon'),
      refresh: record('refresh'),
      requestDelete: record('requestDelete'),
      retryDelete: record('retryDelete'),
      newImport: record('newImport'),
      dismiss: record('dismiss'),
      retryStorage: record('retryStorage'),
      dispose: () => {
        calls.push('dispose');
      },
      diagnostics: {
        fetchServerState: async () => {
          calls.push('fetchServerState');
          await Promise.resolve();
          return ok(fake.mockState);
        },
        setScenario: async (mode: MockMode) => {
          calls.push(`setScenario:${mode}`);
          await Promise.resolve();
          fake.mockState = { ...fake.mockState, mode };
          return ok({ mode });
        },
        resetMockAndLocal: async () => {
          calls.push('resetMockAndLocal');
          await Promise.resolve();
          return ok(undefined);
        },
      },
    },
  };
  return fake;
}
