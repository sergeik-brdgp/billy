// The speaker: Billy and his speech bubble. With a step (check → report) Billy stands beside the
// bubble and the bubble opens with a row of five step pips (choose · check · send · wait · report)
// that fill up as the import moves on. Without a step — the greeting on the empty screen, «All
// gone», start-up and storage problems — Billy stands in the middle above the bubble.
// Decorative parts are hidden from screen readers; the pip row is one element that reads the step.
// Motion: a pip fills with a native-driver spring when its step is reached; Reduce Motion: no motion.

import { useEffect } from 'react';
import { Animated, StyleSheet, Text, useAnimatedValue, View } from 'react-native';

import { useType } from '../fonts';
import { useAppear, useReducedMotion } from '../motion';
import { font, radius, space, TITLE_MAX_SCALE, useTheme } from '../theme';
import type { ScreenModel, StepModel } from '../viewModel';
import { Mascot } from './Mascot';
import { Badge, moodFor, useStacked } from './parts';

export function StatusPanel({ model }: { readonly model: ScreenModel }) {
  const { color } = useTheme();
  const type = useType();
  const stacked = useStacked();
  const appear = useAppear(`${model.tag}:${model.title}`);
  const step = model.tag === 'empty' ? null : model.step;
  const centred = step === null;
  const tinted = model.tone === 'danger' || model.tone === 'warning';
  const bubble = tinted ? color.toneSurface[model.tone] : color.surface;
  const outline = tinted ? color.toneBorder[model.tone] : color.border;
  // Billy above the bubble when centred or at large fonts; beside it otherwise.
  const above = centred || stacked;

  return (
    <View testID="stage" style={[styles.speaker, above ? styles.column : styles.row]}>
      <View style={centred ? styles.centred : undefined}>
        <Mascot mood={moodFor(model)} scale={stacked && !centred ? 0.8 : 1} />
      </View>
      <Animated.View
        style={[
          styles.bubble,
          above ? styles.bubbleBelow : styles.bubbleBeside,
          { backgroundColor: bubble, borderColor: outline },
          appear,
        ]}
      >
        <View
          style={[
            styles.tail,
            above ? (centred ? styles.tailUpCentre : styles.tailUp) : styles.tailLeft,
            { backgroundColor: bubble, borderColor: outline },
          ]}
        />
        {step !== null ? <StepPips step={step} /> : null}
        {/* Android live region over badge + title + status: TalkBack reads the whole block when any
            of it changes, i.e. the same lines iOS announces (a11y.ts). Not `accessible`, so title
            stays a separate header for navigation; `collapsable={false}` keeps the view from being
            flattened away. */}
        <View
          testID="status-live-region"
          accessibilityLiveRegion="polite"
          collapsable={false}
          style={styles.statusLines}
        >
          {model.badge !== null ? <Badge text={model.badge} tone="success" /> : null}
          {model.stale !== null ? <Badge text={model.stale.label} tone="warning" /> : null}
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={TITLE_MAX_SCALE}
            style={[styles.title, type.black, { color: color.text }]}
          >
            {model.title}
          </Text>
          {model.statusText !== '' ? (
            <Text style={[styles.body, type.regular, { color: color.textMuted }]}>
              {model.statusText}
            </Text>
          ) : null}
        </View>
        {model.detail !== null ? (
          <Text style={[styles.body, type.bold, { color: color.text }]}>{model.detail}</Text>
        ) : null}
        {model.stale !== null ? (
          <Text style={[styles.small, type.regular, { color: color.textMuted }]}>
            {model.stale.reason}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

/** Five pips; the ones up to the current step are filled. One accessible element: «Step 2 of 5 · Check». */
function StepPips({ step }: { readonly step: StepModel }) {
  return (
    <View testID="step-pips" accessible accessibilityLabel={step.text} style={styles.pips}>
      {Array.from({ length: step.count }, (_, i) => (
        <Pip key={i} filled={i <= step.index} failed={step.failed && i === step.index} />
      ))}
    </View>
  );
}

function Pip({ filled, failed }: { readonly filled: boolean; readonly failed: boolean }) {
  const { color } = useTheme();
  const reduced = useReducedMotion();
  const fill = useAnimatedValue(filled ? 1 : 0);
  useEffect(() => {
    const to = filled ? 1 : 0;
    if (reduced) {
      fill.setValue(to);
      return undefined;
    }
    const animation = Animated.spring(fill, {
      toValue: to,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    });
    animation.start();
    return () => animation.stop();
  }, [filled, reduced, fill]);
  return (
    <View style={[styles.pip, { backgroundColor: color.track }]}>
      <Animated.View
        style={[
          styles.pipFill,
          {
            backgroundColor: failed ? color.danger : color.primary,
            transform: [{ scaleX: fill }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  speaker: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  column: { flexDirection: 'column', alignItems: 'stretch', gap: space.md },
  centred: { alignSelf: 'center' },
  bubble: {
    borderWidth: 2,
    borderRadius: radius.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 2,
    gap: space.sm,
  },
  bubbleBeside: { flex: 1, minWidth: 0, marginBottom: space.xl },
  bubbleBelow: { alignSelf: 'stretch' },
  // Decorative tail: a rotated square showing two of its outlined edges.
  tail: { position: 'absolute', width: 16, height: 16, transform: [{ rotate: '45deg' }] },
  tailLeft: { left: -9, bottom: 22, borderLeftWidth: 2, borderBottomWidth: 2 },
  tailUp: { top: -9, left: 40, borderLeftWidth: 2, borderTopWidth: 2 },
  tailUpCentre: {
    top: -9,
    left: '50%',
    borderLeftWidth: 2,
    borderTopWidth: 2,
    transform: [{ translateX: -8 }, { rotate: '45deg' }],
  },
  pips: { flexDirection: 'row', gap: 6, marginBottom: space.xs },
  pip: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  pipFill: { flex: 1, borderRadius: 4, transformOrigin: 'left' },
  statusLines: { gap: space.xs + 2 },
  title: { fontSize: font.title },
  body: { fontSize: font.body },
  small: { fontSize: font.small },
});
