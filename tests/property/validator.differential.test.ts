// Randomised differential test: the client's byte check (detectFormat on the first 24 bytes, as the
// controller reads them) against the REAL mock's verdict (POST /imports → 202 or 415).
// Expected relation: client accept ⇒ mock 202 (never send what the server would refuse), and
// client reject ∧ mock 202 only for the documented high-bit "%PDF-" corner (Node 'ascii' decoding).

import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectFormat, HEADER_BYTES } from '../../src/core';
import { startMock, type RunningMock } from '../support/mock';

const PDF = [...Buffer.from('%PDF-')];
const CSV = [...Buffer.from('date,description,amount\n')];

/** Bytes near the interesting prefixes: exact, truncated, mutated, CR-injected, high-bit, BOM. */
const bytesArb: fc.Arbitrary<Uint8Array> = fc
  .tuple(
    fc.constantFrom('pdf', 'csv', 'random'),
    fc.nat(30),
    fc.integer({ min: -1, max: 29 }),
    fc.integer({ min: 0, max: 255 }),
    fc.constantFrom('none', 'mutate', 'insert_cr', 'high_bit', 'bom', 'truncate'),
    fc.uint8Array({ maxLength: 40 }),
  )
  .map(([base, cut, position, byte, how, tail]) => {
    let head = base === 'pdf' ? [...PDF] : base === 'csv' ? [...CSV] : [];
    const at = Math.max(0, Math.min(head.length - 1, position));
    switch (how) {
      case 'mutate':
        if (head.length > 0) head[at] = byte;
        break;
      case 'insert_cr':
        head.splice(at, 0, 0x0d);
        break;
      case 'high_bit':
        head = head.map((b, i) => (i <= at ? b | 0x80 : b));
        break;
      case 'bom':
        head = [0xef, 0xbb, 0xbf, ...head];
        break;
      case 'truncate':
        head = head.slice(0, Math.min(head.length, cut));
        break;
      case 'none':
        break;
    }
    return Uint8Array.from([...head, ...tail]);
  });

const isHighBitPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 &&
  PDF.every((b, i) => ((bytes[i] ?? 0) & 0x7f) === b) &&
  !PDF.every((b, i) => bytes[i] === b);

let mock: RunningMock;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.close();
});

describe('client validator vs real mock (randomised)', () => {
  it('client accept ⇒ mock 202; the only extra mock accepts are high-bit %PDF- variants', async () => {
    let counter = 0;
    let accepted = 0;
    await fc.assert(
      fc.asyncProperty(bytesArb, async (bytes) => {
        counter += 1;
        const client = detectFormat(bytes.subarray(0, HEADER_BYTES));
        const server = await mock.rawCreate(
          `differential-prop-${String(counter).padStart(6, '0')}`,
          bytes,
        );
        expect([202, 415]).toContain(server.status);
        if (client !== null) {
          accepted += 1;
          expect(server.status).toBe(202);
        } else if (server.status === 202) {
          expect(isHighBitPdf(bytes)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
    expect(accepted).toBeGreaterThan(20); // not vacuous
  }, 60_000);
});
