import { describe, expect, it } from 'vitest';

import {
  detectFormat,
  HEADER_BYTES,
  isWithinSizeLimit,
  knownDeclaredSize,
  MAX_FILE_BYTES,
} from './validate';

const bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const utf8 = (text: string): Uint8Array => {
  // Minimal UTF-8 encoder for the BOM case (no TextEncoder in the core's lib set needed).
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
};

describe('detectFormat (byte-exact mirror of the mock format())', () => {
  it.each<[string, Uint8Array, 'pdf' | 'csv' | null]>([
    ['%PDF-…', bytes('%PDF-1.7\n'), 'pdf'],
    ['exactly %PDF-', bytes('%PDF-'), 'pdf'],
    ['%PDF (4 bytes, short read)', bytes('%PDF'), null],
    ['csv header + row', bytes('date,description,amount\n2026-10-01,X,-1\n'), 'csv'],
    ['csv header only (24 bytes)', bytes('date,description,amount\n'), 'csv'],
    ['csv CRLF header', bytes('date,description,amount\r\n'), null],
    ['csv BOM', utf8('\ufeffdate,description,amount\n'), null],
    ['csv header truncated (23 bytes)', bytes('date,description,amount'), null],
    ['csv upper case', bytes('Date,description,amount\n'), null],
    ['empty', new Uint8Array(0), null],
    ['not a pdf', bytes('not a pdf'), null],
    ['spoofed fixture text', bytes('This is plain text, not a PDF.'), null],
    [
      'high-bit %PDF- (mock accepts, we reject: safe)',
      Uint8Array.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]),
      null,
    ],
    ['leading space', bytes(' %PDF-'), null],
  ])('%s → %s', (_name, header, expected) => {
    expect(detectFormat(header)).toBe(expected);
  });

  it('needs at most HEADER_BYTES bytes', () => {
    expect(HEADER_BYTES).toBe(24);
    expect(detectFormat(bytes('date,description,amount\n'.slice(0, HEADER_BYTES)))).toBe('csv');
  });
});

describe('size limit (R3)', () => {
  it('equal to 10 MiB is accepted, one byte more is rejected', () => {
    expect(MAX_FILE_BYTES).toBe(10_485_760);
    expect(isWithinSizeLimit(MAX_FILE_BYTES)).toBe(true);
    expect(isWithinSizeLimit(MAX_FILE_BYTES + 1)).toBe(false);
    expect(isWithinSizeLimit(0)).toBe(true);
    expect(isWithinSizeLimit(Number.NaN)).toBe(false);
  });

  it('picker size: positive = known; 0 / null / undefined / NaN = unknown', () => {
    expect(knownDeclaredSize(112)).toBe(112);
    expect(knownDeclaredSize(0)).toBeNull();
    expect(knownDeclaredSize(null)).toBeNull();
    expect(knownDeclaredSize(undefined)).toBeNull();
    expect(knownDeclaredSize(Number.NaN)).toBeNull();
    expect(knownDeclaredSize(-1)).toBeNull();
  });
});
