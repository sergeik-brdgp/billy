// Dev-only diagnostics: rendered by ImportScreen only when diagnostics are
// enabled, collapsed by default at the bottom of the screen. Talks to the mock's /__test routes
// through `controller.diagnostics` and re-reads `/__test/state` on open and after every
// observable server action.

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  MOCK_MODES,
  type ImportController,
  type ImportSnapshot,
  type MockMode,
  type MockState,
} from '../../core';
import { DIAGNOSTICS_COPY, MOCK_MODE_COPY, apiErrorText } from '../copy';
import { ActionButton } from '../components/ActionButton';
import { textStyles } from '../components/parts';
import { radius, space, useTheme } from '../theme';
import {
  counterLines,
  ignoredSummary,
  localSizeText,
  localStateLines,
  rawViewText,
} from './diagnosticsModel';

type ServerState =
  | { readonly tag: 'idle' }
  | { readonly tag: 'ok'; readonly state: MockState }
  | { readonly tag: 'error'; readonly text: string };

export interface DiagnosticsPanelProps {
  readonly controller: ImportController;
  readonly snapshot: ImportSnapshot;
}

/** Changes whenever the mock counters can have changed (not on every poll tick). */
function serverActivityKey(snapshot: ImportSnapshot): string {
  const view = snapshot.view;
  const status = view.tag === 'job' ? view.status : '';
  const { posting, deleting } = snapshot.activity;
  return [
    view.tag,
    status,
    snapshot.diagnostics.jobId ?? '',
    snapshot.diagnostics.revision ?? '',
    posting,
    deleting,
    snapshot.diagnostics.ignoredViews.count,
  ].join('|');
}

export function DiagnosticsPanel({ controller, snapshot }: DiagnosticsPanelProps) {
  const { color } = useTheme();
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<ServerState>({ tag: 'idle' });
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  /** Only the latest /__test/state response is applied. */
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    loadSeq.current += 1;
    const seq = loadSeq.current;
    const result = await controller.diagnostics.fetchServerState();
    if (seq !== loadSeq.current) return;
    setServer(
      result.ok
        ? { tag: 'ok', state: result.value }
        : {
            tag: 'error',
            text: `${DIAGNOSTICS_COPY.requestFailed}: ${apiErrorText(result.error)}`,
          },
    );
  }, [controller]);

  const activityKey = serverActivityKey(snapshot);
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, activityKey, load]);

  const runAction = (action: () => Promise<string | null>): void => {
    setPending(true);
    setMessage(null);
    void action()
      .then(async (text) => {
        setMessage(text);
        await load();
      })
      .catch(() => setMessage(DIAGNOSTICS_COPY.requestFailed))
      .finally(() => setPending(false));
  };

  const onScenario = (mode: MockMode): void =>
    runAction(async () => {
      const result = await controller.diagnostics.setScenario(mode);
      return result.ok ? null : `${DIAGNOSTICS_COPY.requestFailed}: ${apiErrorText(result.error)}`;
    });

  const onReset = (): void => {
    setConfirmReset(false);
    runAction(async () => {
      const result = await controller.diagnostics.resetMockAndLocal();
      return result.ok
        ? DIAGNOSTICS_COPY.resetDone
        : `${DIAGNOSTICS_COPY.resetFailed}: ${apiErrorText(result.error)}`;
    });
  };

  const diagnostics = snapshot.diagnostics;
  const mode = server.tag === 'ok' ? server.state.mode : null;
  const muted = { color: color.textMuted };
  const plain = { color: color.text };

  return (
    <View
      testID="diagnostics"
      style={[styles.panel, { borderColor: color.border, backgroundColor: color.surfaceMuted }]}
    >
      <ActionButton
        label={open ? DIAGNOSTICS_COPY.toggleClose : DIAGNOSTICS_COPY.toggleOpen}
        hint={DIAGNOSTICS_COPY.toggleHint}
        kind="secondary"
        enabled
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <View style={styles.body} testID="diagnostics-body">
          <Row label={DIAGNOSTICS_COPY.baseUrl} value={diagnostics.baseUrl} />
          <Row
            label={DIAGNOSTICS_COPY.mode}
            value={mode === null ? DIAGNOSTICS_COPY.modeUnknown : MOCK_MODE_COPY[mode]}
          />
          {server.tag === 'error' ? (
            <Text style={[textStyles.body, { color: color.danger }]}>{server.text}</Text>
          ) : null}
          {server.tag === 'idle' ? (
            <Text style={[textStyles.small, muted]}>{DIAGNOSTICS_COPY.loading}</Text>
          ) : null}

          <Text accessibilityRole="header" style={[textStyles.body, textStyles.strong, plain]}>
            {DIAGNOSTICS_COPY.scenarios}
          </Text>
          <View style={styles.wrap}>
            {MOCK_MODES.map((item) => (
              <ActionButton
                key={item}
                label={MOCK_MODE_COPY[item]}
                hint={DIAGNOSTICS_COPY.scenarioHint(MOCK_MODE_COPY[item])}
                kind={item === mode ? 'primary' : 'secondary'}
                selected={item === mode}
                enabled={!pending}
                onPress={() => onScenario(item)}
              />
            ))}
          </View>

          {server.tag === 'ok' ? (
            <>
              <Lines title={DIAGNOSTICS_COPY.counters} lines={counterLines(server.state.stats)} />
              <Lines
                title={DIAGNOSTICS_COPY.jobs}
                lines={
                  server.state.jobs.length === 0
                    ? [DIAGNOSTICS_COPY.noJobs]
                    : server.state.jobs.map((job) =>
                        DIAGNOSTICS_COPY.jobLine(job.jobId, job.status, job.revision, job.bytes),
                      )
                }
              />
            </>
          ) : null}
          <Row label={DIAGNOSTICS_COPY.localSize} value={localSizeText(diagnostics.localSize)} />
          <Lines title={DIAGNOSTICS_COPY.localState} lines={localStateLines(diagnostics)} />
          <Row label={DIAGNOSTICS_COPY.lastRawView} value={rawViewText(diagnostics.lastRawView)} />
          <Row label={DIAGNOSTICS_COPY.ignored} value={ignoredSummary(diagnostics.ignoredViews)} />
          {diagnostics.extraOperations > 0 ? (
            <Row label={DIAGNOSTICS_COPY.extraOps} value={String(diagnostics.extraOperations)} />
          ) : null}

          {message !== null ? (
            <Text accessibilityLiveRegion="polite" style={[textStyles.body, plain]}>
              {message}
            </Text>
          ) : null}

          <ActionButton
            label={DIAGNOSTICS_COPY.reload}
            hint={DIAGNOSTICS_COPY.reloadHint}
            kind="secondary"
            enabled={!pending}
            onPress={() => runAction(async () => null)}
          />
          {confirmReset ? (
            <View style={[styles.confirm, { borderColor: color.danger }]}>
              <Text style={[textStyles.body, textStyles.strong, plain]}>
                {DIAGNOSTICS_COPY.resetConfirmTitle}
              </Text>
              <Text style={[textStyles.small, plain]}>{DIAGNOSTICS_COPY.resetConfirmBody}</Text>
              <ActionButton
                label={DIAGNOSTICS_COPY.resetConfirm}
                kind="danger"
                enabled={!pending}
                onPress={onReset}
              />
              <ActionButton
                label={DIAGNOSTICS_COPY.resetCancel}
                kind="secondary"
                enabled
                onPress={() => setConfirmReset(false)}
              />
            </View>
          ) : (
            <ActionButton
              label={DIAGNOSTICS_COPY.reset}
              hint={DIAGNOSTICS_COPY.resetHint}
              kind="destructive"
              enabled={!pending}
              onPress={() => setConfirmReset(true)}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  const { color } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[textStyles.small, { color: color.textMuted }]}>{label}</Text>
      <Text selectable style={[textStyles.body, { color: color.text }]}>
        {value}
      </Text>
    </View>
  );
}

function Lines({ title, lines }: { readonly title: string; readonly lines: readonly string[] }) {
  const { color } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[textStyles.small, { color: color.textMuted }]}>{title}</Text>
      {lines.map((line) => (
        <Text key={line} selectable style={[textStyles.body, { color: color.text }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    padding: space.md,
    gap: space.md,
  },
  body: { gap: space.md },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { gap: 2 },
  confirm: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
});
