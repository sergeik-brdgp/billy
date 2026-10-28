import { createLifecycleBridge, isCoveredState } from './lifecycle';

function target() {
  const calls: string[] = [];
  return {
    calls,
    onForeground: async () => {
      calls.push('foreground');
      await Promise.resolve();
    },
    onBackground: async () => {
      calls.push('background');
      await Promise.resolve();
    },
  };
}

describe('AppState → controller bridge', () => {
  it('pauses on background and re-verifies once on the way back', () => {
    const t = target();
    const onChange = createLifecycleBridge(t);
    for (const status of ['inactive', 'background', 'background', 'inactive', 'active', 'active']) {
      onChange(status);
    }
    expect(t.calls).toEqual(['background', 'foreground']);
  });

  it('ignores iOS inactive-only blips (Control Center, app-switcher peek)', () => {
    const t = target();
    const onChange = createLifecycleBridge(t);
    onChange('inactive');
    onChange('active');
    expect(t.calls).toEqual([]);
  });

  it('does not report foreground at launch (start() does the cold-start recovery)', () => {
    const t = target();
    createLifecycleBridge(t)('active');
    expect(t.calls).toEqual([]);
  });

  it('swallows a rejected command instead of leaving an unhandled rejection', async () => {
    const onChange = createLifecycleBridge({
      onForeground: () => Promise.reject(new Error('x')),
      onBackground: () => Promise.reject(new Error('x')),
    });
    onChange('background');
    onChange('active');
    await Promise.resolve();
  });
});

describe('privacy cover rule', () => {
  it.each([
    ['active', false],
    ['inactive', true],
    ['background', true],
    ['unknown', false],
    [null, false],
  ])('%j → %j', (status, covered) => {
    expect(isCoveredState(status)).toBe(covered);
  });
});
