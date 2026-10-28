// ESLint flat config.
// https://docs.expo.dev/guides/using-eslint/
const { builtinModules } = require('node:module');
const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

// Files that belong to a per-folder tsconfig.json (src/, src/ui tests, tests/) get type-aware rules.
// Root files (index.ts, App.tsx, *.config.*) are linted without type information.
const TYPED_FILES = ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts'];

const CORE_BANNED_MESSAGE =
  'src/core is plain TypeScript: no react, react-native, expo or node modules (SPEC §3). ' +
  'Put platform code in src/adapters behind a port.';

const bareNodeBuiltins = builtinModules.filter(
  (name) => !name.startsWith('_') && !name.startsWith('node:'),
);

module.exports = defineConfig([
  globalIgnores([
    'mock-kit/**',
    'ios/**',
    'android/**',
    'node_modules/**',
    '.expo/**',
    'dist/**',
    'coverage/**',
  ]),
  expoConfig,
  {
    // Node-side tooling: config files, repo scripts, Expo config plugins, Node integration tests.
    files: [
      '*.config.{js,cjs,mjs,ts,mts}',
      'scripts/**/*.{js,cjs,mjs}',
      'plugins/**/*.js',
      'tests/**/*.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Logging goes through the typed allow-listed logger only.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['src/core/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: bareNodeBuiltins.map((name) => ({ name, message: CORE_BANNED_MESSAGE })),
          patterns: [
            {
              group: [
                'react',
                'react/**',
                'react-dom',
                'react-dom/**',
                'react-native',
                'react-native/**',
                'react-native-*',
                '@react-native/**',
                '@react-native-*/**',
                'expo',
                'expo/**',
                'expo-*',
                'expo-*/**',
                '@expo/**',
                'node:*',
                'node:*/**',
              ],
              message: CORE_BANNED_MESSAGE,
            },
          ],
        },
      ],
    },
  },
]);
