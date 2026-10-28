// Local validation before any POST.
// Mirrors the mock's `format()` on bytes, not decoded text:
//   first 5 bytes == "%PDF-"  OR  first 24 bytes == "date,description,amount\n" exactly.
// Consequences shared with the mock: CRLF header → rejected; UTF-8 BOM → rejected; empty → rejected.

import type { FileFormat } from './domain';

/** 10 MiB. A file of exactly this size is accepted; one byte more is rejected. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Bytes to read from the private copy for the content check (short reads are normal). */
export const HEADER_BYTES = 24;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const CSV_HEADER = Array.from('date,description,amount\n', (c) => c.charCodeAt(0));

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Detects the statement format from the first bytes of the file (`header` may be shorter than
 * {@link HEADER_BYTES} for small files). Returns null for anything else.
 *
 * Deliberately stricter than the mock in one corner: the mock decodes the PDF magic with Node's
 * `ascii` codec, which clears the high bit, so it also accepts e.g. `A5 D0 C4 C6 AD`. We require
 * the exact bytes; a client rejection of such a file is safe (nothing is sent).
 */
export function detectFormat(header: Uint8Array): FileFormat | null {
  if (startsWith(header, PDF_MAGIC)) return 'pdf';
  if (startsWith(header, CSV_HEADER)) return 'csv';
  return null;
}

export function isWithinSizeLimit(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= MAX_FILE_BYTES;
}

/** Picker metadata: a positive number is a known size; 0 / null / NaN means unknown. */
export function knownDeclaredSize(declared: number | null | undefined): number | null {
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
    ? declared
    : null;
}
