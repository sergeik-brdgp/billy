import { DEFAULT_MOCK_URL, parseBaseUrl, resolveConfig } from './config';

describe('mock base URL', () => {
  it('defaults to the loopback mock when EXPO_PUBLIC_MOCK_URL is unset', () => {
    const config = resolveConfig({ mockUrl: undefined, diagnostics: undefined, isDev: false });
    expect(config).toEqual({
      ok: true,
      value: { baseUrl: DEFAULT_MOCK_URL, diagnosticsEnabled: false },
    });
  });

  it.each([
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    ['  http://192.168.1.20:8787  ', 'http://192.168.1.20:8787'],
    ['https://mock.local', 'https://mock.local'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ])('accepts the origin %j', (raw, expected) => {
    expect(parseBaseUrl(raw)).toBe(expected);
  });

  it.each([
    '',
    '127.0.0.1:8787',
    'ftp://127.0.0.1:8787',
    'http://127.0.0.1:8787/imports',
    'http://127.0.0.1:8787?x=1',
    'http://user:pass@127.0.0.1:8787',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://-bad-.host',
    'http:// 127.0.0.1',
  ])('rejects %j', (raw) => {
    expect(parseBaseUrl(raw)).toBeNull();
    expect(resolveConfig({ mockUrl: raw, diagnostics: undefined, isDev: true })).toEqual({
      ok: false,
      error: 'invalid_base_url',
    });
  });
});

describe('diagnostics switch', () => {
  it.each([
    [true, undefined, true],
    [false, '1', true],
    [false, 'true', false],
    [false, '0', false],
    [false, undefined, false],
  ])('isDev=%j EXPO_PUBLIC_DIAGNOSTICS=%j → %j', (isDev, diagnostics, expected) => {
    const config = resolveConfig({ mockUrl: undefined, diagnostics, isDev });
    expect(config.ok && config.value.diagnosticsEnabled).toBe(expected);
  });
});
