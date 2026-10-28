import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildFileNameHeader,
  classifyDelete,
  classifyPost,
  classifyRead,
  isJobNotFoundBody,
  MAX_FILE_NAME_HEADER,
  parseJobView,
} from './api';
import type { HttpResponse, TransportError } from './ports';
import { err, ok, type Result } from './result';

const res = (status: number, body: unknown): Result<HttpResponse, TransportError> =>
  ok({ status, bodyText: typeof body === 'string' ? body : JSON.stringify(body) });

const READY = {
  jobId: 'job-demo-001',
  status: 'ready',
  revision: 3,
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

describe('zod schemas', () => {
  it('parses every status the mock serves', () => {
    for (const status of ['queued', 'processing', 'deleting', 'deleted']) {
      expect(parseJobView(JSON.stringify({ jobId: 'job-demo-001', status, revision: 1 }))).toEqual({
        jobId: 'job-demo-001',
        status,
        revision: 1,
      });
    }
    expect(parseJobView(JSON.stringify(READY))).toMatchObject({
      status: 'ready',
      result: { currency: 'AUD', items: READY.items },
    });
  });

  it.each([
    ['not json', 'oops'],
    ['unknown status', { jobId: 'j', status: 'done', revision: 1 }],
    ['ready without items', { jobId: 'j', status: 'ready', revision: 3, currency: 'AUD' }],
    ['non-integer revision', { jobId: 'j', status: 'queued', revision: 1.5 }],
    ['negative revision', { jobId: 'j', status: 'queued', revision: -1 }],
    ['missing jobId', { status: 'queued', revision: 1 }],
    ['bad date', { ...READY, items: [{ ...READY.items[0], lastSeen: '01.10.2026' }] }],
  ])('rejects %s', (_name, body) => {
    expect(parseJobView(typeof body === 'string' ? body : JSON.stringify(body))).toBeNull();
  });
});

describe('only {"error":"job not found"} means not found', () => {
  it('matches exactly', () => {
    expect(isJobNotFoundBody('{"error":"job not found"}')).toBe(true);
    expect(isJobNotFoundBody('{ "error" : "job not found" }')).toBe(true);
    expect(isJobNotFoundBody('{"error":"route not found"}')).toBe(false);
    expect(isJobNotFoundBody('{"error":"job not found","x":1}')).toBe(false);
    expect(isJobNotFoundBody('job not found')).toBe(false);
  });

  it('reads: 404 job → not_found; 404 route / 400 → config; 5xx → server; bad 200 → protocol', () => {
    expect(classifyRead(res(404, { error: 'job not found' }))).toEqual({ tag: 'not_found' });
    expect(classifyRead(res(404, { error: 'route not found' }))).toEqual({
      tag: 'failed',
      error: { kind: 'config', httpStatus: 404 },
    });
    expect(classifyRead(res(400, { error: 'invalid request' }))).toEqual({
      tag: 'failed',
      error: { kind: 'config', httpStatus: 400 },
    });
    expect(classifyRead(res(503, {}))).toEqual({
      tag: 'failed',
      error: { kind: 'server', httpStatus: 503 },
    });
    expect(classifyRead(res(200, { nope: true }))).toEqual({
      tag: 'failed',
      error: { kind: 'protocol', httpStatus: 200 },
    });
    expect(classifyRead(res(200, READY))).toMatchObject({
      tag: 'found',
      view: { status: 'ready' },
    });
    expect(classifyRead(err({ cause: 'timeout' }))).toEqual({
      tag: 'failed',
      error: { kind: 'transport', cause: 'timeout' },
    });
  });

  it('DELETE: 202 any body → accepted; 404 job → not_found; 404 route → config; 400/409 → client; 503 → server', () => {
    expect(
      classifyDelete(res(202, { jobId: 'job-demo-001', status: 'deleted', revision: 5 })),
    ).toMatchObject({
      tag: 'accepted',
      view: { status: 'deleted', revision: 5 },
    });
    expect(classifyDelete(res(202, 'garbage'))).toEqual({ tag: 'accepted', view: null });
    expect(classifyDelete(res(404, { error: 'job not found' }))).toEqual({ tag: 'not_found' });
    expect(classifyDelete(res(404, { error: 'route not found' }))).toEqual({
      tag: 'failed',
      error: { kind: 'config', httpStatus: 404 },
    });
    expect(classifyDelete(res(400, {}))).toEqual({ tag: 'client_error', httpStatus: 400 });
    expect(classifyDelete(res(409, {}))).toEqual({ tag: 'client_error', httpStatus: 409 });
    expect(classifyDelete(res(503, { error: 'temporary delete failure' }))).toEqual({
      tag: 'failed',
      error: { kind: 'server', httpStatus: 503 },
    });
  });

  it('POST: 202 → accepted; 409/413/415 → rejected; 400 → client; 404 → config; bad 202 → protocol', () => {
    expect(
      classifyPost(res(202, { jobId: 'job-demo-001', status: 'queued', revision: 1 })),
    ).toEqual({
      tag: 'accepted',
      jobId: 'job-demo-001',
      revision: 1,
    });
    expect(classifyPost(res(202, { jobId: 'job-demo-001', status: 'ready', revision: 3 }))).toEqual(
      {
        tag: 'failed',
        error: { kind: 'protocol', httpStatus: 202 },
      },
    );
    for (const status of [409, 413, 415]) {
      expect(classifyPost(res(status, { error: 'e' }))).toEqual({
        tag: 'rejected',
        httpStatus: status,
        error: 'e',
      });
    }
    expect(classifyPost(res(400, { error: 'X-File-Name is required' }))).toEqual({
      tag: 'client_error',
      httpStatus: 400,
    });
    expect(classifyPost(res(404, { error: 'route not found' }))).toEqual({
      tag: 'failed',
      error: { kind: 'config', httpStatus: 404 },
    });
  });
});

describe('X-File-Name', () => {
  it('ASCII names pass unchanged', () => {
    expect(buildFileNameHeader('statement.csv', 'csv')).toBe('statement.csv');
    expect(buildFileNameHeader('  bank 2026.pdf ', 'pdf')).toBe('bank 2026.pdf');
  });

  it('non-ASCII names are percent-encoded', () => {
    expect(buildFileNameHeader('Выписка.pdf', 'pdf')).toBe(encodeURIComponent('Выписка.pdf'));
    expect(buildFileNameHeader('line\nbreak.csv', 'csv')).toBe(
      encodeURIComponent('line\nbreak.csv'),
    );
  });

  it('empty or unencodable names fall back to statement.<format>', () => {
    expect(buildFileNameHeader('', 'csv')).toBe('statement.csv');
    expect(buildFileNameHeader('   ', 'pdf')).toBe('statement.pdf');
    expect(buildFileNameHeader('bad\ud800.csv', 'csv')).toBe('statement.csv');
  });

  it('long names are truncated to ≤ 255 encoded chars keeping the extension', () => {
    const ascii = buildFileNameHeader(`${'a'.repeat(400)}.csv`, 'csv');
    expect(ascii).toHaveLength(255);
    expect(ascii.endsWith('.csv')).toBe(true);
    const cyrillic = buildFileNameHeader(`${'я'.repeat(200)}.pdf`, 'pdf');
    expect(cyrillic.length).toBeLessThanOrEqual(255);
    expect(cyrillic.endsWith('.pdf')).toBe(true);
    expect(decodeURIComponent(cyrillic)).toMatch(/^я+\.pdf$/); // never cuts inside a %XX sequence
  });

  it('property: always 1–255 printable ASCII chars (header-safe)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 600 }),
        fc.constantFrom('pdf' as const, 'csv' as const),
        (name, format) => {
          const value = buildFileNameHeader(name, format);
          expect(value.length).toBeGreaterThanOrEqual(1);
          expect(value.length).toBeLessThanOrEqual(MAX_FILE_NAME_HEADER);
          expect(value).toMatch(/^[\x20-\x7e]+$/);
          expect(value).toBe(value.trim());
        },
      ),
      { numRuns: 500 },
    );
  });
});
