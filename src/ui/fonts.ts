// Nunito (SIL OFL, bundled via @expo-google-fonts/nunito, loaded by src/main through expo-font).
// Until the files are loaded, and in tests, text falls back to the system font with a matching
// weight: never an unknown `fontFamily`, which iOS reports as an error. System font scaling
// (Dynamic Type / font scale) applies to custom fonts exactly as to the system font.

import { createContext, useContext } from 'react';
import type { TextStyle } from 'react-native';

export const FONT_FAMILY = {
  regular: 'Nunito_600SemiBold',
  bold: 'Nunito_700Bold',
  heavy: 'Nunito_800ExtraBold',
  black: 'Nunito_900Black',
} as const;

export type TypeWeight = keyof typeof FONT_FAMILY;
export type TypeStyles = Readonly<Record<TypeWeight, TextStyle>>;

const LOADED: TypeStyles = {
  regular: { fontFamily: FONT_FAMILY.regular },
  bold: { fontFamily: FONT_FAMILY.bold },
  heavy: { fontFamily: FONT_FAMILY.heavy },
  black: { fontFamily: FONT_FAMILY.black },
};

const SYSTEM: TypeStyles = {
  regular: { fontWeight: '500' },
  bold: { fontWeight: '600' },
  heavy: { fontWeight: '700' },
  black: { fontWeight: '800' },
};

const FontsReadyContext = createContext(false);

/** Set by src/main once the font files are loaded. */
export const FontsReadyProvider = FontsReadyContext.Provider;

/** Weight styles for the current font state. */
export function useType(): TypeStyles {
  return useContext(FontsReadyContext) ? LOADED : SYSTEM;
}
