// Billy's "how I got here" log under the speech bubble. While the import is moving the log is open
// and its last line pulses ("working on it"); once it settles it folds into one tappable line,
// like a collapsed reasoning trace. Lines come from src/ui/trace.ts (observed states only).

import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { TRACE_COPY } from '../copy';
import { useType } from '../fonts';
import { useAppear, useLoop, useReducedMotion } from '../motion';
import { MIN_TOUCH, font, radius, space, useTheme } from '../theme';
import type { Trace, TraceLine } from '../trace';

export function TraceView({ trace }: { readonly trace: Trace }) {
  const { color } = useTheme();
  const type = useType();
  const [open, setOpen] = useState(false);
  if (trace.lines.length === 0) return null;
  const summary = TRACE_COPY.summary(trace.lines.length);
  const folded = trace.settled && !open;

  const toggle = trace.settled ? (
    <Pressable
      testID="trace-toggle"
      accessibilityRole="button"
      accessibilityLabel={summary}
      accessibilityHint={TRACE_COPY.showHint}
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((value) => !value)}
      style={styles.toggle}
    >
      <Text style={[styles.small, type.heavy, styles.flex, { color: color.textMuted }]}>
        {summary}
      </Text>
      <View
        style={[
          styles.chevron,
          { borderColor: color.textMuted, transform: [{ rotate: open ? '-45deg' : '135deg' }] },
        ]}
      />
    </Pressable>
  ) : null;

  return (
    <View testID="trace" style={[styles.box, { backgroundColor: color.surfaceMuted }]}>
      {toggle}
      {folded
        ? null
        : trace.lines.map((line, index) => (
            // A key can repeat (a retried delete, a second lookup); lines are append-only, so the
            // position makes the React key unique and stable.
            <Line
              key={`${line.key}:${index}`}
              id={`${line.key}:${index}`}
              line={line}
              current={!trace.settled && index === trace.lines.length - 1}
            />
          ))}
    </View>
  );
}

function Line({
  id,
  line,
  current,
}: {
  readonly id: string;
  readonly line: TraceLine;
  readonly current: boolean;
}) {
  const { color } = useTheme();
  const type = useType();
  const reduced = useReducedMotion();
  const appear = useAppear(id);
  // A few soft pulses on the line being worked on; finite, so the screen goes idle.
  const pulse = useLoop(current && !reduced, 900, 6, id);
  const opacity = current
    ? pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.35, 1] })
    : 1;
  return (
    <Animated.View style={[styles.line, appear]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.mark}
      >
        {current ? (
          <Animated.View style={[styles.dot, { backgroundColor: color.primary, opacity }]} />
        ) : (
          <View style={[styles.tick, { borderColor: color.tone.success }]} />
        )}
      </View>
      <Text
        style={[
          styles.small,
          current ? type.heavy : type.regular,
          styles.flex,
          { color: current ? color.text : color.textMuted },
        ]}
      >
        {line.text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: radius.lg,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm,
    gap: space.xs,
  },
  toggle: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  chevron: { width: 8, height: 8, borderRightWidth: 2, borderTopWidth: 2, marginRight: 4 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: 2 },
  mark: { width: 16, height: 20, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  tick: {
    width: 5,
    height: 9,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    marginTop: -2,
    transform: [{ rotate: '45deg' }],
  },
  small: { fontSize: font.small },
  flex: { flex: 1 },
});
