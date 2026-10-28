import type { LogEntry } from '../core';
import { createExpoPorts, pickStatementFile } from './index';

jest.mock('expo-file-system', () => jest.requireActual('./__tests__/fake-file-system'));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '0B5A2B7E-6F43-4A8E-9A63-1F6B1D3C2E10' }));

describe('createExpoPorts', () => {
  it('wires every port and fans sanitised log entries out to the extra sink', () => {
    const seen: LogEntry[] = [];
    const ports = createExpoPorts({ logSink: (entry) => seen.push(entry) });
    expect(Object.keys(ports).sort()).toEqual([
      'clock',
      'files',
      'http',
      'ids',
      'logger',
      'store',
      'upload',
    ]);
    expect(ports.ids.uuid()).toBe('0b5a2b7e-6f43-4a8e-9a63-1f6b1d3c2e10');
    ports.logger.log({ event: 'sweep_done', name: 'secret.csv' } as never);
    expect(seen).toEqual([{ event: 'sweep_done' }]);
    expect(typeof pickStatementFile).toBe('function');
  });

  it('clock delegates to the platform timers', () => {
    jest.useFakeTimers();
    try {
      const { clock } = createExpoPorts();
      const fired = jest.fn();
      const handle = clock.setTimeout(fired, 100);
      clock.clearTimeout(handle);
      clock.setTimeout(fired, 100);
      jest.advanceTimersByTime(100);
      expect(fired).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
