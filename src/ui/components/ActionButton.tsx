// Accessible chunky button: role, label, hint, disabled/busy state exposed to screen readers,
// ≥ 48 pt touch target, text that wraps and scales with the system font (no caps on size).
// Look: a face sitting on a 4-pt "lip"; pressing sinks the face onto the lip (motion.ts).
// The label is drawn in capitals (textTransform only): what screen readers hear is unchanged.

import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useType } from '../fonts';
import { usePress } from '../motion';
import { LIP, MIN_TOUCH, font, radius, space, useTheme } from '../theme';
import type { ButtonKind } from '../viewModel';

export interface ActionButtonProps {
  readonly label: string;
  /** Screen-reader label when the visible label alone is ambiguous (defaults to `label`). */
  readonly accessibilityLabel?: string;
  readonly hint?: string;
  /** `danger`: filled destructive button (final confirmation only). */
  readonly kind: ButtonKind | 'danger';
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}

export function ActionButton({
  label,
  accessibilityLabel,
  hint,
  kind,
  enabled,
  busy = false,
  selected,
  onPress,
  testID,
}: ActionButtonProps) {
  const { color } = useTheme();
  const type = useType();
  const press = usePress();
  // primary / danger: filled with a darker lip; secondary / destructive: outlined, grey lip.
  const filled = kind === 'primary' || kind === 'danger';
  const red = kind === 'destructive' || kind === 'danger';
  const face = !enabled
    ? color.disabled
    : filled
      ? red
        ? color.danger
        : color.primary
      : color.surface;
  const lip = !enabled
    ? color.border
    : filled
      ? red
        ? color.dangerLip
        : color.primaryLip
      : selected === true
        ? color.primary
        : color.border;
  const outline = filled || !enabled ? face : selected === true ? color.primary : color.border;
  const foreground = !enabled
    ? color.onDisabled
    : filled
      ? red
        ? color.onDanger
        : color.onPrimary
      : red
        ? color.onDangerSoft
        : color.onPrimarySoft;
  const sink = press.pressed.interpolate({ inputRange: [0, 1], outputRange: [0, LIP.button] });
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hint}
      accessibilityState={{
        disabled: !enabled,
        busy,
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={!enabled}
      onPress={onPress}
      onPressIn={enabled ? press.onPressIn : undefined}
      onPressOut={enabled ? press.onPressOut : undefined}
      style={[styles.button, { backgroundColor: lip }]}
    >
      <Animated.View
        style={[
          styles.face,
          {
            backgroundColor: face,
            borderColor: outline,
            borderWidth: selected === true ? 3 : 2,
            transform: [{ translateY: sink }],
          },
        ]}
      >
        <View style={styles.row}>
          {busy ? <ActivityIndicator size="small" color={foreground} /> : null}
          <Text style={[styles.label, type.black, { color: foreground }]}>{label}</Text>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: MIN_TOUCH + LIP.button,
    borderRadius: radius.lg,
    paddingBottom: LIP.button,
  },
  face: {
    flexGrow: 1,
    minHeight: MIN_TOUCH,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  label: {
    fontSize: font.body,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign: 'center',
    flexShrink: 1,
  },
});
