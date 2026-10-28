import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, StyleSheet, Text, type AppStateStatus } from 'react-native';

import type { LogEntry } from '../core';
import {
  createFakeController,
  JOB_ID,
  makeSnapshot,
  NO_ACTIONS,
  opView,
  READY_RESULT,
} from '../ui/test-utils/fakeController';
import { AppRoot } from './AppRoot';
import type { AppServices } from './composition';
import { AppErrorBoundary } from './ErrorBoundary';

type ChangeHandler = (status: AppStateStatus) => void;

function captureAppState(options: { onSubscribe?: () => void } = {}): {
  emit: (status: AppStateStatus) => void;
  restore: () => void;
} {
  const handlers = new Set<ChangeHandler>();
  const initial = AppState.currentState;
  const fakeAdd = (_type: string, handler: ChangeHandler) => {
    handlers.add(handler);
    options.onSubscribe?.();
    return { remove: () => void handlers.delete(handler) };
  };
  const spy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(fakeAdd as unknown as typeof AppState.addEventListener);
  return {
    emit: (status) => {
      // Like RN: `currentState` is updated before the listeners run.
      AppState.currentState = status;
      for (const handler of [...handlers]) handler(status);
    },
    restore: () => {
      spy.mockRestore();
      AppState.currentState = initial;
    },
  };
}

const EMPTY = makeSnapshot({ tag: 'empty' }, { actions: { ...NO_ACTIONS, pickFile: true } });
const READY = makeSnapshot(
  { tag: 'job', op: opView({ revision: 3, result: READY_RESULT }), jobId: JOB_ID, status: 'ready' },
  { actions: { refresh: true, requestDelete: true } },
);

function readyServices(
  coverEnabled: boolean,
  logs: LogEntry[] = [],
  snapshot = EMPTY,
): AppServices {
  const fake = createFakeController(snapshot);
  return {
    kind: 'ready',
    controller: fake.controller,
    pickFile: () => Promise.resolve(null),
    diagnosticsEnabled: false,
    coverEnabled,
    announceChanges: false,
    logger: { log: (entry) => logs.push(entry) },
  };
}

describe('AppRoot', () => {
  it('renders the import screen with the empty state', () => {
    render(<AppRoot services={readyServices(false)} />);
    expect(screen.getByTestId('import-screen')).toBeTruthy();
    expect(screen.getByTestId('action-pickFile')).toBeTruthy();
    expect(screen.queryByTestId('privacy-cover')).toBeNull();
  });

  it('starts the screen below the status bar / Dynamic Island (safe-area top inset)', () => {
    const metrics = {
      insets: { top: 62, bottom: 34, left: 0, right: 0 },
      frame: { x: 0, y: 0, width: 402, height: 874 },
    };
    render(<AppRoot services={readyServices(false)} safeAreaMetrics={metrics} />);
    const paddings: unknown[] = [];
    for (let node = screen.getByTestId('import-screen').parent; node !== null; node = node.parent) {
      paddings.push(StyleSheet.flatten(node.props.style)?.paddingTop);
    }
    expect(paddings).toContain(62);
  });

  it('shows the config fallback and no import screen when the mock URL is malformed', () => {
    render(
      <AppRoot
        services={{ kind: 'config_error', coverEnabled: false, logger: { log: () => {} } }}
      />,
    );
    expect(screen.getByTestId('fallback-config')).toBeTruthy();
    expect(screen.queryByTestId('import-screen')).toBeNull();
  });

  it('covers the screen while inactive / background when enabled (iOS)', () => {
    const appState = captureAppState();
    try {
      render(<AppRoot services={readyServices(true)} />);
      expect(screen.queryByTestId('privacy-cover')).toBeNull();
      act(() => appState.emit('inactive'));
      expect(screen.getByTestId('privacy-cover')).toBeTruthy();
      act(() => appState.emit('background'));
      expect(screen.getByTestId('privacy-cover')).toBeTruthy();
      act(() => appState.emit('active'));
      expect(screen.queryByTestId('privacy-cover')).toBeNull();
    } finally {
      appState.restore();
    }
  });

  it('covers the open "Подробнее" card too (a native modal sits above the root cover)', () => {
    const appState = captureAppState();
    try {
      render(<AppRoot services={readyServices(true, [], READY)} />);
      fireEvent.press(screen.getByRole('button', { name: 'Details: StreamBeam' }));
      expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
      act(() => appState.emit('inactive'));
      // One cover at the root, one inside the modal's own tree.
      expect(screen.getAllByTestId('privacy-cover')).toHaveLength(2);
      act(() => appState.emit('active'));
      expect(screen.queryAllByTestId('privacy-cover')).toHaveLength(0);
      expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
    } finally {
      appState.restore();
    }
  });

  it('re-syncs after subscribing: a change before the effect ran is not lost', () => {
    // The state flips to background between the first render and the subscription.
    const appState = captureAppState({
      onSubscribe: () => {
        AppState.currentState = 'background';
      },
    });
    try {
      AppState.currentState = 'active';
      render(<AppRoot services={readyServices(true)} />);
      expect(screen.getByTestId('privacy-cover')).toBeTruthy();
    } finally {
      appState.restore();
    }
  });

  it('never covers when disabled (Android: no JS cover; Recents thumbnail handled by the config plugin on API 33+)', () => {
    const appState = captureAppState();
    try {
      render(<AppRoot services={readyServices(false)} />);
      act(() => appState.emit('background'));
      expect(screen.queryByTestId('privacy-cover')).toBeNull();
    } finally {
      appState.restore();
    }
  });
});

describe('AppErrorBoundary', () => {
  let shouldThrow = true;
  function Boom() {
    if (shouldThrow) throw new Error('statement.csv StreamBeam');
    return <Text>recovered</Text>;
  }

  it('shows the neutral fallback, logs only an allow-listed event, and retries', () => {
    const logs: LogEntry[] = [];
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <AppErrorBoundary logger={{ log: (entry) => logs.push(entry) }}>
          <Boom />
        </AppErrorBoundary>,
      );
      expect(screen.getByTestId('fallback-crash')).toBeTruthy();
      expect(screen.getByText('Something went wrong')).toBeTruthy();
      expect(screen.queryByText(/statement\.csv|StreamBeam/)).toBeNull();
      expect(logs).toEqual([{ event: 'invariant_violation', cause: 'unexpected' }]);

      shouldThrow = false;
      fireEvent.press(screen.getByTestId('fallback-retry'));
      expect(screen.getByText('recovered')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });
});
