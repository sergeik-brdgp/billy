import { createLogger } from '../core';
import { createDevConsoleSink, formatLogLine } from './logger';

describe('dev console sink', () => {
  afterEach(() => jest.restoreAllMocks());

  it('formats one compact line from allow-listed fields only', () => {
    expect(
      formatLogLine({
        event: 'post_finished',
        opId: '0b5a2b7e-6f43-4a8e-9a63-1f6b1d3c2e10' as never,
        httpStatus: 202,
        attempt: 1,
        cause: 'ok',
      }),
    ).toBe(
      '[import] post_finished opId=0b5a2b7e-6f43-4a8e-9a63-1f6b1d3c2e10 httpStatus=202 attempt=1 cause=ok',
    );
  });

  it('prints in dev, behind the core sanitiser (smuggled fields are dropped)', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = createLogger(createDevConsoleSink(true));
    logger.log({
      event: 'local_rejection',
      cause: 'oversize',
      fileName: 'secret.csv',
      uri: 'file:///x',
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('[import] local_rejection cause=oversize');
  });

  it('is a no-op in release', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    createDevConsoleSink(false)({ event: 'controller_started' });
    expect(spy).not.toHaveBeenCalled();
  });
});
