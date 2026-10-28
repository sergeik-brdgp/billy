// Neutral full-screen message drawn by the composition root instead of the import screen:
// a render crash caught by the error boundary, or a malformed mock URL. Shows no import data.

import { ScrollView, StyleSheet, Text } from 'react-native';

import { ActionButton } from './components/ActionButton';
import { APP_TITLE, FALLBACK_COPY } from './copy';
import { useType } from './fonts';
import { font, space, TITLE_MAX_SCALE, useTheme } from './theme';

export interface FallbackScreenProps {
  readonly variant: 'crash' | 'config';
  /** Re-renders the import screen (crash only). */
  readonly onRetry?: () => void;
}

export function FallbackScreen({ variant, onRetry }: FallbackScreenProps) {
  const { color } = useTheme();
  const type = useType();
  const copy = FALLBACK_COPY[variant];
  return (
    <ScrollView
      testID={`fallback-${variant}`}
      style={[styles.root, { backgroundColor: color.background }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="never"
    >
      <Text
        maxFontSizeMultiplier={TITLE_MAX_SCALE}
        accessibilityRole="header"
        style={[styles.appTitle, type.black, { color: color.text }]}
      >
        {APP_TITLE}
      </Text>
      <Text
        maxFontSizeMultiplier={TITLE_MAX_SCALE}
        accessibilityRole="alert"
        style={[styles.title, type.black, { color: color.text }]}
      >
        {copy.title}
      </Text>
      <Text style={[styles.text, type.regular, { color: color.textMuted }]}>{copy.text}</Text>
      {onRetry !== undefined ? (
        <ActionButton
          testID="fallback-retry"
          label={FALLBACK_COPY.retry}
          hint={FALLBACK_COPY.retryHint}
          kind="primary"
          enabled
          onPress={onRetry}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    flexGrow: 1,
    padding: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xxl * 2,
    gap: space.lg,
  },
  appTitle: { fontSize: font.heading },
  title: { fontSize: font.title },
  text: { fontSize: font.body },
});
