// Dark mode (app.json `userInterfaceStyle: "automatic"`): the screen really draws the dark tokens
// when the system scheme is dark (useColorScheme mocked), and both palettes keep WCAG AA contrast
// for every text / UI pair the components actually use.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import appConfig from '../../app.json';
import { AA_LARGE_OR_UI, AA_TEXT, contrastRatio, relativeLuminance } from './contrast';
import { ImportScreen } from './ImportScreen';
import { PrivacyCover } from './PrivacyCover';
import { STATE_CASES } from './test-utils/cases';
import { createFakeController } from './test-utils/fakeController';
import { darkTheme, lightTheme, themeFor, type Palette, type Tone } from './theme';

let mockScheme: 'light' | 'dark' | null = 'dark';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

interface TreeNode {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
  findAll(predicate: (node: TreeNode) => boolean): TreeNode[];
}

/** Every colour value drawn by host views / texts (background, border, text colour). */
function drawnColors(): Set<string> {
  const colors = new Set<string>();
  const root = screen.root as TreeNode;
  const nodes = [root, ...root.findAll(() => true)];
  for (const node of nodes) {
    if (typeof node.type !== 'string') continue;
    const style = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle & TextStyle>) ?? {};
    for (const key of ['backgroundColor', 'color', 'borderColor', 'borderLeftColor'] as const) {
      const value = style[key];
      if (typeof value === 'string') colors.add(value.toUpperCase());
    }
    const indicator = node.props.color;
    if (typeof indicator === 'string') colors.add(indicator.toUpperCase());
  }
  return colors;
}

/** Every colour string anywhere in the palette (nested records and lists included). */
function paletteValues(palette: Palette): Set<string> {
  const values = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.add(value.toUpperCase());
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(palette);
  return values;
}

const DARK = paletteValues(darkTheme.color);
const LIGHT = paletteValues(lightTheme.color);
const LIGHT_ONLY = [...LIGHT].filter((value) => !DARK.has(value));
const DARK_ONLY = [...DARK].filter((value) => !LIGHT.has(value));

afterEach(() => {
  mockScheme = 'dark';
});

describe('dark mode is enabled and applied', () => {
  it('app.json follows the system appearance (not forced light)', () => {
    expect(appConfig.expo.userInterfaceStyle).toBe('automatic');
    expect(themeFor('dark')).toBe(darkTheme);
    expect(themeFor('light')).toBe(lightTheme);
    expect(themeFor(null)).toBe(lightTheme);
  });

  it.each(STATE_CASES)('$name: dark scheme draws only dark tokens', (state) => {
    mockScheme = 'dark';
    render(
      <ImportScreen
        controller={createFakeController(state.snapshot).controller}
        pickFile={async () => null}
        diagnosticsEnabled={false}
      />,
    );
    const root = screen.getByTestId('import-screen');
    expect(StyleSheet.flatten(root.props.style as StyleProp<ViewStyle>)?.backgroundColor).toBe(
      darkTheme.color.background,
    );
    const title = screen.getByRole('header', { name: state.title });
    expect(StyleSheet.flatten(title.props.style as StyleProp<TextStyle>)?.color).toBe(
      darkTheme.color.text,
    );
    const drawn = drawnColors();
    expect(drawn.size).toBeGreaterThan(2);
    for (const color of drawn) expect(DARK).toContain(color);
    expect([...drawn].filter((color) => LIGHT_ONLY.includes(color))).toEqual([]);
  });

  it('the same screen draws light tokens under a light scheme (the mock really drives it)', () => {
    const state = STATE_CASES.find((item) => item.name === 'outcome_unknown not found');
    if (state === undefined) throw new Error('no case');
    mockScheme = 'light';
    render(
      <ImportScreen
        controller={createFakeController(state.snapshot).controller}
        pickFile={async () => null}
        diagnosticsEnabled={false}
      />,
    );
    const drawn = drawnColors();
    for (const color of drawn) expect(LIGHT).toContain(color);
    expect([...drawn].filter((color) => DARK_ONLY.includes(color))).toEqual([]);
  });

  it('the "Подробнее" card and the open diagnostics panel draw only dark tokens', async () => {
    const state = STATE_CASES.find((item) => item.name === 'job ready');
    if (state === undefined) throw new Error('no case');
    mockScheme = 'dark';
    render(
      <ImportScreen
        controller={createFakeController(state.snapshot).controller}
        pickFile={async () => null}
        diagnosticsEnabled
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Diagnostics (dev) — show' }));
    await screen.findByTestId('diagnostics-body');
    fireEvent.press(screen.getByRole('button', { name: 'Details: StreamBeam' }));
    expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
    const drawn = drawnColors();
    expect(drawn.size).toBeGreaterThan(2);
    for (const color of drawn) expect(DARK).toContain(color);
    expect([...drawn].filter((color) => LIGHT_ONLY.includes(color))).toEqual([]);
  });

  it('the privacy cover follows the dark scheme too', () => {
    mockScheme = 'dark';
    render(<PrivacyCover />);
    const drawn = drawnColors();
    expect(drawn).toContain(darkTheme.color.background.toUpperCase());
    expect(drawn).toContain(darkTheme.color.text.toUpperCase());
    expect([...drawn].filter((color) => LIGHT_ONLY.includes(color))).toEqual([]);
  });
});

describe('contrast helper (WCAG 2.x)', () => {
  it('matches reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#3A404B', '#3A404B')).toBe(1);
    // Well-known thresholds: #767676 is the lightest grey with AA on white, #777777 just fails.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(AA_TEXT);
    expect(contrastRatio('#949494', '#FFFFFF')).toBeGreaterThanOrEqual(AA_LARGE_OR_UI);
    expect(contrastRatio('#959595', '#FFFFFF')).toBeLessThan(AA_LARGE_OR_UI);
  });

  it('rejects anything but #RRGGBB', () => {
    expect(() => relativeLuminance('#FFF')).toThrow();
    expect(() => relativeLuminance('red')).toThrow();
  });
});

const TONES: readonly Tone[] = ['neutral', 'progress', 'success', 'warning', 'danger'];

/** [label, foreground, background, minimum] for every pair the components draw. */
function pairs(c: Palette): [string, string, string, number][] {
  const out: [string, string, string, number][] = [];
  const plain = { background: c.background, surface: c.surface, surfaceMuted: c.surfaceMuted };
  // Body text: text / textMuted on every plain surface and every tone surface (status panel,
  // notice boxes, cards, diagnostics panel).
  for (const fg of ['text', 'textMuted'] as const) {
    for (const [bgName, bg] of Object.entries(plain))
      out.push([`${fg} on ${bgName}`, c[fg], bg, AA_TEXT]);
    for (const tone of TONES)
      out.push([`${fg} on toneSurface.${tone}`, c[fg], c.toneSurface[tone], AA_TEXT]);
  }
  // Outlined buttons, the «Details» link and badges: accent text on the surface / tone surface.
  out.push(['onPrimarySoft on surface', c.onPrimarySoft, c.surface, AA_TEXT]);
  out.push(['onDangerSoft on surface', c.onDangerSoft, c.surface, AA_TEXT]);
  out.push(['onPrimarySoft on primarySoft', c.onPrimarySoft, c.primarySoft, AA_TEXT]);
  out.push(['onDangerSoft on dangerSoft', c.onDangerSoft, c.dangerSoft, AA_TEXT]);
  for (const tone of TONES)
    out.push([
      `tone.${tone} text on toneSurface.${tone}`,
      c.tone[tone],
      c.toneSurface[tone],
      AA_TEXT,
    ]);
  c.avatarText.forEach((fg, index) =>
    out.push([`avatar ${index}`, fg, c.avatarSurface[index] ?? c.surface, AA_TEXT]),
  );
  // Button labels: filled, outlined (accent on surface), disabled.
  out.push(['onPrimary on primary', c.onPrimary, c.primary, AA_TEXT]);
  out.push(['onDanger on danger', c.onDanger, c.danger, AA_TEXT]);
  out.push(['onDisabled on disabled', c.onDisabled, c.disabled, AA_TEXT]);
  for (const fg of ['primary', 'danger'] as const) {
    for (const [bgName, bg] of Object.entries(plain))
      out.push([`${fg} on ${bgName}`, c[fg], bg, AA_TEXT]);
  }
  for (const tone of TONES) {
    // Badge text on the surface; accents (status bar, notice border) against their surfaces.
    out.push([`tone.${tone} on surface`, c.tone[tone], c.surface, AA_TEXT]);
    out.push([
      `tone.${tone} on toneSurface.${tone}`,
      c.tone[tone],
      c.toneSurface[tone],
      AA_LARGE_OR_UI,
    ]);
    out.push([`tone.${tone} on background`, c.tone[tone], c.background, AA_LARGE_OR_UI]);
  }
  // UI parts: button outlines / fills on the screen background, step + progress segments.
  out.push(['primary (UI) on background', c.primary, c.background, AA_LARGE_OR_UI]);
  out.push(['danger (UI) on background', c.danger, c.background, AA_LARGE_OR_UI]);
  out.push(['primary vs track (progress / steps)', c.primary, c.track, AA_LARGE_OR_UI]);
  return out;
}

describe.each([
  ['dark', darkTheme.color],
  ['light', lightTheme.color],
] as const)('%s palette meets WCAG AA', (_name, palette) => {
  it.each(pairs(palette))('%s', (_label, fg, bg, minimum) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(minimum);
  });
});
