// The one import screen. Reads the controller snapshot with useSyncExternalStore,
// derives everything it shows through the pure view model, and maps button taps to controller
// commands. The only screen-local state: the picker in progress and which "Details" card is
// open. The delete confirmation is a native alert (focus and announcement handled by the OS).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, ScrollView, StyleSheet, Text, type ScrollViewInstance } from 'react-native';

import { assertNever, type ImportController, type ImportSnapshot, type PickedFile } from '../core';
import { useAnnouncements } from './a11y';
import { ActionButton } from './components/ActionButton';
import { NoticeBox } from './components/parts';
import { StatusPanel } from './components/Stage';
import { TraceView } from './components/Trace';
import { DetailsModal } from './components/report';
import { APP_TITLE, DELETE_CONFIRM_COPY, type ActionId } from './copy';
import { DiagnosticsPanel } from './diagnostics/DiagnosticsPanel';
import { useType } from './fonts';
import { StateBody } from './states';
import { font, space, TITLE_MAX_SCALE, useTheme } from './theme';
import { advanceTrace, EMPTY_TRACE } from './trace';
import { buildScreenModel, itemReceipt, type LocalUiState } from './viewModel';

/** Everything the UI needs from the composition root (src/main). */
export interface ImportScreenProps {
  readonly controller: ImportController;
  /** System picker; resolves null when the user cancels. */
  readonly pickFile: () => Promise<PickedFile | null>;
  /** Dev diagnostics panel (`__DEV__` or `EXPO_PUBLIC_DIAGNOSTICS=1`, decided by src/main). */
  readonly diagnosticsEnabled: boolean;
  /**
   * The app-switcher privacy cover is up (iOS, decided by src/main). The root-level cover cannot
   * reach the native "Details" modal, so the modal draws its own.
   */
  readonly covered?: boolean;
  /**
   * Announce changes through `announceForAccessibility` (iOS: no live regions). Android relies on
   * the live regions instead. Decided by src/adapters/platform.ts, passed in by src/main.
   */
  readonly announceChanges?: boolean;
}

function jobKeyOf(snapshot: ImportSnapshot): string | null {
  const view = snapshot.view;
  return view.tag === 'job' ? `${view.op.opId}:${view.jobId}` : null;
}

/** Commands never reject by contract; a stray rejection must not become an unhandled one. */
function fireAndForget(command: () => Promise<unknown>): void {
  void command().catch(() => undefined);
}

export function ImportScreen({
  controller,
  pickFile,
  diagnosticsEnabled,
  covered = false,
  announceChanges = false,
}: ImportScreenProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const theme = useTheme();
  const type = useType();
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<LocalUiState['pickError']>(null);
  /** The alert's button runs later: it must see the snapshot of that moment, not of the tap. */
  const latest = useRef(snapshot);
  useEffect(() => {
    latest.current = snapshot;
  }, [snapshot]);
  const [details, setDetails] = useState<{
    readonly jobKey: string;
    readonly itemId: string;
  } | null>(null);

  // Billy says hello on the first empty screen of this app session only (in memory, see LocalUiState).
  const [greeting, setGreeting] = useState(true);
  if (greeting && snapshot.view.tag !== 'empty' && snapshot.view.tag !== 'starting') {
    setGreeting(false);
  }
  // Billy's log of this import: folded from snapshots (derived state, updated during render).
  const [trace, setTrace] = useState(EMPTY_TRACE);
  const nextTrace = advanceTrace(trace, snapshot);
  if (nextTrace !== trace) setTrace(nextTrace);
  const model = useMemo(
    () => buildScreenModel(snapshot, { pickError, greeting }),
    [snapshot, pickError, greeting],
  );
  useAnnouncements(model, announceChanges);

  const view = snapshot.view;
  const jobKey = jobKeyOf(snapshot);

  // A new state starts at the top: a shorter screen must not stay scrolled past its title.
  const scrollRef = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [view.tag]);

  const onPick = async (): Promise<void> => {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await pickFile();
      if (picked === null) return;
      const result = await controller.prepareFile(picked);
      // Local rejections are part of the snapshot; only "busy" needs a local message.
      if (!result.ok && result.error.reason === 'busy') setPickError('busy');
    } catch {
      setPickError('failed');
    } finally {
      setPicking(false);
    }
  };

  const confirmDelete = (forJob: string | null): void => {
    if (forJob === null) return;
    Alert.alert(DELETE_CONFIRM_COPY.title, DELETE_CONFIRM_COPY.body, [
      { text: DELETE_CONFIRM_COPY.keep, style: 'cancel' },
      {
        text: DELETE_CONFIRM_COPY.confirm,
        style: 'destructive',
        onPress: () => {
          // Only for the job the alert was opened for, and only while deleting is still allowed.
          const now = latest.current;
          if (jobKeyOf(now) !== forJob || !now.actions.requestDelete) return;
          fireAndForget(() => controller.requestDelete());
        },
      },
    ]);
  };

  const onAction = (id: ActionId): void => {
    setPickError(null);
    switch (id) {
      case 'pickFile':
        fireAndForget(onPick);
        return;
      case 'confirmSend':
        if (view.tag === 'confirm') {
          const draftId = view.draft.draftId;
          fireAndForget(() => controller.confirmSend(draftId));
        }
        return;
      case 'requestDelete':
        // Destructive: ask first. A native alert gets screen-reader focus and is announced.
        confirmDelete(jobKey);
        return;
      case 'cancelDraft':
        fireAndForget(() => controller.cancelDraft());
        return;
      case 'cancelSending':
        fireAndForget(() => controller.cancelSending());
        return;
      case 'checkAgain':
        fireAndForget(() => controller.checkAgain());
        return;
      case 'resend':
        fireAndForget(() => controller.resend());
        return;
      case 'abandon':
        fireAndForget(() => controller.abandon());
        return;
      case 'refresh':
        fireAndForget(() => controller.refresh());
        return;
      case 'retryDelete':
        fireAndForget(() => controller.retryDelete());
        return;
      case 'newImport':
        fireAndForget(() => controller.newImport());
        return;
      case 'retryStorage':
        fireAndForget(() => controller.retryStorage());
        return;
      default:
        assertNever(id, 'action');
    }
  };

  const onOpenDetails = (itemId: string): void => {
    if (jobKey === null) return;
    setDetails({ jobKey, itemId });
    // Opening "Details" re-checks the job, through I2 as always.
    if (snapshot.actions.refresh) fireAndForget(() => controller.refresh());
  };

  // The card shows the current server data and closes by itself once the job is not ready.
  const result = view.tag === 'job' && view.status === 'ready' ? view.op.result : null;
  const detailIndex =
    details !== null && details.jobKey === jobKey && result !== null
      ? result.items.findIndex((item) => item.id === details.itemId)
      : -1;
  const detailItem =
    detailIndex >= 0 && result !== null ? (result.items[detailIndex] ?? null) : null;
  const currency = result !== null ? result.currency : null;
  const jobId = view.tag === 'job' ? view.jobId : null;
  const revision = view.tag === 'job' ? view.op.revision : null;
  // Memoized: the card keeps the same receipt object while the data is unchanged (it holds the
  // last receipt while sliding out, see DetailsModal).
  const receipt = useMemo(
    () =>
      detailItem !== null && currency !== null && jobId !== null && revision !== null
        ? itemReceipt(detailItem, detailIndex, currency, jobId, revision)
        : null,
    [detailItem, detailIndex, currency, jobId, revision],
  );

  const actionButtons = model.buttons.map((button) => (
    <ActionButton
      key={button.id}
      testID={`action-${button.id}`}
      label={button.label}
      hint={button.hint}
      kind={button.kind}
      enabled={button.enabled && !(button.id === 'pickFile' && picking)}
      busy={button.busy || (button.id === 'pickFile' && picking)}
      onPress={() => onAction(button.id)}
    />
  ));

  return (
    <ScrollView
      ref={scrollRef}
      testID="import-screen"
      style={[styles.root, { backgroundColor: theme.color.background }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
    >
      <Text
        testID="app-title"
        accessibilityRole="header"
        maxFontSizeMultiplier={TITLE_MAX_SCALE}
        style={[styles.appTitle, type.black, { color: theme.color.text }]}
      >
        {APP_TITLE}
      </Text>
      {model.storageBanner !== null ? (
        <>
          <NoticeBox text={model.storageBanner.text} tone="danger" />
          {model.storageBanner.retry !== null ? (
            <ActionButton
              label={model.storageBanner.retry.label}
              hint={model.storageBanner.retry.hint}
              kind="primary"
              enabled={model.storageBanner.retry.enabled}
              onPress={() => onAction('retryStorage')}
            />
          ) : null}
        </>
      ) : null}
      <StatusPanel model={model} />
      {model.notice !== null ? <NoticeBox text={model.notice} tone="warning" /> : null}
      <TraceView key={nextTrace.opId ?? 'none'} trace={nextTrace} />
      <StateBody view={view} model={model} onOpenDetails={onOpenDetails} />
      {actionButtons}
      {model.footnote !== null ? (
        <Text style={[styles.footnote, type.bold, { color: theme.color.textMuted }]}>
          {model.footnote}
        </Text>
      ) : null}
      {diagnosticsEnabled ? <DiagnosticsPanel controller={controller} snapshot={snapshot} /> : null}
      <DetailsModal receipt={receipt} covered={covered} onClose={() => setDetails(null)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    flexGrow: 1,
    padding: space.lg,
    // The safe-area top inset is applied by the parent (src/main), so scrolled content never
    // slides under the status bar / Dynamic Island. Bottom padding clears the gesture bar.
    paddingBottom: space.xxl * 2,
    gap: space.lg,
  },
  appTitle: { fontSize: font.heading, letterSpacing: -0.3 },
  footnote: { fontSize: font.small, textAlign: 'center', marginTop: -space.xs },
});
