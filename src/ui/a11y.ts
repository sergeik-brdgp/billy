// Screen-reader announcements. What to say comes from the pure view model
// (`announcementFor`); this hook only remembers the previous model and speaks.
//
// iOS has no live regions, so changes are announced explicitly (`explicit = true`, decided by
// src/adapters/platform.ts and passed in by src/main). Android hears the same lines through the
// `accessibilityLiveRegion` on the status block and the notice boxes; announcing there too would
// read everything twice.

import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

import { announcementFor, type ScreenModel } from './viewModel';

type AnnounceModel = Pick<ScreenModel, 'announceKey' | 'announcement' | 'announceExtras'>;

export function useAnnouncements(model: AnnounceModel, explicit: boolean): void {
  const previous = useRef<AnnounceModel | null>(null);
  const { announceKey, announcement, announceExtras } = model;
  // Joined so the effect re-runs on content changes, not on every new array identity.
  const extrasKey = announceExtras.join('\n');
  useEffect(() => {
    const next: AnnounceModel = {
      announceKey,
      announcement,
      announceExtras: extrasKey === '' ? [] : extrasKey.split('\n'),
    };
    const message = announcementFor(previous.current, next);
    previous.current = next;
    if (explicit && message !== null) AccessibilityInfo.announceForAccessibility(message);
  }, [announceKey, announcement, extrasKey, explicit]);
}
