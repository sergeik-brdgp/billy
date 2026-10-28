// State-specific body of the import screen: one small component per view tag, chosen by an
// exhaustive switch (adding a tag to the core without a branch here is a type error).
// Title / status / buttons are common and come from the view model (viewModel.ts).

import { useEffect } from 'react';
import { Animated, StyleSheet, useAnimatedValue, View } from 'react-native';

import { assertNever, type ImportView } from '../core';
import { Facts, ProgressBar } from './components/parts';
import { ReportView } from './components/report';
import { useReducedMotion } from './motion';
import { space, useTheme } from './theme';
import type { ScreenModel } from './viewModel';

export interface StateBodyProps {
  readonly view: ImportView;
  readonly model: ScreenModel;
  readonly onOpenDetails: (itemId: string) => void;
}

export function StateBody({ view, model, onOpenDetails }: StateBodyProps) {
  switch (view.tag) {
    case 'starting':
    case 'preparing':
    case 'delete_requested':
    case 'deleting':
      return <Waiting />;
    case 'storage_unavailable':
    case 'local_rejection':
    case 'delete_failed':
    case 'deleted':
    case 'lost':
    case 'rejected_by_server':
    case 'cancelled':
    case 'empty':
      // Everything these states say is in the status panel and the buttons.
      return null;
    case 'confirm':
    case 'outcome_unknown':
      return <Facts facts={model.facts} />;
    case 'sending':
      return <SendingBody model={model} />;
    case 'job':
      return <JobBody status={view.status} model={model} onOpenDetails={onOpenDetails} />;
    default:
      return assertNever(view, 'view');
  }
}

/** Three bouncing dots (decorative: the status text says what is happening). */
function Waiting() {
  const { color } = useTheme();
  const reduced = useReducedMotion();
  const dot0 = useAnimatedValue(0);
  const dot1 = useAnimatedValue(0);
  const dot2 = useAnimatedValue(0);
  const dots = [dot0, dot1, dot2];
  useEffect(() => {
    const dots = [dot0, dot1, dot2];
    if (reduced) {
      for (const dot of dots) dot.setValue(0);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.stagger(
        140,
        dots.map((dot) =>
          Animated.sequence([
            Animated.timing(dot, { toValue: 1, duration: 260, useNativeDriver: true }),
            Animated.timing(dot, { toValue: 0, duration: 260, useNativeDriver: true }),
          ]),
        ),
      ),
    );
    animation.start();
    return () => animation.stop();
  }, [dot0, dot1, dot2, reduced]);
  return (
    <View
      testID="waiting"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.dots}
    >
      {dots.map((dot, index) => (
        <Animated.View
          key={index}
          style={[
            styles.dot,
            {
              backgroundColor: color.primary,
              transform: [
                { translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

function SendingBody({ model }: { readonly model: ScreenModel }) {
  return (
    <View style={styles.stack}>
      {model.progress !== null ? <ProgressBar progress={model.progress} /> : null}
      <Facts facts={model.facts} />
    </View>
  );
}

function JobBody({
  status,
  model,
  onOpenDetails,
}: {
  readonly status: Extract<ImportView, { tag: 'job' }>['status'];
  readonly model: ScreenModel;
  readonly onOpenDetails: (itemId: string) => void;
}) {
  return (
    <View style={styles.stack}>
      {status !== 'ready' ? <Waiting /> : null}
      {/* Only status=ready with a result renders a report. */}
      {status === 'ready' && model.report !== null ? (
        <ReportView report={model.report} onOpenDetails={onOpenDetails} />
      ) : null}
      <Facts facts={model.facts} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  dots: {
    flexDirection: 'row',
    alignSelf: 'center',
    gap: space.sm,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
