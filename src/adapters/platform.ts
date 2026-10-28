// Platform facts the composition root needs. src/adapters is the only place
// `Platform.OS` appears; src/main passes these booleans down to the UI as props.

import { Platform } from 'react-native';

/**
 * Cover the screen while the app is `inactive` / `background` so the iOS app-switcher snapshot
 * shows no statement data. Android: no JS cover — the Activity snapshot is taken
 * before JS could react to the state change. Instead the config plugin
 * `plugins/withRecentsScreenshotDisabled.js` calls `setRecentsScreenshotEnabled(false)` (API 33+);
 * no FLAG_SECURE, which would also black out the required screen recording. API < 33: known gap.
 */
export const appSwitcherCoverEnabled: boolean = Platform.OS === 'ios';

/**
 * Announce screen changes with `AccessibilityInfo.announceForAccessibility`. iOS has
 * no live regions; Android reads the same lines through `accessibilityLiveRegion`, so announcing
 * there as well would read everything twice.
 */
export const explicitAnnouncements: boolean = Platform.OS === 'ios';
