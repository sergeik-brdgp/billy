// Public surface of the UI for the composition root (src/main).
//
//   <ImportScreen controller={controller} pickFile={pickStatementFile} diagnosticsEnabled={…}
//                 covered={coverVisible} announceChanges={explicitAnnouncements} />
//   {coverVisible ? <PrivacyCover /> : null}   // iOS app-switcher overlay, owned by src/main
//                                              // (`covered` lets the native details modal draw its own)
//   <FallbackScreen variant="crash" | "config" />   // error boundary / malformed mock URL
//
// src/ui never imports src/adapters or Expo file/sqlite/picker modules: everything comes in
// through these props.

export { FallbackScreen, type FallbackScreenProps } from './FallbackScreen';
export { ImportScreen, type ImportScreenProps } from './ImportScreen';
export { PrivacyCover } from './PrivacyCover';
export { darkTheme, lightTheme, themeFor, useTheme, type Theme } from './theme';
export { FontsReadyProvider } from './fonts';
