// Micro-interactions on the built-in Animated API (no native module, no rebuild). Every helper
// honours the system "Reduce Motion" setting: with it on, values jump straight to their end state.
// Motion here is decoration only: nothing is announced, hidden or gated by an animation, and the
// first render is already in its final state (no fade-in on launch or in tests).

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, useAnimatedValue } from 'react-native';

export const DURATION = { fast: 140, base: 220, slow: 420 } as const;
export const EASE_OUT = Easing.bezier(0.2, 0.8, 0.2, 1);

/** Live value of the system "Reduce Motion" setting (false until the OS answers). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** Runs `effect` whenever `key` changes, but not on the first render. */
function useOnChange(key: string, effect: () => (() => void) | void): void {
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current === key) return undefined;
    previous.current = key;
    return effect();
    // `effect` closes over fresh values on each render; only the key decides when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * Fade + 8 pt rise whenever `key` changes (a new state, a new screen section). Returns an
 * animated style for an `Animated.View`.
 */
export function useAppear(key: string, delay = 0) {
  const reduced = useReducedMotion();
  const progress = useAnimatedValue(1);
  useOnChange(key, () => {
    if (reduced) {
      progress.setValue(1);
      return undefined;
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: DURATION.base,
      delay,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  });
  return {
    opacity: progress,
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
  };
}

/** Spring "pop" from 0.6 to 1 whenever `key` changes (status icon). */
export function usePop(key: string) {
  const reduced = useReducedMotion();
  const scale = useAnimatedValue(1);
  useOnChange(key, () => {
    if (reduced) {
      scale.setValue(1);
      return undefined;
    }
    scale.setValue(0.6);
    const animation = Animated.spring(scale, {
      toValue: 1,
      friction: 5,
      tension: 160,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  });
  return { transform: [{ scale }] };
}

/** Smoothly follows a 0..1 target (progress fill, step segment). Starts at the target. */
export function useFollow(target: number) {
  const reduced = useReducedMotion();
  const value = useAnimatedValue(target);
  useEffect(() => {
    if (reduced) {
      value.setValue(target);
      return undefined;
    }
    const animation = Animated.timing(value, {
      toValue: target,
      duration: DURATION.slow,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, target, value]);
  return value;
}

/**
 * 0 → 1 repeated while `active`: forever by default (indeterminate progress, which ends with its
 * state), or `iterations` times, restarting whenever `restartKey` changes (ambient motion that
 * settles, so the screen goes idle for battery and for UI-test tools that wait for idle).
 * Static 0 with Reduce Motion.
 */
export function useLoop(active: boolean, duration = 1200, iterations = -1, restartKey = '') {
  const reduced = useReducedMotion();
  const value = useAnimatedValue(0);
  useEffect(() => {
    if (!active || reduced) {
      value.setValue(0);
      return undefined;
    }
    const animation = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      { iterations },
    );
    value.setValue(0);
    animation.start(() => value.setValue(0));
    return () => animation.stop();
  }, [active, duration, iterations, reduced, restartKey, value]);
  return value;
}

/**
 * Chunky press feedback: the face sinks by `depth` onto its lip (0 → 1 while pressed). Returns
 * the 0..1 value and the handlers; with Reduce Motion the state still changes, just instantly.
 */
export function usePress() {
  const reduced = useReducedMotion();
  const pressed = useAnimatedValue(0);
  const to = (toValue: number) => {
    if (reduced) {
      pressed.setValue(toValue);
      return;
    }
    Animated.spring(pressed, {
      toValue,
      friction: 6,
      tension: 400,
      useNativeDriver: true,
    }).start();
  };
  return {
    pressed,
    onPressIn: () => to(1),
    onPressOut: () => to(0),
  };
}
