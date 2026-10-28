// App configuration from build-time env: the mock base URL and the diagnostics switch.
//
// `EXPO_PUBLIC_*` values are inlined into the JS bundle by Metro, and only when read as
// `process.env.EXPO_PUBLIC_NAME` literally — so `readAppConfig` reads them that way and hands the
// strings to the pure, tested `resolveConfig`.

import { err, ok, type Result } from '../core';

/** Same address on both platforms: iOS simulator shares the host loopback; Android uses `adb reverse`. */
export const DEFAULT_MOCK_URL = 'http://127.0.0.1:8787';

export interface AppConfig {
  /** Origin of the mock without a trailing slash, e.g. `http://127.0.0.1:8787`. */
  readonly baseUrl: string;
  /** Dev diagnostics panel: `__DEV__` or `EXPO_PUBLIC_DIAGNOSTICS=1`. */
  readonly diagnosticsEnabled: boolean;
}

export type ConfigError = 'invalid_base_url';

export interface ConfigInput {
  readonly mockUrl: string | undefined;
  readonly diagnostics: string | undefined;
  readonly isDev: boolean;
}

// scheme://host[:port][/] — an origin only: no credentials, path, query or fragment (the core
// appends `/imports…` itself). Host: DNS name / IPv4, or a bracketed IPv6 literal.
const ORIGIN_RE =
  /^(https?):\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?\/?$/;

/** Validates a mock base URL; returns the normalised origin or null. */
export function parseBaseUrl(raw: string): string | null {
  const match = ORIGIN_RE.exec(raw.trim());
  if (match === null) return null;
  const [, scheme, host, port] = match;
  if (scheme === undefined || host === undefined) return null;
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65_535) return null;
  }
  return `${scheme}://${host}${port === undefined ? '' : `:${port}`}`;
}

export function resolveConfig(input: ConfigInput): Result<AppConfig, ConfigError> {
  // Unset → the documented default. Set but malformed (including empty) → a visible config
  // error instead of silently talking to a different server.
  const baseUrl = parseBaseUrl(input.mockUrl ?? DEFAULT_MOCK_URL);
  if (baseUrl === null) return err('invalid_base_url');
  return ok({ baseUrl, diagnosticsEnabled: input.isDev || input.diagnostics === '1' });
}

export function readAppConfig(): Result<AppConfig, ConfigError> {
  return resolveConfig({
    mockUrl: process.env.EXPO_PUBLIC_MOCK_URL,
    diagnostics: process.env.EXPO_PUBLIC_DIAGNOSTICS,
    isDev: __DEV__,
  });
}
