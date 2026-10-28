/* global jest */
// Safe-area insets come from native code; tests use the library's own mock (top: 47, bottom: 34).
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
