import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import { ImportScreen } from '../ImportScreen';
import {
  JOB_ID,
  READY_RESULT,
  createFakeController,
  makeSnapshot,
  opView,
} from '../test-utils/fakeController';
import { ignoredViewText, localSizeText, rawViewText } from './diagnosticsModel';

const snapshot = makeSnapshot(
  { tag: 'job', op: opView({ revision: 3, result: READY_RESULT }), jobId: JOB_ID, status: 'ready' },
  {
    actions: { refresh: true, requestDelete: true },
    diagnostics: {
      opId: opView().opId,
      jobId: JOB_ID,
      revision: 3,
      localSize: 112,
      lastRawView: { seq: 4, source: 'get', view: { jobId: JOB_ID, status: 'ready', revision: 3 } },
      ignoredViews: {
        count: 1,
        last: {
          source: 'get',
          status: 'processing',
          revision: 2,
          currentRevision: 3,
          reason: 'stale_revision',
        },
      },
    },
  },
);

function renderWithDiagnostics() {
  const fake = createFakeController(snapshot);
  render(
    <ImportScreen controller={fake.controller} pickFile={async () => null} diagnosticsEnabled />,
  );
  return fake;
}

async function openPanel(): Promise<void> {
  fireEvent.press(screen.getByRole('button', { name: 'Diagnostics (dev) — show' }));
  await screen.findByText('newJobs: 1');
}

describe('diagnostics model', () => {
  it('formats the raw and the ignored view without any result data', () => {
    expect(rawViewText(snapshot.diagnostics.lastRawView)).toBe('GET: job-demo-001 ready r3');
    expect(ignoredViewText(snapshot.diagnostics.ignoredViews.last!)).toBe(
      'discarded: processing r2 ≤ r3 (stale revision, GET)',
    );
    expect(localSizeText(112)).toBe('112 B');
    expect(localSizeText(34_095)).toBe('34095 B (33.3 KiB)');
  });
});

describe('DiagnosticsPanel', () => {
  it('reads /__test/state on open and shows mode, counters, jobs and local data', async () => {
    const fake = renderWithDiagnostics();
    await openPanel();
    expect(fake.calls).toContain('fetchServerState');
    expect(screen.getByText('http://127.0.0.1:8787')).toBeTruthy();
    expect(screen.getAllByText('happy').length).toBeGreaterThan(0);
    expect(screen.getByText('createRequests: 1')).toBeTruthy();
    expect(screen.getByText('acceptedBytes: 112')).toBeTruthy();
    expect(screen.getByText('job-demo-001: ready r3, 112 B')).toBeTruthy();
    expect(screen.getByText('112 B')).toBeTruthy();
    expect(screen.getByText('GET: job-demo-001 ready r3')).toBeTruthy();
    expect(
      screen.getByText('1; last — discarded: processing r2 ≤ r3 (stale revision, GET)'),
    ).toBeTruthy();
    // The panel never shows the file name or the report payload.
    const panel = within(screen.getByTestId('diagnostics'));
    expect(panel.queryByText(/statement\.csv/)).toBeNull();
    expect(panel.queryByText(/StreamBeam|AUD/)).toBeNull();
  });

  it('switches the scenario and re-reads the mode', async () => {
    const fake = renderWithDiagnostics();
    await openPanel();
    fireEvent.press(screen.getByRole('button', { name: 'lost_ack' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'lost_ack' }).props.accessibilityState,
      ).toMatchObject({ selected: true }),
    );
    expect(fake.calls).toContain('setScenario:lost_ack');
    expect(fake.calls.filter((call) => call === 'fetchServerState').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('resets the mock and local state only after confirmation', async () => {
    const fake = renderWithDiagnostics();
    await openPanel();
    fireEvent.press(screen.getByRole('button', { name: 'Reset mock and local state' }));
    expect(fake.calls).not.toContain('resetMockAndLocal');
    fireEvent.press(screen.getByRole('button', { name: "Don't reset" }));
    expect(fake.calls).not.toContain('resetMockAndLocal');

    fireEvent.press(screen.getByRole('button', { name: 'Reset mock and local state' }));
    fireEvent.press(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText('Mock and local state have been reset.')).toBeTruthy();
    expect(fake.calls).toContain('resetMockAndLocal');
  });

  it('re-reads the mock state after an observable server action', async () => {
    const fake = renderWithDiagnostics();
    await openPanel();
    const before = fake.calls.filter((call) => call === 'fetchServerState').length;
    act(() => {
      fake.set(
        makeSnapshot(
          { tag: 'deleting', op: opView({ revision: 3 }), jobId: JOB_ID },
          { version: 2, activity: { deleting: true } },
        ),
      );
    });
    await waitFor(() =>
      expect(fake.calls.filter((call) => call === 'fetchServerState').length).toBeGreaterThan(
        before,
      ),
    );
  });
});
