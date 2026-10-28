// WCAG 2.x contrast ratio of two sRGB colours (pure, no React). Used by the theme tests to prove
// the light and dark palettes keep AA: 4.5:1 for body text, 3:1 for large text and UI parts.

/** WCAG AA minimum for normal-size text. */
export const AA_TEXT = 4.5;
/** WCAG AA minimum for large text (≥ 18 pt / 14 pt bold) and non-text UI components. */
export const AA_LARGE_OR_UI = 3;

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function parseHex(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (match?.[1] === undefined) throw new Error(`expected #RRGGBB, got ${color}`);
  return match[1];
}

/** Relative luminance (0 = black … 1 = white) of a `#RRGGBB` colour. */
export function relativeLuminance(color: string): number {
  const hex = parseHex(color);
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 2) + 0.0722 * channel(hex, 4);
}

/** Contrast ratio 1…21 between two `#RRGGBB` colours (order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}
