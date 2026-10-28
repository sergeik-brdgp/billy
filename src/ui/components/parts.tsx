// Small presentational pieces of the import screen. Nothing here has a fixed height that holds
// text: everything grows with the system font size. Layout switches from side-by-side to stacked
// at large font scales (`useWindowDimensions().fontScale`), so nothing gets squeezed.

import { useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useType } from '../fonts';
import { useFollow, useLoop } from '../motion';
import { LIP, font, radius, space, useTheme, type Mood, type Tone } from '../theme';
import type { Fact, ProgressModel, ScreenModel } from '../viewModel';

/** Above this font scale, side-by-side layouts stack. */
export const STACK_FONT_SCALE = 1.35;

export function useStacked(): boolean {
  return useWindowDimensions().fontScale > STACK_FONT_SCALE;
}

/** A thick rounded bar with a highlight stripe; `fraction` animates. Decorative only. */
function ChunkyBar({
  fraction,
  fill,
  height,
}: {
  readonly fraction: number;
  readonly fill: string;
  readonly height: number;
}) {
  const { color } = useTheme();
  const value = useFollow(Math.max(0, Math.min(1, fraction)));
  const [width, setWidth] = useState(0);
  const translateX = value.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] });
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.bar, { height, borderRadius: height / 2, backgroundColor: color.track }]}
    >
      <Animated.View
        style={[
          styles.barFill,
          { borderRadius: height / 2, backgroundColor: fill, transform: [{ translateX }] },
        ]}
      >
        <View
          style={[
            styles.shine,
            {
              top: height * 0.22,
              height: Math.max(3, height * 0.26),
              backgroundColor: color.shine,
            },
          ]}
        />
      </Animated.View>
    </View>
  );
}

/** Mascot mood for a screen state: decoration that mirrors the tone already said in text. */
export function moodFor(model: ScreenModel): Mood {
  if (model.tone === 'success') return 'happy';
  if (model.tone === 'danger' || model.tone === 'warning') return 'worried';
  if (model.tone === 'progress') return 'busy';
  return 'idle';
}

export function Badge({ text, tone }: { readonly text: string; readonly tone: Tone }) {
  const { color } = useTheme();
  const type = useType();
  return (
    <View style={[styles.badge, { backgroundColor: color.toneSurface[tone] }]}>
      <Text style={[styles.small, type.heavy, { color: color.tone[tone] }]}>{text}</Text>
    </View>
  );
}

export function NoticeBox({ text, tone }: { readonly text: string; readonly tone: Tone }) {
  const { color } = useTheme();
  const type = useType();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.card,
        styles.notice,
        { backgroundColor: color.toneSurface[tone], borderColor: color.toneBorder[tone] },
      ]}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.noticeMark, { backgroundColor: color.surface }]}
      >
        <View style={[styles.markBar, { backgroundColor: color.tone[tone] }]} />
        <View style={[styles.markDot, { backgroundColor: color.tone[tone] }]} />
      </View>
      <Text style={[styles.body, type.bold, styles.flexText, { color: color.text }]}>{text}</Text>
    </View>
  );
}

/** Format tile («PDF» / «CSV») when a fact names one. */
function formatIn(facts: readonly Fact[]): 'PDF' | 'CSV' | null {
  for (const fact of facts) {
    const match = /\b(PDF|CSV)\b/.exec(fact.value);
    if (match !== null) return match[1] as 'PDF' | 'CSV';
  }
  return null;
}

export function Facts({ facts }: { readonly facts: readonly Fact[] }) {
  const { color } = useTheme();
  const type = useType();
  const stacked = useStacked();
  if (facts.length === 0) return null;
  const format = formatIn(facts);
  const tone: Tone = format === 'PDF' ? 'danger' : 'success';
  return (
    <ChunkyCard>
      <View style={[styles.factsRow, stacked && styles.column]}>
        {format !== null ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.fileTile,
              {
                backgroundColor: color.toneSurface[tone],
                borderBottomColor: color.toneBorder[tone],
              },
            ]}
          >
            <Text style={[styles.small, type.black, { color: color.tone[tone] }]}>{format}</Text>
          </View>
        ) : null}
        <View style={styles.factsList}>
          {facts
            .filter((fact) => fact.short !== true)
            .map((fact) => (
              <FactLine key={fact.label} fact={fact} />
            ))}
        </View>
      </View>
      {/* Short values (size · format) share one row under the name; stacked at large fonts. */}
      {facts.some((fact) => fact.short === true) ? (
        <View
          style={[styles.shortRow, stacked && styles.column, { borderTopColor: color.hairline }]}
        >
          {facts
            .filter((fact) => fact.short === true)
            .map((fact) => (
              <View key={fact.label} style={styles.shortCell}>
                <FactLine fact={fact} />
              </View>
            ))}
        </View>
      ) : null}
    </ChunkyCard>
  );
}

function FactLine({ fact }: { readonly fact: Fact }) {
  const { color } = useTheme();
  const type = useType();
  return (
    <View style={styles.fact}>
      <Text style={[styles.caption, type.heavy, { color: color.textMuted }]}>{fact.label}</Text>
      <Text selectable style={[styles.body, type.heavy, { color: color.text }]}>
        {fact.value}
      </Text>
    </View>
  );
}

export function ProgressBar({ progress }: { readonly progress: ProgressModel }) {
  const { color } = useTheme();
  const type = useType();
  const percent = progress.fraction === null ? null : Math.round(progress.fraction * 100);
  return (
    <ChunkyCard>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={progress.text ?? undefined}
        accessibilityValue={percent === null ? undefined : { min: 0, max: 100, now: percent }}
        style={styles.progress}
      >
        {progress.text !== null ? (
          <Text style={[styles.body, type.heavy, { color: color.text }]}>{progress.text}</Text>
        ) : null}
        {percent === null ? (
          <IndeterminateBar />
        ) : (
          <ChunkyBar fraction={percent / 100} fill={color.primary} height={22} />
        )}
      </View>
    </ChunkyCard>
  );
}

/** Unknown total: a block slides along the track (static with Reduce Motion). */
function IndeterminateBar() {
  const { color } = useTheme();
  const loop = useLoop(true, 1100);
  const [width, setWidth] = useState(0);
  const translateX = loop.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.4, width] });
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.bar, { height: 22, borderRadius: 11, backgroundColor: color.track }]}
    >
      <Animated.View
        style={[styles.slider, { backgroundColor: color.primary, transform: [{ translateX }] }]}
      />
    </View>
  );
}

/** White card with a 2-pt outline and a 4-pt lip. */
export function ChunkyCard({
  children,
  tone,
  testID,
}: {
  readonly children: ReactNode;
  readonly tone?: Tone;
  readonly testID?: string;
}) {
  const { color } = useTheme();
  const background = tone === undefined ? color.surface : color.toneSurface[tone];
  const outline = tone === undefined ? color.border : color.toneBorder[tone];
  return (
    <View
      testID={testID}
      style={[styles.card, { backgroundColor: background, borderColor: outline }]}
    >
      {children}
    </View>
  );
}

export function Section({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const { color } = useTheme();
  const type = useType();
  return (
    <ChunkyCard>
      {title !== undefined ? (
        <Text
          accessibilityRole="header"
          style={[styles.subtitle, type.black, { color: color.text }]}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </ChunkyCard>
  );
}

export const textStyles = StyleSheet.create({
  // No lineHeight: a fixed line height could clip glyphs at the largest accessibility sizes.
  body: { fontSize: font.body },
  small: { fontSize: font.small },
  caption: { fontSize: font.caption },
  strong: { fontWeight: '600' },
});

const styles = StyleSheet.create({
  bar: { overflow: 'hidden' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, right: 0 },
  shine: { position: 'absolute', left: 8, right: 8, borderRadius: 3 },
  slider: { position: 'absolute', top: 0, bottom: 0, width: '40%', borderRadius: 11 },
  // Decorative tail: a rotated square showing two of its outlined edges.
  card: {
    borderWidth: 2,
    borderBottomWidth: 2 + LIP.card,
    borderRadius: radius.xl,
    padding: space.lg,
    gap: space.md,
  },
  notice: { flexDirection: 'row', alignItems: 'flex-start' },
  noticeMark: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  markBar: { width: 4, height: 11, borderRadius: 2 },
  markDot: { width: 4, height: 4, borderRadius: 2 },
  flexText: { flex: 1 },
  subtitle: { fontSize: font.body },
  body: textStyles.body,
  small: textStyles.small,
  caption: textStyles.caption,
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  factsRow: { flexDirection: 'row', alignItems: 'center', gap: space.md + 2 },
  column: { flexDirection: 'column', alignItems: 'flex-start' },
  factsList: { flexGrow: 1, flexShrink: 1, gap: space.sm },
  fact: { gap: 2 },
  shortRow: { flexDirection: 'row', gap: space.md, borderTopWidth: 1, paddingTop: space.md },
  shortCell: { flex: 1 },
  fileTile: {
    minWidth: 56,
    paddingHorizontal: space.sm,
    paddingVertical: space.lg,
    borderRadius: radius.md,
    borderBottomWidth: 4,
    alignItems: 'center',
  },
  progress: { gap: space.md },
});
