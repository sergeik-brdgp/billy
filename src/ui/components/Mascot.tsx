// Billy, the statement mascot: a sheet of paper with a face, drawn from plain Views (no images, no
// native modules). Purely decorative: hidden from screen readers, never the only carrier of
// meaning (the status text next to it says everything). Moods follow the screen state.
// Motion: gentle breathing, a blink every few seconds, a hop on every mood change and a confetti
// burst when the mood turns happy. With Reduce Motion all of it is off.

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useAnimatedValue, View } from 'react-native';

import { useLoop, usePop, useReducedMotion } from '../motion';
import { useTheme, type Mood } from '../theme';

const WIDTH = 120;
const HEIGHT = 132;

export function Mascot({ mood, scale = 1 }: { readonly mood: Mood; readonly scale?: number }) {
  const { color } = useTheme();
  const reduced = useReducedMotion();
  // Ambient motion settles: three breaths and two blinks after each mood change, then still.
  const breath = useLoop(true, 2600, 3, mood);
  const hop = usePop(mood);
  const blink = useBlink(mood !== 'happy' && !reduced, mood);
  const [paper, shade, corner] = color.mascot[mood];
  const ink = color.mascotInk;
  const bob = breath.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -3, 0] });

  return (
    <View
      testID="mascot"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: WIDTH * scale, height: HEIGHT * scale }}
    >
      {/* Scaled from the top-left corner so the drawing fills the scaled box exactly (the default
          centre origin would shift it down and right, out of the box). */}
      <View style={[styles.canvas, { transform: [{ scale }], transformOrigin: 'top left' }]}>
        <View style={[styles.shadow, { backgroundColor: color.border }]} />
        <Animated.View
          style={[styles.canvas, { transform: [{ translateY: bob }, ...hop.transform] }]}
        >
          <View style={[styles.body, { backgroundColor: paper, borderBottomColor: shade }]} />
          <View style={[styles.corner, { backgroundColor: corner }]} />
          <View style={[styles.line, styles.line1, { backgroundColor: corner }]} />
          <View style={[styles.line, styles.line2, { backgroundColor: corner }]} />

          {mood === 'happy' ? (
            <>
              <View style={[styles.arcEye, { left: 35, borderColor: ink }]} />
              <View style={[styles.arcEye, { left: 68, borderColor: ink }]} />
            </>
          ) : (
            <Animated.View style={[styles.canvas, { transform: [{ scaleY: blink }] }]}>
              <Eye left={37} ink={ink} glint={color.mascotGlint} lookUp={mood === 'busy'} />
              <Eye left={70} ink={ink} glint={color.mascotGlint} lookUp={mood === 'busy'} />
            </Animated.View>
          )}
          {mood === 'worried' ? (
            <>
              <View style={[styles.brow, { left: 34, backgroundColor: ink }, styles.browLeft]} />
              <View style={[styles.brow, { left: 70, backgroundColor: ink }, styles.browRight]} />
              <View style={[styles.drop, { backgroundColor: color.confetti[4] }]} />
            </>
          ) : null}

          <View style={[styles.cheek, { left: 25, backgroundColor: color.mascotCheek }]} />
          <View style={[styles.cheek, { left: 82, backgroundColor: color.mascotCheek }]} />

          {mood === 'idle' ? <View style={[styles.smile, { borderColor: ink }]} /> : null}
          {mood === 'happy' ? (
            <View style={[styles.grin, { backgroundColor: ink }]}>
              <View style={[styles.tongue, { backgroundColor: color.confetti[3] }]} />
            </View>
          ) : null}
          {mood === 'busy' ? (
            <>
              <View style={[styles.ooh, { borderColor: ink }]} />
              <View
                style={[styles.speed, { top: 46, left: 0, width: 10, backgroundColor: corner }]}
              />
              <View
                style={[styles.speed, { top: 58, left: -4, width: 14, backgroundColor: corner }]}
              />
              <View
                style={[styles.speed, { top: 70, left: 0, width: 10, backgroundColor: corner }]}
              />
            </>
          ) : null}
          {mood === 'worried' ? <View style={[styles.frown, { borderColor: ink }]} /> : null}
        </Animated.View>
        <Confetti mood={mood} colors={color.confetti} />
      </View>
    </View>
  );
}

function Eye({
  left,
  ink,
  glint,
  lookUp,
}: {
  readonly left: number;
  readonly ink: string;
  readonly glint: string;
  readonly lookUp: boolean;
}) {
  return (
    <View style={[styles.eye, { left, backgroundColor: ink }]}>
      <View
        style={[
          styles.glint,
          { backgroundColor: glint, left: lookUp ? 7 : 6, top: lookUp ? 2 : 3 },
        ]}
      />
    </View>
  );
}

/** Eyes close for ~80 ms, twice, ~2.4 s apart, after each mood change. scaleY (1 = open). */
function useBlink(active: boolean, restartKey: string) {
  const value = useAnimatedValue(1);
  useEffect(() => {
    if (!active) {
      value.setValue(1);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(2400),
        Animated.timing(value, { toValue: 0.1, duration: 80, useNativeDriver: true }),
        Animated.timing(value, { toValue: 1, duration: 120, useNativeDriver: true }),
      ]),
      { iterations: 2 },
    );
    value.setValue(1);
    animation.start(() => value.setValue(1));
    return () => animation.stop();
  }, [active, restartKey, value]);
  return value;
}

const PARTICLES = [
  { dx: -58, dy: -40, rotate: '-30deg', round: false },
  { dx: -30, dy: -64, rotate: '20deg', round: true },
  { dx: 4, dy: -74, rotate: '45deg', round: false },
  { dx: 36, dy: -62, rotate: '-15deg', round: true },
  { dx: 60, dy: -36, rotate: '60deg', round: false },
  { dx: -64, dy: 4, rotate: '10deg', round: true },
  { dx: 64, dy: 6, rotate: '-50deg', round: false },
  { dx: -40, dy: 30, rotate: '35deg', round: true },
] as const;

/**
 * A one-off burst of confetti when the mood becomes happy (not on first render). The particles
 * exist only while the burst runs: at rest nothing is drawn, whatever the animation driver does.
 */
function Confetti({ mood, colors }: { readonly mood: Mood; readonly colors: readonly string[] }) {
  const reduced = useReducedMotion();
  const progress = useAnimatedValue(0);
  const previous = useRef(mood);
  const [bursting, setBursting] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = mood;
    if (mood !== 'happy' || was === 'happy' || reduced) return undefined;
    progress.setValue(0);
    setBursting(true);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(() => setBursting(false));
    return () => animation.stop();
  }, [mood, progress, reduced]);
  if (!bursting) return null;
  const opacity = progress.interpolate({ inputRange: [0, 0.1, 0.7, 1], outputRange: [0, 1, 1, 0] });
  return (
    <>
      {PARTICLES.map((particle, index) => (
        <Animated.View
          key={index}
          style={[
            particle.round ? styles.dot : styles.chip,
            {
              backgroundColor: colors[index % colors.length],
              opacity,
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, particle.dx],
                  }),
                },
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, particle.dy],
                  }),
                },
                { rotate: particle.rotate },
              ],
            },
          ]}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  canvas: { position: 'absolute', left: 0, top: 0, width: WIDTH, height: HEIGHT },
  shadow: {
    position: 'absolute',
    left: 25,
    bottom: 2,
    width: 70,
    height: 10,
    borderRadius: 35,
    opacity: 0.8,
  },
  body: {
    position: 'absolute',
    left: 14,
    top: 8,
    width: 92,
    height: 110,
    borderRadius: 24,
    borderBottomWidth: 7,
  },
  corner: {
    position: 'absolute',
    right: 14,
    top: 8,
    width: 28,
    height: 28,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 14,
  },
  line: { position: 'absolute', left: 32, height: 6, borderRadius: 3 },
  line1: { top: 90, width: 56 },
  line2: { top: 100, width: 34 },
  eye: { position: 'absolute', top: 38, width: 13, height: 18, borderRadius: 7 },
  glint: { position: 'absolute', width: 5, height: 5, borderRadius: 3 },
  arcEye: {
    position: 'absolute',
    top: 42,
    width: 17,
    height: 10,
    borderWidth: 4,
    borderBottomWidth: 0,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  brow: { position: 'absolute', top: 29, width: 16, height: 4, borderRadius: 2 },
  browLeft: { transform: [{ rotate: '-14deg' }] },
  browRight: { transform: [{ rotate: '14deg' }] },
  drop: { position: 'absolute', left: 92, top: 28, width: 9, height: 13, borderRadius: 5 },
  cheek: { position: 'absolute', top: 60, width: 13, height: 8, borderRadius: 6 },
  smile: {
    position: 'absolute',
    left: 51,
    top: 62,
    width: 18,
    height: 9,
    borderWidth: 4,
    borderTopWidth: 0,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
  },
  grin: {
    position: 'absolute',
    left: 48,
    top: 60,
    width: 24,
    height: 14,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    overflow: 'hidden',
  },
  tongue: { position: 'absolute', left: 6, top: 7, width: 12, height: 9, borderRadius: 6 },
  ooh: {
    position: 'absolute',
    left: 54,
    top: 61,
    width: 12,
    height: 12,
    borderWidth: 4,
    borderRadius: 6,
  },
  frown: {
    position: 'absolute',
    left: 51,
    top: 64,
    width: 18,
    height: 9,
    borderWidth: 4,
    borderBottomWidth: 0,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  speed: { position: 'absolute', height: 4, borderRadius: 2 },
  chip: { position: 'absolute', left: 56, top: 50, width: 8, height: 14, borderRadius: 2 },
  dot: { position: 'absolute', left: 56, top: 54, width: 9, height: 9, borderRadius: 5 },
});
