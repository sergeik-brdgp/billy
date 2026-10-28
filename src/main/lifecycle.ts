// AppState → controller bridge (background pauses timers, foreground re-verifies the
// job by key and resumes polling) and the iOS app-switcher cover rule.

export interface LifecycleTarget {
  onForeground(): Promise<void>;
  onBackground(): Promise<void>;
}

/**
 * Returns an AppState `change` handler. Only real background ↔ active transitions reach the
 * controller: iOS `inactive` (Control Center, app switcher peek, system alerts) neither pauses
 * nor triggers a by-key re-check, and repeated events of the same kind are ignored.
 */
export function createLifecycleBridge(target: LifecycleTarget): (status: string) => void {
  let inBackground = false;
  const swallow = (): void => undefined; // commands never reject by contract; stay defensive
  return (status) => {
    if (status === 'background') {
      if (inBackground) return;
      inBackground = true;
      target.onBackground().catch(swallow);
    } else if (status === 'active') {
      if (!inBackground) return;
      inBackground = false;
      target.onForeground().catch(swallow);
    }
  };
}

/** The privacy cover is up whenever the app is not the active foreground app. */
export function isCoveredState(status: string | null | undefined): boolean {
  return status === 'inactive' || status === 'background';
}
