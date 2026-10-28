// Small token theme: light / dark palettes with WCAG AA contrast for body text
// (≥ 4.5:1 on `background` and `surface`), spacing and type scale. No fixed heights anywhere:
// sizes below are minimums or paddings so the layout grows with the system font size.

import { useColorScheme } from 'react-native';

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
export type Mood = 'idle' | 'busy' | 'happy' | 'worried';

export interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly surfaceMuted: string;
  /** Card outline and the 3D "lip" under cards and outlined buttons. */
  readonly border: string;
  /** Row separators inside a card. */
  readonly hairline: string;
  readonly text: string;
  readonly textMuted: string;
  readonly primary: string;
  /** Darker edge under a filled primary button (the pressable "lip"). */
  readonly primaryLip: string;
  readonly onPrimary: string;
  readonly primarySoft: string;
  readonly onPrimarySoft: string;
  readonly danger: string;
  readonly dangerLip: string;
  readonly onDanger: string;
  readonly dangerSoft: string;
  readonly onDangerSoft: string;
  readonly disabled: string;
  readonly onDisabled: string;
  readonly track: string;
  readonly tone: Readonly<Record<Tone, string>>;
  readonly toneSurface: Readonly<Record<Tone, string>>;
  /** Outline of a tone-coloured bubble / notice. */
  readonly toneBorder: Readonly<Record<Tone, string>>;
  /** Merchant avatars in the report: fill and letter, picked by index. */
  readonly avatarSurface: readonly string[];
  readonly avatarText: readonly string[];
  /** Billy, the mascot (decorative): paper, shade and corner per mood; face ink; cheeks. */
  readonly mascot: Readonly<Record<Mood, readonly [string, string, string]>>;
  readonly mascotInk: string;
  readonly mascotCheek: string;
  readonly mascotGlint: string;
  /** Celebration confetti (decorative). */
  readonly confetti: readonly string[];
  /** Highlight stripe on progress fills (the "shine"). */
  readonly shine: string;
}

export interface Theme {
  readonly dark: boolean;
  readonly color: Palette;
}

const mascot: Palette['mascot'] = {
  idle: ['#F2F0FF', '#DCD6FF', '#C9C1FF'],
  busy: ['#F2F0FF', '#DCD6FF', '#C9C1FF'],
  happy: ['#EAF8E2', '#C9EDB8', '#A9E08F'],
  worried: ['#FFF0F0', '#FFD3D3', '#FFB3B3'],
};
const confetti = ['#FFC531', '#5B4CF5', '#58C33B', '#FF8FA3', '#7CC8FF'];

const light: Palette = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceMuted: '#F7F7FA',
  border: '#E5E5EA',
  hairline: '#EFEFF3',
  text: '#1F2433',
  textMuted: '#5E6578',
  primary: '#5B4CF5',
  primaryLip: '#4335D1',
  onPrimary: '#FFFFFF',
  primarySoft: '#F2F0FF',
  onPrimarySoft: '#4335D1',
  danger: '#CC2F36',
  dangerLip: '#A3232A',
  onDanger: '#FFFFFF',
  dangerSoft: '#FFF0F0',
  onDangerSoft: '#B4252B',
  disabled: '#E5E5EA',
  onDisabled: '#5E6578',
  track: '#E5E5EA',
  tone: {
    neutral: '#5E6578',
    progress: '#4335D1',
    success: '#0F7535',
    warning: '#8A5A00',
    danger: '#B4252B',
  },
  toneSurface: {
    neutral: '#F7F7FA',
    progress: '#F2F0FF',
    success: '#E4F7E8',
    warning: '#FFF6D9',
    danger: '#FFF0F0',
  },
  toneBorder: {
    neutral: '#E5E5EA',
    progress: '#DCD6FF',
    success: '#B9E6C4',
    warning: '#FFE39A',
    danger: '#FFD3D3',
  },
  avatarSurface: ['#EDE7FB', '#E1F1F6', '#FFF6D9', '#E4F7E8'],
  avatarText: ['#5B34C2', '#0F6A85', '#8A5A00', '#0F7535'],
  mascot,
  mascotInk: '#1F2433',
  mascotCheek: '#FFB8C6',
  mascotGlint: '#FFFFFF',
  confetti,
  shine: '#FFFFFF59',
};

const dark: Palette = {
  background: '#10151F',
  surface: '#182030',
  surfaceMuted: '#1E2738',
  border: '#2A3346',
  hairline: '#232C3D',
  text: '#F1F3F8',
  textMuted: '#A9B1C2',
  primary: '#8F84FF',
  primaryLip: '#6A5EE0',
  onPrimary: '#10152A',
  primarySoft: '#262150',
  onPrimarySoft: '#C3BDFF',
  danger: '#FF8A8A',
  dangerLip: '#D9605F',
  onDanger: '#3A0905',
  dangerSoft: '#3A1D1F',
  onDangerSoft: '#FFB4AD',
  disabled: '#2A3346',
  onDisabled: '#A9B1C2',
  track: '#2A3346',
  tone: {
    neutral: '#A9B1C2',
    progress: '#B3ABFF',
    success: '#6FD49A',
    warning: '#FFD76B',
    danger: '#FF9A92',
  },
  toneSurface: {
    neutral: '#1E2738',
    progress: '#262150',
    success: '#163126',
    warning: '#3A2F0B',
    danger: '#3A1D1F',
  },
  toneBorder: {
    neutral: '#2A3346',
    progress: '#3A3270',
    success: '#24503A',
    warning: '#5A4812',
    danger: '#5A2A2C',
  },
  avatarSurface: ['#2A2147', '#12303A', '#3A2F0B', '#163126'],
  avatarText: ['#C9B5FF', '#8FD6EA', '#FFD76B', '#6FD49A'],
  mascot,
  mascotInk: '#1F2433',
  mascotCheek: '#FFB8C6',
  mascotGlint: '#FFFFFF',
  confetti,
  shine: '#FFFFFF33',
};

export const lightTheme: Theme = { dark: false, color: light };
export const darkTheme: Theme = { dark: true, color: dark };

/** Height of the pressable "lip" under chunky buttons and cards. */
export const LIP = { button: 4, card: 4 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 16, xl: 22, pill: 999 } as const;
/** Font sizes scale with the system setting (allowFontScaling stays on everywhere). */
export const font = {
  caption: 13,
  small: 15,
  body: 17,
  title: 21,
  heading: 28,
  display: 40,
} as const;
/**
 * Titles (`font.title` / `font.heading`) stop growing at 1.5×, like a navigation-bar title.
 * Without it the largest iOS accessibility size (AX5, ×3.57) splits a word mid-way on a 375-pt
 * screen; RN has no hyphenation on iOS. At 1.5× the longest title word («misconfigured») still
 * fits a 360-pt width (static test). Body text, buttons and report data scale uncapped.
 */
export const TITLE_MAX_SCALE = 1.5;
/**
 * Big amounts (`font.display`: the monthly total, the receipt amount) stop at 1.75× (70 pt): at
 * AX5 an uncapped 40-pt number broke mid-value («151.» / «99»). 70 pt is still larger than body
 * text at AX5 (~61 pt), so the amount stays the most prominent thing on screen.
 */
export const DISPLAY_MAX_SCALE = 1.75;
/** Minimum touch target for buttons (≥ 44 pt iOS HIG, 48 dp Material). */
export const MIN_TOUCH = 48;

export function themeFor(scheme: string | null | undefined): Theme {
  return scheme === 'dark' ? darkTheme : lightTheme;
}

export function useTheme(): Theme {
  return themeFor(useColorScheme());
}
