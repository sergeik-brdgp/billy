// HttpPort on React Native's fetch (GET / DELETE / test routes). Timeout and the caller's signal
// are merged into one AbortController; non-2xx responses are returned, never thrown.

import {
  err,
  ok,
  type ClockPort,
  type HttpPort,
  type HttpResponse,
  type Result,
  type TransportError,
} from '../core';
import { classifyFetchFailure, headersAreValid, invalidHeaderError } from './transport-errors';

export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface FetchHttpDeps {
  readonly clock: ClockPort;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

export function createFetchHttp(deps: FetchHttpDeps): HttpPort {
  const { clock } = deps;
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));

  return {
    async request(req): Promise<Result<HttpResponse, TransportError>> {
      if (!headersAreValid(req.headers)) return err(invalidHeaderError());
      if (req.signal?.aborted) {
        return err(
          classifyFetchFailure({
            stage: 'before_start',
            timedOut: false,
            callerAborted: true,
            bytesSent: 0,
            error: null,
          }),
        );
      }

      const controller = new AbortController();
      let timedOut = false;
      let callerAborted = false;
      const onAbort = (): void => {
        callerAborted = true;
        controller.abort();
      };
      req.signal?.addEventListener('abort', onAbort);
      const timer = clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeoutMs);

      try {
        const response = await doFetch(req.url, {
          method: req.method,
          ...(req.headers ? { headers: { ...req.headers } } : {}),
          ...(req.body !== undefined ? { body: req.body } : {}),
          signal: controller.signal,
        });
        const bodyText = await response.text();
        return ok({ status: response.status, bodyText });
      } catch (error) {
        return err(
          classifyFetchFailure({
            stage: 'in_flight',
            timedOut,
            callerAborted,
            bytesSent: 0,
            error,
          }),
        );
      } finally {
        clock.clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
