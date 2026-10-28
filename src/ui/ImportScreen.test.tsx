import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  AccessibilityInfo,
  Alert,
  ScrollView,
  StyleSheet,
  type AlertButton,
  type StyleProp,
  type TextStyle,
} from 'react-native';

import type { ImportSnapshot, PickedFile } from '../core';
import { ImportScreen } from './ImportScreen';
import { PrivacyCover } from './PrivacyCover';
import {
  EMPTY_COPY,
  JOB_STATUS_COPY,
  OUTCOME_LOOKUP_COPY,
  OUTCOME_TITLE_COPY,
  READY_COPY,
  STATUS_COPY,
  TRACE_COPY,
  VIEW_COPY,
  stepText,
} from './copy';
import { STATE_CASES } from './test-utils/cases';
import { DISPLAY_MAX_SCALE, font, space, TITLE_MAX_SCALE } from './theme';
import { buildScreenModel } from './viewModel';
import {
  JOB_ID,
  OP_ID,
  READY_RESULT,
  createFakeController,
  makeSnapshot,
  opView,
  type FakeController,
} from './test-utils/fakeController';

// The RN jest preset reports fontScale 2 (a large accessibility size). Tests that need the regular
// size set this; null passes the preset's dimensions through unchanged.
let mockFontScale: number | null = null;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual<{
    default: () => { fontScale: number; width: number; height: number; scale: number };
  }>('react-native/Libraries/Utilities/useWindowDimensions');
  return {
    __esModule: true,
    default: () => {
      const dimensions = actual.default();
      return mockFontScale === null ? dimensions : { ...dimensions, fontScale: mockFontScale };
    },
  };
});

/**
 * Minimal shape of a react-test-renderer node (@types/react-test-renderer is not installed, so
 * RNTL's element types resolve to `any`; this keeps the tree walks typed).
 */
interface TreeNode {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly (TreeNode | string)[];
  readonly parent: TreeNode | null;
  findAll(predicate: (node: TreeNode) => boolean): TreeNode[];
}

const treeRoot = (): TreeNode => screen.UNSAFE_root as TreeNode;
const hostRoot = (): TreeNode => screen.root as TreeNode;
const buttons = (): TreeNode[] => screen.queryAllByRole('button') as TreeNode[];
const styleOf = (node: TreeNode): TextStyle =>
  StyleSheet.flatten(node.props.style as StyleProp<TextStyle>) ?? {};

const PICKED: PickedFile = {
  uri: 'file:///private/picked',
  name: 'statement.csv',
  declaredSize: 112,
};

interface RenderOptions {
  diagnosticsEnabled?: boolean;
  pickFile?: () => Promise<PickedFile | null>;
  announceChanges?: boolean;
  covered?: boolean;
}

function screenElement(fake: FakeController, options: RenderOptions) {
  return (
    <ImportScreen
      controller={fake.controller}
      pickFile={options.pickFile ?? (async () => PICKED)}
      diagnosticsEnabled={options.diagnosticsEnabled ?? false}
      announceChanges={options.announceChanges ?? false}
      covered={options.covered ?? false}
    />
  );
}

function renderScreen(snapshot: ImportSnapshot, options: RenderOptions = {}): FakeController {
  const fake = createFakeController(snapshot);
  render(screenElement(fake, options));
  return fake;
}

/** Accessible names of the action buttons, in order (Billy's log toggle is not an action). */
function buttonNames(): string[] {
  return buttons()
    .filter((button) => button.props.testID !== 'trace-toggle')
    .map((button) => String(button.props.accessibilityLabel ?? ''));
}

function allText(): string {
  return treeRoot()
    .findAll((node) => node.type === 'Text')
    .map((node) => flattenChildren(node))
    .join('\n');
}

function flattenChildren(node: TreeNode): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : flattenChildren(child)))
    .join('');
}

/** Shape of a `screen.toJSON()` node (react-test-renderer types are not installed). */
interface JsonNode {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly (JsonNode | string)[] | null;
}

/** The rendered JSON tree with Billy's log (testID="trace") cut out. */
function withoutTrace(node: JsonNode | readonly JsonNode[] | null): unknown {
  if (node === null) return null;
  if (Array.isArray(node)) return node.map((child: JsonNode) => withoutTrace(child));
  const one = node as JsonNode;
  if (one.props.testID === 'trace') return null;
  return {
    ...one,
    children:
      one.children?.map((child) => (typeof child === 'string' ? child : withoutTrace(child))) ??
      null,
  };
}
const renderedWithoutTrace = (): string =>
  JSON.stringify(withoutTrace(screen.toJSON() as JsonNode | JsonNode[] | null));

const readySnapshot = (overrides: Parameters<typeof makeSnapshot>[1] = {}) =>
  makeSnapshot(
    {
      tag: 'job',
      op: opView({ revision: 3, result: READY_RESULT }),
      jobId: JOB_ID,
      status: 'ready',
    },
    { actions: { refresh: true, requestDelete: true }, ...overrides },
  );

describe('ImportScreen: every view tag', () => {
  it.each(STATE_CASES)('$name renders its copy and only the allowed buttons', (state) => {
    renderScreen(state.snapshot);
    expect(screen.getByRole('header', { name: state.title })).toBeTruthy();
    if (state.status !== undefined) expect(screen.getByText(state.status)).toBeTruthy();
    expect(buttonNames()).toEqual(state.buttons);
  });

  it('never offers to cancel a subscription in any state', () => {
    for (const state of STATE_CASES) {
      const { unmount } = render(
        <ImportScreen
          controller={createFakeController(state.snapshot).controller}
          pickFile={async () => null}
          diagnosticsEnabled
        />,
      );
      expect(allText()).not.toMatch(/subscription/i);
      unmount();
    }
  });
});

describe('ImportScreen: buttons call the controller', () => {
  const cases: readonly { name: string; caseName: string; button: string; call: string }[] = [
    { name: 'Send', caseName: 'confirm', button: 'Send', call: `confirmSend:${OP_ID}` },
    { name: 'Cancel (draft)', caseName: 'confirm', button: 'Cancel', call: 'cancelDraft' },
    { name: 'Cancel (sending)', caseName: 'sending', button: 'Cancel', call: 'cancelSending' },
    {
      name: 'Check again',
      caseName: 'outcome_unknown not found',
      button: 'Check again',
      call: 'checkAgain',
    },
    {
      name: 'Send again',
      caseName: 'outcome_unknown not found',
      button: 'Send again',
      call: 'resend',
    },
    {
      name: 'Cancel import',
      caseName: 'outcome_unknown not found',
      button: 'Cancel import',
      call: 'abandon',
    },
    { name: 'Refresh status', caseName: 'job ready', button: 'Refresh status', call: 'refresh' },
    {
      name: 'Retry deletion',
      caseName: 'delete_failed',
      button: 'Retry deletion',
      call: 'retryDelete',
    },
    { name: 'New import', caseName: 'deleted', button: 'New import', call: 'newImport' },
    {
      name: 'Close (local rejection)',
      caseName: 'local_rejection spoofed',
      button: 'Close',
      call: 'newImport',
    },
    {
      name: 'Retry (storage)',
      caseName: 'storage_unavailable',
      button: 'Retry',
      call: 'retryStorage',
    },
  ];

  it.each(cases)('$name → $call', ({ caseName, button, call }) => {
    const state = STATE_CASES.find((item) => item.name === caseName);
    if (state === undefined) throw new Error(`no case ${caseName}`);
    const fake = renderScreen(state.snapshot);
    fireEvent.press(screen.getByRole('button', { name: button }));
    expect(fake.calls).toEqual([call]);
  });

  it('disabled buttons expose their state and do nothing', () => {
    const fake = renderScreen(
      makeSnapshot(
        {
          tag: 'sending',
          op: opView({ revision: 0 }),
          attempt: 1,
          progress: null,
          cancelRequested: true,
          autoRetry: false,
          notStarted: false,
        },
        { activity: { posting: true } },
      ),
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    expect(cancel.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    fireEvent.press(cancel);
    expect(fake.calls).toEqual([]);
  });

  it('"Выбрать файл" opens the picker and prepares the picked file', async () => {
    const pickFile = jest.fn(async () => PICKED);
    const fake = renderScreen(makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true } }), {
      pickFile,
    });
    fireEvent.press(screen.getByRole('button', { name: 'Choose file' }));
    await waitFor(() => expect(fake.calls).toEqual(['prepareFile:112']));
    expect(pickFile).toHaveBeenCalledTimes(1);
  });

  it('a cancelled picker prepares nothing', async () => {
    const pickFile = jest.fn(async () => null);
    const fake = renderScreen(makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true } }), {
      pickFile,
    });
    fireEvent.press(screen.getByRole('button', { name: 'Choose file' }));
    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.calls).toEqual([]);
  });

  it('a failing picker shows a readable error', async () => {
    renderScreen(makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true } }), {
      pickFile: async () => {
        throw new Error('boom');
      },
    });
    fireEvent.press(screen.getByRole('button', { name: 'Choose file' }));
    expect(await screen.findByText(STATUS_COPY.pickerFailed)).toBeTruthy();
  });
});

describe('ImportScreen: report', () => {
  it('202 / queued is never shown as a report', () => {
    renderScreen(
      makeSnapshot(
        { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
        { actions: { requestDelete: true } },
      ),
    );
    expect(screen.getByRole('header', { name: JOB_STATUS_COPY.queued.title })).toBeTruthy();
    expect(screen.queryByTestId('report')).toBeNull();
    expect(screen.queryByText(/AUD/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Details/ })).toBeNull();
  });

  it('processing is not a report either, even if a result were attached', () => {
    renderScreen(
      makeSnapshot({
        tag: 'job',
        op: opView({ revision: 2, result: READY_RESULT }),
        jobId: JOB_ID,
        status: 'processing',
      }),
    );
    expect(screen.queryByTestId('report')).toBeNull();
    expect(screen.queryByText('151.99 AUD/month')).toBeNull();
  });

  it('ready shows the exact rows and the monthly total', () => {
    renderScreen(readySnapshot());
    // Each row: merchant, cadence + last charge date, amount, and its own «Details» button.
    for (const [merchant, meta, amount] of [
      ['StreamBeam', 'Monthly · 1 Oct 2026', '19.99 AUD'],
      ['BrightGrid', 'Monthly · 3 Oct 2026', '132.00 AUD'],
    ] as const) {
      expect(screen.getByText(merchant)).toBeTruthy();
      expect(screen.getByText(meta)).toBeTruthy();
      expect(screen.getByText(amount)).toBeTruthy();
      expect(screen.getByRole('button', { name: `Details: ${merchant}` })).toBeTruthy();
    }
    expect(screen.getByTestId('monthly-total')).toHaveTextContent('151.99 AUD/month', {
      exact: true,
    });
  });

  it('a stale (ignored) view does not change the ready screen', () => {
    const fake = renderScreen(readySnapshot({ diagnostics: { revision: 3 } }));
    // Rendered output only (handlers are recreated on every render and do not show). Billy's log
    // is the one place that may change: it says the older reply was ignored.
    const before = renderedWithoutTrace();
    act(() => {
      fake.set(
        readySnapshot({
          version: 2,
          diagnostics: {
            revision: 3,
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
        }),
      );
    });
    expect(renderedWithoutTrace()).toBe(before);
    expect(screen.getByRole('header', { name: JOB_STATUS_COPY.ready.title })).toBeTruthy();
    expect(screen.getByText('151.99 AUD/month')).toBeTruthy();
    fireEvent.press(screen.getByTestId('trace-toggle'));
    expect(screen.getByText(TRACE_COPY.ignored('processing', 2, 3))).toBeTruthy();
  });

  it('shows the recovered-by-key badge only after a lost-ack recovery', () => {
    renderScreen(
      makeSnapshot({
        tag: 'job',
        op: opView({ recoveredByKey: true }),
        jobId: JOB_ID,
        status: 'queued',
      }),
    );
    expect(screen.getByText('Found it after a lost reply')).toBeTruthy();
  });

  it('has no recovered-by-key badge for a normal job', () => {
    renderScreen(readySnapshot());
    expect(screen.queryByText(STATUS_COPY.recoveredByKey)).toBeNull();
  });

  it('"Подробнее" opens a card with every server field and refreshes the job', () => {
    const fake = renderScreen(readySnapshot());
    fireEvent.press(screen.getByRole('button', { name: 'Details: StreamBeam' }));
    expect(fake.calls).toEqual(['refresh']);
    expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
    expect(screen.getByTestId('receipt-amount')).toHaveTextContent('19.99 AUD');
    // Every server field: formatted on the receipt, raw in the server record.
    for (const value of [
      'StreamBeam',
      '1 Oct 2026',
      'Monthly',
      'AUD',
      'rec-001',
      '1999',
      'monthly',
      '2026-10-01',
      JOB_ID,
      '3',
      'ready',
    ]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('header', { name: 'Recurring charge' })).toBeNull();
  });
});

/** Captures the native confirmation alert instead of showing it. */
function captureAlert(): {
  readonly last: () => {
    title: string | null | undefined;
    message: string | null | undefined;
    buttons: readonly AlertButton[];
  } | null;
  readonly press: (text: string) => void;
  readonly count: () => number;
  readonly restore: () => void;
} {
  const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const last = () => {
    const call = spy.mock.calls.at(-1);
    if (call === undefined) return null;
    const [title, message, buttons] = call;
    return { title, message, buttons: buttons ?? [] };
  };
  return {
    last,
    count: () => spy.mock.calls.length,
    press: (text) => {
      const button = last()?.buttons.find((item) => item.text === text);
      if (button === undefined) throw new Error(`no alert button ${text}`);
      act(() => {
        (button.onPress as (() => void) | undefined)?.();
      });
    },
    restore: () => spy.mockRestore(),
  };
}

describe('ImportScreen: deletion', () => {
  let alert: ReturnType<typeof captureAlert>;
  beforeEach(() => {
    alert = captureAlert();
  });
  afterEach(() => alert.restore());

  it('asks for confirmation in a native alert before deleting', () => {
    const fake = renderScreen(readySnapshot());
    fireEvent.press(screen.getByRole('button', { name: 'Delete import' }));
    expect(fake.calls).toEqual([]);
    expect(alert.last()?.title).toBe('Delete import?');
    expect(alert.last()?.message).toMatch(/You can't undo this/);
    expect(alert.last()?.buttons.map((button) => [button.text, button.style])).toEqual([
      ["Don't delete", 'cancel'],
      ['Delete on server', 'destructive'],
    ]);
    // The focused button stays on screen (no inline card replacing it).
    expect(screen.getByRole('button', { name: 'Delete import' })).toBeTruthy();

    alert.press("Don't delete");
    expect(fake.calls).toEqual([]);

    fireEvent.press(screen.getByRole('button', { name: 'Delete import' }));
    alert.press('Delete on server');
    expect(fake.calls).toEqual(['requestDelete']);
  });

  it('never says "deleted" while deleting or after a failed delete', () => {
    const saysDeleted = (): boolean => {
      // Open Billy's log too (folded once settled): its lines must not say it either.
      const toggle = screen.queryByTestId('trace-toggle');
      if (toggle !== null) fireEvent.press(toggle);
      const text = allText();
      return (
        text.includes('All gone') ||
        text.includes('Deleted on the server and on this phone.') ||
        /^Deleted on the server/m.test(text)
      );
    };
    for (const name of ['delete_requested', 'deleting', 'delete_failed']) {
      const state = STATE_CASES.find((item) => item.name === name);
      if (state === undefined) throw new Error(name);
      const { unmount } = render(
        <ImportScreen
          controller={createFakeController(state.snapshot).controller}
          pickFile={async () => null}
          diagnosticsEnabled={false}
        />,
      );
      expect(saysDeleted()).toBe(false);
      expect(screen.queryByTestId('report')).toBeNull();
      unmount();
    }
    // Control: the confirmed state does say it.
    const deleted = STATE_CASES.find((item) => item.name === 'deleted');
    if (deleted === undefined) throw new Error('deleted');
    render(
      <ImportScreen
        controller={createFakeController(deleted.snapshot).controller}
        pickFile={async () => null}
        diagnosticsEnabled={false}
      />,
    );
    expect(saysDeleted()).toBe(true);
  });

  it('a confirmation left open does nothing once the job moved on', () => {
    const fake = renderScreen(readySnapshot());
    fireEvent.press(screen.getByRole('button', { name: 'Delete import' }));
    act(() => {
      fake.set(
        makeSnapshot(
          { tag: 'deleting', op: opView({ revision: 3, result: READY_RESULT }), jobId: JOB_ID },
          { version: 2 },
        ),
      );
    });
    alert.press('Delete on server');
    expect(fake.calls).toEqual([]);
  });

  it('a confirmation left open does nothing once deleting is no longer allowed', () => {
    const fake = renderScreen(readySnapshot());
    fireEvent.press(screen.getByRole('button', { name: 'Delete import' }));
    act(() => fake.set(readySnapshot({ actions: { refresh: true }, version: 2 })));
    alert.press('Delete on server');
    expect(fake.calls).toEqual([]);
  });
});

describe('ImportScreen: errors, notices, storage', () => {
  it('a failed read shows the last known status and "Обновить"', () => {
    const fake = renderScreen(
      makeSnapshot(
        { tag: 'job', op: opView({ revision: 2 }), jobId: JOB_ID, status: 'processing' },
        {
          actions: { refresh: true, requestDelete: true },
          readError: { source: 'get', error: { kind: 'transport', cause: 'unreachable' } },
        },
      ),
    );
    expect(screen.getByText('Last known status')).toBeTruthy();
    expect(screen.getByRole('header', { name: JOB_STATUS_COPY.processing.title })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    expect(fake.calls).toEqual(['refresh']);
  });

  it('file_missing: tells the user to pick again and hides "Отправить снова"', () => {
    renderScreen(
      makeSnapshot(
        {
          tag: 'outcome_unknown',
          op: opView({
            file: { name: 'statement.csv', size: 112, format: 'csv', available: false },
          }),
          cause: 'timeout',
          lookup: 'not_found',
          attempt: 1,
          abandon: false,
        },
        { actions: { checkAgain: true, abandon: true }, notice: { tag: 'file_missing' } },
      ),
    );
    expect(screen.getByText('The file is no longer available — choose it again')).toBeTruthy();
    expect(buttonNames()).toEqual(['Check again', 'Cancel import']);
  });

  it.each([
    [
      { tag: 'config_error', httpStatus: 404 } as const,
      'The server is unreachable or its address is misconfigured (code 404).',
    ],
    [
      { tag: 'cancel_too_late' } as const,
      'Too late to cancel: the server already has the file. You can delete the import.',
    ],
    [
      { tag: 'client_error', httpStatus: 400 } as const,
      "The server rejected the app's request (code 400).",
    ],
  ])('notice %o', (notice, text) => {
    renderScreen(
      makeSnapshot(
        { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
        { actions: { requestDelete: true }, notice },
      ),
    );
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('a storage error shows a banner with "Повторить" and hides other actions', () => {
    const fake = renderScreen(
      makeSnapshot(
        { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
        { actions: { retryStorage: true }, storageError: true },
      ),
    );
    expect(
      screen.getByText("Couldn't save on this device. The last action didn't complete."),
    ).toBeTruthy();
    expect(buttonNames()).toEqual(['Retry']);
    fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(fake.calls).toEqual(['retryStorage']);
  });
});

describe('ImportScreen: after a relaunch the file name is not on the device', () => {
  const coldReady = (result: typeof READY_RESULT | null) =>
    makeSnapshot(
      {
        tag: 'job',
        op: opView({
          revision: 3,
          result,
          file: { name: '', size: 33_882, format: 'pdf', available: false },
        }),
        jobId: JOB_ID,
        status: 'ready',
      },
      { actions: { refresh: true, requestDelete: true } },
    );

  it('shows "File: PDF, 33.1 KiB" instead of the name, with the re-fetched report', () => {
    renderScreen(coldReady(READY_RESULT));
    expect(screen.getByText('PDF, 33.1 KiB')).toBeTruthy();
    expect(allText()).not.toContain('statement');
    expect(screen.getByTestId('monthly-total')).toHaveTextContent('151.99 AUD/month', {
      exact: true,
    });
  });

  it('while the report is being re-fetched: ready, no report yet, no stale data', () => {
    renderScreen(coldReady(null));
    expect(screen.getByText(READY_COPY.loading)).toBeTruthy();
    expect(screen.queryByTestId('monthly-total')).toBeNull();
    expect(allText()).not.toContain('StreamBeam');
  });

  it('when the re-fetch failed: says so (never "Fetching…"), shows the stale label, offers "Refresh status"', () => {
    const base = coldReady(null);
    renderScreen({
      ...base,
      readError: { source: 'lookup', error: { kind: 'transport', cause: 'unreachable' } },
    });
    expect(allText()).not.toContain(READY_COPY.loading);
    expect(screen.getByText(READY_COPY.loadFailed)).toBeTruthy();
    expect(allText()).toContain('Last known status');
    expect(buttonNames()).toContain('Refresh status');
    expect(screen.queryByTestId('monthly-total')).toBeNull();
  });
});

describe('ImportScreen: the `sending` write failed before the POST', () => {
  it('says the file was not sent and offers only "Retry"', () => {
    const fake = renderScreen(
      makeSnapshot(
        {
          tag: 'sending',
          op: opView(),
          attempt: 1,
          progress: null,
          cancelRequested: false,
          autoRetry: false,
          notStarted: true,
        },
        { actions: { retryStorage: true }, storageError: true },
      ),
    );
    expect(screen.getByRole('header', { name: 'Not sent yet' })).toBeTruthy();
    expect(screen.getByText("I couldn't save my notes first.")).toBeTruthy();
    expect(allText()).not.toContain(VIEW_COPY.sending.title);
    expect(buttonNames()).toEqual(['Retry']);
    fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(fake.calls).toEqual(['retryStorage']);
  });
});

const emptySnapshot = (version = 1) =>
  makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true }, version });

/** Host nodes in document (render) order. */
const hostNodes = (): TreeNode[] => treeRoot().findAll((node) => typeof node.type === 'string');
const ancestors = (node: TreeNode): TreeNode[] => {
  const out: TreeNode[] = [];
  for (let at = node.parent; at !== null; at = at.parent) out.push(at);
  return out;
};

describe('ImportScreen: Billy greets once per session', () => {
  it('the first empty screen is the greeting', () => {
    renderScreen(emptySnapshot());
    expect(screen.getByRole('header', { name: EMPTY_COPY.greetingTitle })).toBeTruthy();
    expect(screen.getByText(EMPTY_COPY.greetingStatus)).toBeTruthy();
  });

  it('start-up does not use up the greeting', () => {
    const fake = renderScreen(makeSnapshot({ tag: 'starting' }));
    act(() => fake.set(emptySnapshot(2)));
    expect(screen.getByRole('header', { name: EMPTY_COPY.greetingTitle })).toBeTruthy();
  });

  it('after another state the empty screen is the plain one, for good', () => {
    const fake = renderScreen(emptySnapshot());
    act(() =>
      fake.set(
        makeSnapshot(
          { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
          { actions: { requestDelete: true }, version: 2 },
        ),
      ),
    );
    act(() => fake.set(emptySnapshot(3)));
    expect(screen.getByRole('header', { name: 'Got another statement?' })).toBeTruthy();
    expect(screen.queryByText(EMPTY_COPY.greetingTitle)).toBeNull();
    expect(screen.queryByText(EMPTY_COPY.greetingStatus)).toBeNull();
    act(() => fake.set(makeSnapshot({ tag: 'preparing' }, { version: 4 })));
    act(() => fake.set(emptySnapshot(5)));
    expect(screen.getByRole('header', { name: VIEW_COPY.empty.title })).toBeTruthy();
  });
});

describe('ImportScreen: accepted-files footnote', () => {
  it('empty: "Choose file" comes before the footnote', () => {
    renderScreen(emptySnapshot());
    const nodes = hostNodes();
    const button = nodes.findIndex(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Choose file',
    );
    const footnote = nodes.findIndex(
      (node) => node.type === 'Text' && plainText(node) === EMPTY_COPY.footnote,
    );
    expect(button).toBeGreaterThanOrEqual(0);
    expect(footnote).toBeGreaterThan(button);
  });

  it('is shown on the empty screen only', () => {
    for (const state of STATE_CASES.filter((item) => item.tag !== 'empty')) {
      const { unmount } = render(screenElement(createFakeController(state.snapshot), {}));
      expect(screen.queryByText(EMPTY_COPY.footnote)).toBeNull();
      unmount();
    }
  });
});

describe('ImportScreen: step pips in the speech bubble', () => {
  const confirm = STATE_CASES.find((item) => item.name === 'confirm');

  it('confirm: one accessible element that reads the step', () => {
    if (confirm === undefined) throw new Error('no confirm case');
    renderScreen(confirm.snapshot);
    const pips = screen.getByTestId('step-pips') as TreeNode;
    expect(pips.props.accessible).toBe(true);
    expect(pips.props.accessibilityLabel).toBe('Step 2 of 5 · Check');
    expect(screen.getByLabelText(stepText(1))).toBe(pips);
    expect(ancestors(pips).some((node) => node.props.testID === 'stage')).toBe(true);
  });

  it('empty: no pips', () => {
    renderScreen(emptySnapshot());
    expect(screen.queryByTestId('step-pips')).toBeNull();
    expect(screen.queryByLabelText(/^Step \d of 5/)).toBeNull();
  });

  it.each(STATE_CASES)('$name: pips only when the screen has a step', (state) => {
    renderScreen(state.snapshot);
    const model = buildScreenModel(state.snapshot);
    const expected = state.tag !== 'empty' && model.step !== null ? model.step.text : null;
    const pips = screen.queryByTestId('step-pips');
    expect(pips?.props.accessibilityLabel ?? null).toBe(expected);
  });
});

describe('ImportScreen: confirm file card', () => {
  const confirm = STATE_CASES.find((item) => item.name === 'confirm');
  /** The nearest view holding both the size and the format values. */
  const sizeAndFormatParent = (): TreeNode => {
    if (confirm === undefined) throw new Error('no confirm case');
    renderScreen(confirm.snapshot);
    const size = screen.getByText('112 B') as TreeNode;
    const format = screen.getByText('CSV') as TreeNode;
    const formatAncestors = new Set(ancestors(format));
    const parent = ancestors(size).find((node) => formatAncestors.has(node));
    if (parent === undefined) throw new Error('no common parent');
    // The name is not in that row: it has a line of its own.
    expect(ancestors(screen.getByText('statement.csv') as TreeNode)).not.toContain(parent);
    return parent;
  };
  afterEach(() => {
    mockFontScale = null;
  });

  it('name on its own line; size and format side by side in one row', () => {
    mockFontScale = 1;
    expect(styleOf(sizeAndFormatParent()).flexDirection).toBe('row');
  });

  it('at a large font size, size and format stack', () => {
    mockFontScale = 2;
    expect(styleOf(sizeAndFormatParent()).flexDirection).toBe('column');
  });
});

describe("ImportScreen: Billy's log", () => {
  const sendingAt = (version: number) =>
    makeSnapshot(
      {
        tag: 'sending',
        op: opView({ revision: 0 }),
        attempt: 1,
        progress: { bytesSent: 50, totalBytes: 112 },
        cancelRequested: false,
        autoRetry: false,
        notStarted: false,
      },
      { actions: { cancelSending: true }, version },
    );
  const jobAt = (status: 'queued' | 'processing' | 'ready', version: number) =>
    makeSnapshot(
      {
        tag: 'job',
        op: opView({ revision: version, result: status === 'ready' ? READY_RESULT : null }),
        jobId: JOB_ID,
        status,
      },
      { actions: { refresh: true, requestDelete: true }, version },
    );

  it('is open while the import moves, folds into a toggle when ready, expands on press', () => {
    const fake = renderScreen(sendingAt(1));
    expect(screen.getByTestId('trace')).toBeTruthy();
    expect(screen.getByText('Sending 112 B')).toBeTruthy();
    expect(screen.queryByTestId('trace-toggle')).toBeNull();
    act(() => fake.set(jobAt('queued', 2)));
    act(() => fake.set(jobAt('processing', 3)));
    expect(screen.getByText('The server is reading it')).toBeTruthy();
    expect(screen.queryByTestId('trace-toggle')).toBeNull();

    act(() => fake.set(jobAt('ready', 4)));
    const toggle = screen.getByTestId('trace-toggle');
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityLabel).toBe('How I got here · 4 steps');
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('Sending 112 B')).toBeNull();
    expect(screen.queryByText('Report ready · 2 charges')).toBeNull();

    fireEvent.press(toggle);
    expect(screen.getByTestId('trace-toggle').props.accessibilityState).toMatchObject({
      expanded: true,
    });
    for (const line of [
      'Sending 112 B',
      'The server queued it',
      'The server is reading it',
      'Report ready · 2 charges',
    ]) {
      expect(screen.getByText(line)).toBeTruthy();
    }

    fireEvent.press(screen.getByTestId('trace-toggle'));
    expect(screen.queryByText('Sending 112 B')).toBeNull();
  });

  it('is not shown without an import', () => {
    renderScreen(emptySnapshot());
    expect(screen.queryByTestId('trace')).toBeNull();
  });
});

describe('ImportScreen: diagnostics', () => {
  it('is not rendered when diagnostics are disabled', () => {
    renderScreen(readySnapshot(), { diagnosticsEnabled: false });
    expect(screen.queryByTestId('diagnostics')).toBeNull();
    expect(screen.queryByText(/Diagnostics/)).toBeNull();
  });

  it('is a collapsed dev section when enabled', () => {
    const fake = renderScreen(readySnapshot(), { diagnosticsEnabled: true });
    expect(screen.getByTestId('diagnostics')).toBeTruthy();
    expect(screen.queryByTestId('diagnostics-body')).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe('ImportScreen: scroll position', () => {
  it('jumps to the top when the state changes, not on updates within one state', () => {
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const fake = renderScreen(readySnapshot());
    scrollTo.mockClear();
    act(() => fake.set(readySnapshot({ version: 2, actions: { refresh: true } })));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => fake.set(makeSnapshot({ tag: 'empty' }, { actions: { pickFile: true } })));
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
    scrollTo.mockRestore();
  });
});

/** Title styles: `font.title` and up (the monthly total is data, not a header, and scales). */
const isTitle = (style: TextStyle): boolean => (style.fontSize ?? 0) >= font.title;
const plainText = (node: TreeNode): string =>
  node.children.map((child) => (typeof child === 'string' ? child : plainText(child))).join('');
/** Average bold Cyrillic glyph width in em, measured on iOS (SF Pro) at AX5: ≈ 0.61. */
const BOLD_EM = 0.62;
/** 360-pt screen minus screen padding, card padding and the status card's 6-pt edge. */
const NARROW_TEXT_WIDTH = 360 - 4 * space.lg - 6;

describe('ImportScreen: large font and small screen (static check)', () => {
  it.each(STATE_CASES)(
    '$name: no font caps on content, everything inside one ScrollView',
    (state) => {
      renderScreen(state.snapshot, { diagnosticsEnabled: true });
      const root = hostRoot();
      expect(root.type).toBe('RCTScrollView');
      const texts = treeRoot().findAll((node) => node.type === 'Text');
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.props.allowFontScaling).not.toBe(false);
        const style = styleOf(text);
        // Only title-sized headers stop at TITLE_MAX_SCALE; body, report data and buttons scale.
        if (text.props.accessibilityRole === 'header' && isTitle(style)) {
          expect(text.props.maxFontSizeMultiplier).toBe(TITLE_MAX_SCALE);
          const words = plainText(text).split(/\s+/);
          const longest = Math.max(...words.map((word) => word.length));
          expect(longest * BOLD_EM * (style.fontSize ?? 0) * TITLE_MAX_SCALE).toBeLessThanOrEqual(
            NARROW_TEXT_WIDTH,
          );
        } else if (style.fontSize === font.display) {
          // Big amounts stop at DISPLAY_MAX_SCALE: the number stays whole and the largest on screen.
          expect(text.props.maxFontSizeMultiplier).toBe(DISPLAY_MAX_SCALE);
          // The number itself (the unit is a smaller nested span and wraps on its own).
          const number = plainText(text).split(/\s+/)[0] ?? '';
          expect(number.length * BOLD_EM * font.display * DISPLAY_MAX_SCALE).toBeLessThanOrEqual(
            NARROW_TEXT_WIDTH,
          );
          expect(font.display * DISPLAY_MAX_SCALE).toBeGreaterThan(font.body * 3.57);
        } else {
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
        }
        expect(text.props.numberOfLines).toBeUndefined();
        expect(text.props.adjustsFontSizeToFit).not.toBe(true);
        expect(style.height).toBeUndefined();
        expect(style.maxHeight).toBeUndefined();
      }
      for (const button of buttons()) {
        const style = styleOf(button);
        expect(style.minHeight).toBeGreaterThanOrEqual(44);
        expect(style.height).toBeUndefined();
        let node: TreeNode | null = button;
        while (node !== null && node.type !== 'RCTScrollView') node = node.parent;
        expect(node).toBe(root);
      }
    },
  );
});

describe('ImportScreen: accessibility', () => {
  let announce: jest.SpyInstance;
  beforeEach(() => {
    announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
  });
  afterEach(() => announce.mockRestore());

  const announced = (): string[] => announce.mock.calls.map((call) => String(call[0]));
  const job = (status: 'queued' | 'processing' | 'ready', version: number) =>
    makeSnapshot(
      {
        tag: 'job',
        op: opView({ revision: version, result: status === 'ready' ? READY_RESULT : null }),
        jobId: JOB_ID,
        status,
      },
      { actions: { refresh: true, requestDelete: true }, version },
    );
  const sending = (bytesSent: number, version: number) =>
    makeSnapshot(
      {
        tag: 'sending',
        op: opView(),
        attempt: 1,
        progress: { bytesSent, totalBytes: 100 },
        cancelRequested: false,
        autoRetry: false,
        notStarted: false,
      },
      { actions: { cancelSending: true }, version },
    );

  it('iOS: announces each phase change once, never on mount or on progress ticks', () => {
    const fake = renderScreen(sending(10, 1), { announceChanges: true });
    expect(announced()).toEqual([]);
    act(() => fake.set(sending(50, 2)));
    act(() => fake.set(sending(90, 3)));
    expect(announced()).toEqual([]);
    act(() => fake.set(job('queued', 4)));
    act(() => fake.set(job('queued', 5)));
    act(() => fake.set(job('processing', 6)));
    act(() => fake.set(job('ready', 7)));
    expect(announced()).toEqual([
      "In the queue. I'll show the report here.",
      "Reading your statement… I'll show the report here.",
      // No status line on ready: the title alone, no dangling period.
      "Here's what I found",
    ]);
  });

  it('iOS: one announcement for the whole abandon settle window (no flicker)', () => {
    const outcome = (lookup: 'pending' | 'settling', version: number) =>
      makeSnapshot(
        {
          tag: 'outcome_unknown',
          op: opView(),
          cause: 'reset_after_send',
          lookup,
          attempt: 1,
          abandon: true,
        },
        { version },
      );
    const fake = renderScreen(sending(40, 1), { announceChanges: true });
    let version = 2;
    for (const lookup of ['pending', 'settling', 'pending', 'settling', 'pending'] as const) {
      act(() => fake.set(outcome(lookup, version)));
      version += 1;
    }
    expect(announced()).toEqual([
      `${OUTCOME_TITLE_COPY.cancelling} ${OUTCOME_LOOKUP_COPY.settling}`,
    ]);
    expect(screen.getByText(OUTCOME_LOOKUP_COPY.settling)).toBeTruthy();
  });

  it('iOS: announces notices, the stale-status label, storage errors and the badge', () => {
    const queued = (overrides: Parameters<typeof makeSnapshot>[1]) =>
      makeSnapshot(
        { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
        { actions: { requestDelete: true }, ...overrides },
      );
    const fake = renderScreen(queued({ version: 1 }), { announceChanges: true });
    act(() => fake.set(queued({ version: 2, notice: { tag: 'cancel_too_late' } })));
    act(() =>
      fake.set(
        queued({
          version: 3,
          notice: { tag: 'cancel_too_late' },
          readError: { source: 'get', error: { kind: 'transport', cause: 'unreachable' } },
        }),
      ),
    );
    act(() => fake.set(queued({ version: 4, storageError: true })));
    expect(announced()).toEqual([
      'Too late to cancel: the server already has the file. You can delete the import.',
      'Last known status: server unreachable.',
      "Couldn't save on this device. The last action didn't complete.",
    ]);

    act(() =>
      fake.set(
        makeSnapshot(
          { tag: 'job', op: opView({ recoveredByKey: true }), jobId: JOB_ID, status: 'queued' },
          { version: 5 },
        ),
      ),
    );
    expect(announced().at(-1)).toBe(STATUS_COPY.recoveredByKey);
  });

  it('Android (no explicit announcements): status block and notices are live regions', () => {
    const fake = renderScreen(
      makeSnapshot(
        { tag: 'job', op: opView(), jobId: JOB_ID, status: 'queued' },
        { actions: { requestDelete: true }, notice: { tag: 'cancel_too_late' } },
      ),
      { announceChanges: false },
    );
    act(() => fake.set(job('processing', 2)));
    expect(announced()).toEqual([]);
    const region = screen.getByTestId('status-live-region');
    expect(region.props.accessibilityLiveRegion).toBe('polite');
    expect(region.props.collapsable).toBe(false);
    // Title and status are both inside the live region, so TalkBack hears the verdict too.
    // Any match inside the region counts (the same words may appear elsewhere on screen).
    const inRegion = (text: string) =>
      screen.getAllByText(text).some((match) => {
        let node: TreeNode | null = match as TreeNode;
        while (node !== null && node !== (region as TreeNode)) node = node.parent;
        return node !== null;
      });
    expect(inRegion(JOB_STATUS_COPY.processing.title)).toBe(true);
    expect(inRegion(JOB_STATUS_COPY.processing.status)).toBe(true);

    act(() =>
      fake.set(
        makeSnapshot(
          { tag: 'job', op: opView(), jobId: JOB_ID, status: 'processing' },
          { notice: { tag: 'cancel_too_late' }, version: 3 },
        ),
      ),
    );
    const alerts = hostRoot().findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityRole === 'alert',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.props.accessibilityLiveRegion).toBe('polite');
  });

  it('each "Подробнее" button names its merchant for screen readers', () => {
    renderScreen(readySnapshot());
    expect(buttonNames()).toEqual([
      'Details: StreamBeam',
      'Details: BrightGrid',
      'Refresh status',
      'Delete import',
    ]);
    expect(screen.getAllByText('Details')).toHaveLength(2);
  });
});

describe('ImportScreen: privacy cover over the "Подробнее" card', () => {
  it('the native card draws its own cover while the app-switcher cover is up', () => {
    const fake = createFakeController(readySnapshot());
    render(screenElement(fake, {}));
    fireEvent.press(screen.getByRole('button', { name: 'Details: StreamBeam' }));
    expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
    expect(screen.queryByTestId('privacy-cover')).toBeNull();

    screen.rerender(screenElement(fake, { covered: true }));
    // Still open underneath (nothing to re-open on return), but covered inside the modal.
    expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
    // Drawn inside the modal's own tree (a root-level sibling would sit under the native sheet).
    let node: TreeNode | null = screen.getByTestId('privacy-cover') as TreeNode;
    const ancestors: string[] = [];
    while (node !== null) {
      const type = node.type as string | { readonly name?: string };
      ancestors.push(typeof type === 'string' ? type : (type.name ?? ''));
      node = node.parent;
    }
    expect(ancestors).toContain('Modal');

    screen.rerender(screenElement(fake, { covered: false }));
    expect(screen.queryByTestId('privacy-cover')).toBeNull();
  });
});

describe('PrivacyCover', () => {
  it('renders an opaque cover without any import data', () => {
    render(<PrivacyCover />);
    expect(screen.getByTestId('privacy-cover')).toBeTruthy();
    expect(screen.getByText('Content hidden')).toBeTruthy();
  });
});
