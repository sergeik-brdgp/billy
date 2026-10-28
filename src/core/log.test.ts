import { describe, expect, it } from 'vitest';

import { createLogger, sanitizeLogEntry, type LogEntry } from './log';

const OP = '0d2e4f6a-8b0c-4d1e-a3f5-b7c9d1e3f5a7';

describe('typed allow-listed logger (C11, R12)', () => {
  it('keeps allow-listed fields of the right shape', () => {
    expect(
      sanitizeLogEntry({
        event: 'post_finished',
        opId: OP,
        phase: 'sending',
        httpStatus: 202,
        revision: 1,
        attempt: 1,
        durationMs: 15,
        cause: 'ok',
      }),
    ).toEqual({
      event: 'post_finished',
      opId: OP,
      phase: 'sending',
      httpStatus: 202,
      revision: 1,
      attempt: 1,
      durationMs: 15,
      cause: 'ok',
    });
  });

  it('drops everything else, including smuggled names, paths and bodies', () => {
    const smuggled = {
      event: 'post_finished',
      opId: 'file:///var/mobile/Containers/Data/statement.csv',
      phase: 'Выписка.pdf',
      cause: 'StreamBeam',
      httpStatus: 'x',
      fileName: 'statement.csv',
      uri: 'content://downloads/1',
      body: 'date,description,amount',
      message: 'anything',
    };
    expect(sanitizeLogEntry(smuggled)).toEqual({ event: 'post_finished' });
  });

  it('unknown events are dropped entirely', () => {
    expect(sanitizeLogEntry({ event: 'free text with statement.csv' })).toBeNull();
    expect(sanitizeLogEntry(null)).toBeNull();
    expect(sanitizeLogEntry('post_finished')).toBeNull();
  });

  it('createLogger sanitises before the sink and survives a throwing sink', () => {
    const seen: LogEntry[] = [];
    const logger = createLogger((entry) => seen.push(entry));
    logger.log({ event: 'sweep_done', ...({ path: '/x/y' } as object) } as LogEntry);
    expect(seen).toEqual([{ event: 'sweep_done' }]);
    const throwing = createLogger(() => {
      throw new Error('sink down');
    });
    expect(() => throwing.log({ event: 'sweep_done' })).not.toThrow();
  });
});
