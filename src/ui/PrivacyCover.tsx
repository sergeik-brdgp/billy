// Opaque cover for the iOS app switcher snapshot. src/main decides when to show it
// (AppState inactive / background); this component only draws it above everything else.

import { StyleSheet, Text, View } from 'react-native';

import { Mascot } from './components/Mascot';
import { APP_TITLE, PRIVACY_COVER_COPY } from './copy';
import { useType } from './fonts';
import { font, space, TITLE_MAX_SCALE, useTheme } from './theme';

export function PrivacyCover() {
  const { color } = useTheme();
  const type = useType();
  return (
    <View
      testID="privacy-cover"
      style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: color.background }]}
    >
      <Mascot mood="idle" />
      <Text
        maxFontSizeMultiplier={TITLE_MAX_SCALE}
        style={[styles.title, type.black, { color: color.text }]}
      >
        {APP_TITLE}
      </Text>
      <Text style={[styles.text, type.regular, { color: color.textMuted }]}>
        {PRIVACY_COVER_COPY.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  title: { fontSize: font.title, textAlign: 'center' },
  text: { fontSize: font.body, textAlign: 'center' },
});
