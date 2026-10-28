import { describe, expect, it } from 'vitest';

import { decodeOperation, encodeOperation, journalForm, journalKeepsFileName } from './codec';
import {
  asDeleteKey,
  asIdempotencyKey,
  asJobId,
  asOpId,
  PHASE_TAGS,
  type Operation,
  type ReadyResult,
} from './domain';
import { newOperation } from './machine';

const base = newOperation({
  opId: asOpId('0d2e4f6a-8b0c-4d1e-a3f5-b7c9d1e3f5a7'),
  key: asIdempotencyKey('5f0c6f8e-2a7b-4c1d-9e3f-0a1b2c3d4e5f'),
  createdAt: 1_700_000_000_000,
  format: 'pdf',
  size: 34_000,
  name: 'statement.pdf',
  tempPath: '/cache/imports/x.bin',
});

describe('journal codec (schemaVersion 1)', () => {
  it.each<[string, Operation]>([
    ['pending_send', base],
    [
      'outcome_unknown',
      {
        ...base,
        phase: {
          tag: 'outcome_unknown',
          cause: 'server_error',
          lookup: 'skipped',
          attempt: 2,
          abandon: true,
        },
      },
    ],
    [
      'ready',
      {
        ...base,
        revision: 3,
        phase: { tag: 'server', jobId: asJobId('job-demo-001'), status: 'ready' },
        result: {
          currency: 'AUD',
          items: [
            {
              id: 'r',
              merchant: 'StreamBeam',
              amountMinor: 1999,
              cadence: 'monthly',
              lastSeen: '2026-10-01',
            },
          ],
        },
      },
    ],
    [
      'delete_failed',
      {
        ...base,
        deleteKey: asDeleteKey('8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d'),
        phase: { tag: 'delete_failed', jobId: asJobId('job-demo-001'), cause: 'timeout' },
      },
    ],
    ['lost', { ...base, phase: { tag: 'lost', jobId: null } }],
  ])('round-trips %s (as the journal stores it)', (_name, op) => {
    expect(decodeOperation(encodeOperation(op))).toEqual({ ok: true, value: journalForm(op) });
  });

  it.each([
    ['not json', '{'],
    ['wrong schema version', JSON.stringify({ ...base, schemaVersion: 2 })],
    ['unknown phase', JSON.stringify({ ...base, phase: { tag: 'done' } })],
    ['short key', JSON.stringify({ ...base, key: 'short' })],
  ])('rejects %s', (_name, body) => {
    expect(decodeOperation(body)).toEqual({ ok: false, error: 'invalid' });
  });
});

const READY_RESULT: ReadyResult = {
  currency: 'AUD',
  items: [
    {
      id: 'rec-001',
      merchant: 'StreamBeam',
      amountMinor: 1999,
      cadence: 'monthly',
      lastSeen: '2026-10-01',
    },
    {
      id: 'rec-002',
      merchant: 'BrightGrid',
      amountMinor: 13200,
      cadence: 'monthly',
      lastSeen: '2026-10-03',
    },
  ],
};
const JOB = asJobId('job-demo-001');

describe('journal minimisation (the iOS journal is in iCloud / Finder backups)', () => {
  it('keeps the file name only until the server has the job (resend needs X-File-Name)', () => {
    const keeps = PHASE_TAGS.filter((tag) => journalKeepsFileName({ tag } as Operation['phase']));
    expect(keeps).toEqual(['pending_send', 'sending', 'outcome_unknown']);
    const unknown: Operation = {
      ...base,
      phase: {
        tag: 'outcome_unknown',
        cause: 'timeout',
        lookup: 'not_found',
        attempt: 1,
        abandon: false,
      },
    };
    expect(encodeOperation(unknown)).toContain('statement.pdf');
    expect(journalForm(unknown)).toBe(unknown);
  });

  it.each<[string, Operation['phase']]>([
    ['accepted (queued)', { tag: 'server', jobId: JOB, status: 'queued' }],
    ['ready', { tag: 'server', jobId: JOB, status: 'ready' }],
    ['delete_requested', { tag: 'delete_requested', jobId: JOB }],
    ['delete_failed', { tag: 'delete_failed', jobId: JOB, cause: 'http_5xx' }],
    ['deleting', { tag: 'deleting', jobId: JOB }],
  ])('after %s the stored body has no file name and no report', (_name, phase) => {
    const op: Operation = {
      ...base,
      revision: 3,
      result: READY_RESULT,
      phase,
      file: { ...base.file, tempPath: null },
    };
    const body = encodeOperation(op);
    for (const secret of ['statement.pdf', 'StreamBeam', 'BrightGrid', 'rec-001', '1999']) {
      expect(body).not.toContain(secret);
    }
    const decoded = decodeOperation(body);
    expect(decoded.ok && decoded.value.file.name).toBe('');
    expect(decoded.ok && decoded.value.result).toBeNull();
    // What recovery needs is still there.
    expect(decoded.ok && decoded.value).toMatchObject({
      schemaVersion: 1,
      opId: base.opId,
      key: base.key,
      revision: 3,
      phase,
      file: { format: 'pdf', size: 34_000 },
    });
    // The in-memory op is not touched.
    expect(op.file.name).toBe('statement.pdf');
    expect(op.result).toBe(READY_RESULT);
  });

  it('never stores the report, even in a phase that keeps the name', () => {
    const odd: Operation = { ...base, result: READY_RESULT };
    expect(encodeOperation(odd)).not.toContain('StreamBeam');
    expect(encodeOperation(odd)).toContain('statement.pdf');
  });

  it('decodes a row written by an older build (name and report inside) unchanged', () => {
    const legacy: Operation = {
      ...base,
      revision: 3,
      result: READY_RESULT,
      phase: { tag: 'server', jobId: JOB, status: 'ready' },
    };
    const decoded = decodeOperation(JSON.stringify(legacy));
    expect(decoded).toEqual({ ok: true, value: legacy });
    // ...and journalForm says it must be rewritten (the controller does so at cold start).
    expect(decoded.ok && journalForm(decoded.value)).not.toBe(decoded.ok && decoded.value);
  });
});
