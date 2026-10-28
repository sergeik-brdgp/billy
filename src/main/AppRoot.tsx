// Root view: the import screen (or a neutral fallback) inside the error boundary, the iOS
// app-switcher privacy cover above everything, and the status bar. The "Details" card is a
// native modal above this view, so the cover state is also passed down for it to draw its own.

import {
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
  Nunito_900Black,
} from '@expo-google-fonts/nunito';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
  type Metrics,
} from 'react-native-safe-area-context';

import { FallbackScreen, FontsReadyProvider, ImportScreen, PrivacyCover, useTheme } from '../ui';
import type { AppServices } from './composition';
import { AppErrorBoundary } from './ErrorBoundary';
import { isCoveredState } from './lifecycle';

export interface AppRootProps {
  readonly services: AppServices;
}

const subscribeAppState = (onChange: () => void): (() => void) => {
  const subscription = AppState.addEventListener('change', onChange);
  return () => subscription.remove();
};
const noSubscription = (): (() => void) => () => undefined;
const appStateNow = (): string | null | undefined => AppState.currentState;

/**
 * iOS: true while `inactive` / `background`, so the app-switcher snapshot shows only the cover.
 * `useSyncExternalStore` re-reads `AppState.currentState` right after subscribing, so a change
 * between the first render and the subscription (RN's own corrective initial-state emit, or the
 * user leaving during cold launch) is not lost. RN updates `currentState` before listeners run.
 */
export function usePrivacyCover(enabled: boolean): boolean {
  const status = useSyncExternalStore(enabled ? subscribeAppState : noSubscription, appStateNow);
  return enabled && isCoveredState(status);
}

/** Bundled font files (no network). Keys are the family names used by src/ui/fonts.ts. */
const FONTS = { Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black };

/** `safeAreaMetrics` is for tests; the app uses the window metrics known at launch (no jump). */
export function AppRoot({
  services,
  safeAreaMetrics = initialWindowMetrics,
}: AppRootProps & { readonly safeAreaMetrics?: Metrics | null }) {
  // Text renders at once in the system font and switches to Nunito when the files are loaded
  // (a few ms, local assets). A load error just keeps the system font.
  const [fontsLoaded] = useFonts(FONTS);
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <FontsReadyProvider value={fontsLoaded}>
        <AppRootContent services={services} />
      </FontsReadyProvider>
    </SafeAreaProvider>
  );
}

function AppRootContent({ services }: AppRootProps) {
  const { color } = useTheme();
  const covered = usePrivacyCover(services.coverEnabled);
  // Edge-to-edge on both platforms: the screen starts below the status bar / Dynamic Island,
  // and the opaque root keeps scrolled content from showing through behind it.
  const { top } = useSafeAreaInsets();
  return (
    <View style={[styles.root, { backgroundColor: color.background, paddingTop: top }]}>
      <AppErrorBoundary logger={services.logger}>
        {services.kind === 'ready' ? (
          <ImportScreen
            controller={services.controller}
            pickFile={services.pickFile}
            diagnosticsEnabled={services.diagnosticsEnabled}
            covered={covered}
            announceChanges={services.announceChanges}
          />
        ) : (
          <FallbackScreen variant="config" />
        )}
      </AppErrorBoundary>
      {covered ? <PrivacyCover /> : null}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
