// Starts the REAL, unchanged mock (mock-kit/mock-server.mjs) in-process on an ephemeral port with
// a temp state file, plus small raw-HTTP helpers for the test-control routes.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockServer } from '../../mock-kit/mock-server.mjs';
import type { MockMode, MockState, MockStats } from '../../src/core';

export interface RunningMock {
  readonly baseUrl: string;
  state(): Promise<MockState>;
  stats(): Promise<MockStats>;
  scenario(mode: MockMode): Promise<void>;
  reset(): Promise<void>;
  /** Raw POST /imports outside the app (e.g. a "foreign" client after a reset). */
  rawCreate(
    key: string,
    body: Uint8Array,
    fileName?: string,
  ): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export async function startMock(): Promise<RunningMock> {
  const dir = mkdtempSync(join(tmpdir(), 'sir-mock-'));
  const server = createMockServer({ statePath: join(dir, 'state.json') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const state = async (): Promise<MockState> => {
    const response = await fetch(`${baseUrl}/__test/state`);
    if (response.status !== 200) throw new Error(`/__test/state → ${response.status}`);
    return (await response.json()) as MockState;
  };

  return {
    baseUrl,
    state,
    stats: async () => (await state()).stats,
    async scenario(mode) {
      const response = await fetch(`${baseUrl}/__test/scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (response.status !== 200) throw new Error(`/__test/scenario → ${response.status}`);
    },
    async reset() {
      const response = await fetch(`${baseUrl}/__test/reset`, { method: 'POST' });
      if (response.status !== 200) throw new Error(`/__test/reset → ${response.status}`);
    },
    async rawCreate(key, body, fileName = 'statement.csv') {
      const response = await fetch(`${baseUrl}/imports`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': key,
          'X-File-Name': fileName,
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // keep text
      }
      return { status: response.status, body: parsed };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function statsDelta(before: MockStats, after: MockStats): MockStats {
  return {
    createRequests: after.createRequests - before.createRequests,
    newJobs: after.newJobs - before.newJobs,
    duplicateHits: after.duplicateHits - before.duplicateHits,
    acceptedBytes: after.acceptedBytes - before.acceptedBytes,
    deleteRequests: after.deleteRequests - before.deleteRequests,
  };
}
