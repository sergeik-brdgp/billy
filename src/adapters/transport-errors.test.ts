import {
  classifyFetchFailure,
  classifyUploadFailure,
  headersAreValid,
  type FailureFacts,
} from './transport-errors';

const native = (code: string, message: string) => Object.assign(new Error(message), { code });
const inFlight = (error: unknown, extra: Partial<FailureFacts> = {}): FailureFacts => ({
  stage: 'in_flight',
  timedOut: false,
  callerAborted: false,
  bytesSent: 0,
  error,
  ...extra,
});

describe('classifyUploadFailure', () => {
  const cancelled = native('ERR_UPLOAD_CANCELLED', 'Upload was cancelled');

  it.each([
    // [description, facts, cause, code]
    [
      'set-up threw before the native start',
      { stage: 'before_start' as const },
      'not_sent',
      'setup_failed',
    ],
    [
      'private copy missing at set-up',
      { stage: 'before_start' as const, error: { code: 'file_missing' } },
      'not_sent',
      'file_missing',
    ],
    [
      'our deadline fired',
      { timedOut: true, error: cancelled, bytesSent: 10 },
      'timeout',
      'deadline',
    ],
    [
      'user cancel after progress',
      { callerAborted: true, error: cancelled, bytesSent: 512 },
      'reset_after_send',
      'cancelled',
    ],
  ] as const)('%s', (_name, extra, cause, code) => {
    expect(classifyUploadFailure(inFlight(cancelled, extra))).toEqual({ cause, code });
  });

  it('user cancel before any progress event is still an unknown outcome (bytes may be in the socket)', () => {
    // Cancel: "while sending → abort → outcome_unknown{reset_after_send, abandon}".
    // The core then looks the key up and only cancels after the settle re-checks.
    expect(
      classifyUploadFailure(inFlight(cancelled, { callerAborted: true, bytesSent: 0 })),
    ).toEqual({
      cause: 'reset_after_send',
      code: 'cancelled',
    });
  });

  it('an abort before the native start is not_sent (the core cancels without a lookup)', () => {
    expect(
      classifyUploadFailure({
        stage: 'before_start',
        timedOut: false,
        callerAborted: true,
        bytesSent: 0,
        error: { name: 'AbortError' },
      }),
    ).toEqual({ cause: 'not_sent', code: 'aborted_before_start' });
  });

  it('a system cancel we did not ask for is an unknown outcome', () => {
    expect(classifyUploadFailure(inFlight(cancelled, { bytesSent: 0 }))).toEqual({
      cause: 'reset_after_send',
      code: 'cancelled_by_system',
    });
  });

  it.each([
    [
      'Android: illegal header char (IllegalArgumentException)',
      native('ERR_UNEXPECTED', 'Unexpected char 0x0a at 3 in X-File-Name value'),
      'not_sent',
      'rejected_before_send',
    ],
    [
      'Android: permission check',
      native('ERR_INVALID_PERMISSION', 'Missing READ permission'),
      'not_sent',
      'rejected_before_send',
    ],
    [
      'Android: file vanished',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: File does not exist'),
      'not_sent',
      'file_missing',
    ],
    [
      'iOS: task not created',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: Failed to create upload task'),
      'not_sent',
      'setup_failed',
    ],
    [
      'Android: connection refused',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: Failed to connect to /127.0.0.1:8787',
      ),
      'unreachable',
      'connect_failed',
    ],
    [
      'Android: DNS',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: Unable to resolve host "mock": No address associated with hostname',
      ),
      'unreachable',
      'dns',
    ],
    [
      'Android: cleartext blocked',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: CLEARTEXT communication to 10.0.2.2 not permitted by network security policy',
      ),
      'unreachable',
      'blocked_by_policy',
    ],
    [
      'iOS: -1004',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: Could not connect to the server.'),
      'unreachable',
      'connect_failed',
    ],
    [
      'iOS: -1003',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: A server with the specified hostname could not be found.',
      ),
      'unreachable',
      'dns',
    ],
    [
      'iOS: -1009',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: The Internet connection appears to be offline.',
      ),
      'unreachable',
      'offline',
    ],
    [
      'iOS: ATS',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: The resource could not be loaded because the App Transport Security policy requires the use of a secure connection.',
      ),
      'unreachable',
      'blocked_by_policy',
    ],
    [
      'iOS: -1001',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: The request timed out.'),
      'timeout',
      'native_timeout',
    ],
    [
      'Android: SocketTimeoutException',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: timeout'),
      'timeout',
      'native_timeout',
    ],
    [
      'iOS: -1005 connection lost',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: The network connection was lost.'),
      'reset_after_send',
      'connection_lost',
    ],
    [
      'Android: dropped mid-body',
      native(
        'ERR_UNABLE_TO_UPLOAD',
        'Unable to upload a file: unexpected end of stream on http://127.0.0.1:8787/...',
      ),
      'reset_after_send',
      'connection_lost',
    ],
    [
      'Android: broken pipe',
      native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: Broken pipe'),
      'reset_after_send',
      'connection_lost',
    ],
    ['anything unknown', new Error('???'), 'reset_after_send', 'connection_lost'],
    ['a non-error value', 42, 'reset_after_send', 'connection_lost'],
  ] as const)('%s', (_name, error, cause, code) => {
    expect(classifyUploadFailure(inFlight(error))).toEqual({ cause, code });
  });

  it('never claims unreachable once progress was reported', () => {
    const refused = native('ERR_UNABLE_TO_UPLOAD', 'Unable to upload a file: Connection refused');
    expect(classifyUploadFailure(inFlight(refused, { bytesSent: 1 })).cause).toBe(
      'reset_after_send',
    );
  });

  it('never copies the native message into the error', () => {
    const leaky = native(
      'ERR_UNABLE_TO_UPLOAD',
      'Unable to upload a file: secret-name.pdf file:///x',
    );
    expect(JSON.stringify(classifyUploadFailure(inFlight(leaky)))).not.toMatch(/secret|file:/);
  });
});

describe('classifyFetchFailure', () => {
  it.each([
    ['our deadline', { timedOut: true }, new Error('Aborted'), 'timeout', 'deadline'],
    [
      'caller abort',
      { callerAborted: true },
      new Error('Aborted'),
      'reset_after_send',
      'cancelled',
    ],
    ['native timeout', {}, new TypeError('Network request timed out'), 'timeout', 'native_timeout'],
    [
      'bare RN failure (no detail)',
      {},
      new TypeError('Network request failed'),
      'reset_after_send',
      'network_failed',
    ],
    [
      'invalid header',
      {},
      new TypeError('Invalid character in header field name'),
      'not_sent',
      'invalid_header',
    ],
    [
      'detailed refusal',
      {},
      new TypeError('connect ECONNREFUSED 127.0.0.1:8787'),
      'unreachable',
      'connect_failed',
    ],
  ] as const)('%s', (_name, extra, error, cause, code) => {
    expect(classifyFetchFailure(inFlight(error, extra))).toEqual({ cause, code });
  });
});

describe('headersAreValid', () => {
  it('accepts the headers the core builds', () => {
    expect(
      headersAreValid({
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': '0b5a2b7e-6f43-4a8e-9a63-1f6b1d3c2e10',
        'X-File-Name': '%D0%B2%D1%8B%D0%BF%D0%B8%D1%81%D0%BA%D0%B0.csv',
      }),
    ).toBe(true);
    expect(headersAreValid(undefined)).toBe(true);
  });

  it.each<Record<string, string>>([
    { 'X-File-Name': 'выписка.csv' },
    { 'X-File-Name': 'a\r\nInjected: 1' },
    { 'Bad Name': 'x' },
  ])('rejects %j', (headers) => expect(headersAreValid(headers)).toBe(false));
});
