// Deterministic formatting for the UI. No Intl: the output must be identical on
// Hermes/iOS/Android and in Node tests.

import type { FileFormat, ReadyItem, ReadyResult } from './domain';

/** Minor-unit exponents for the few currencies we might see; default 2. */
const MINOR_DIGITS: Readonly<Record<string, number>> = { JPY: 0, KRW: 0, BHD: 3, KWD: 3 };

function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency] ?? 2;
}

/** `1999, 'AUD'` → `19.99 AUD`; `-500, 'AUD'` → `-5.00 AUD`. Integer arithmetic only. */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  const negative = amountMinor < 0;
  const abs = String(Math.abs(Math.trunc(amountMinor)));
  let text: string;
  if (digits === 0) {
    text = abs;
  } else {
    const padded = abs.padStart(digits + 1, '0');
    text = `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  }
  return `${negative ? '-' : ''}${text} ${currency}`;
}

const CADENCE_TEXT: Readonly<Record<string, string>> = {
  monthly: 'monthly',
  weekly: 'weekly',
  yearly: 'yearly',
  annual: 'yearly',
};

export function formatCadence(cadence: string): string {
  return CADENCE_TEXT[cadence] ?? cadence;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-01` → `1 Oct 2026` (en-AU order, no Intl); anything else is returned unchanged. */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  const dayNumber = Number(day);
  if (monthName === undefined || dayNumber < 1 || dayNumber > 31) return isoDate;
  return `${dayNumber} ${monthName} ${year ?? ''}`;
}

/** `StreamBeam — 19.99 AUD, monthly, last charged 1 Oct 2026`. */
export function formatItemLine(item: ReadyItem, currency: string): string {
  return `${item.merchant} — ${formatMoney(item.amountMinor, currency)}, ${formatCadence(item.cadence)}, last charged ${formatDate(item.lastSeen)}`;
}

/** Integer sum of the monthly items' minor units. */
export function monthlyTotalMinor(result: ReadyResult): number {
  return result.items.reduce(
    (sum, item) => (item.cadence === 'monthly' ? sum + item.amountMinor : sum),
    0,
  );
}

/** `151.99 AUD/month`. */
export function formatMonthlyTotal(result: ReadyResult): string {
  return `${formatMoney(monthlyTotalMinor(result), result.currency)}/month`;
}

/** `tenths` (an integer count of 0.1 units) → `12.3`. */
function tenthsText(tenths: number): string {
  return `${Math.trunc(tenths / 10)}.${tenths % 10}`;
}

const KIB = 1024;
const MIB = 1024 * 1024;

/** Tenths of `unit`, rounded UP: a size is never shown smaller than it is. */
function ceilTenths(bytes: number, unit: number): number {
  return Math.ceil((bytes * 10) / unit);
}

/**
 * `112 B`, `33.3 KiB`, `10.0 MiB` (binary units, same wording as the 10 MiB limit copy, decimal
 * point). Rounded up to 0.1, so anything over the limit (10 485 761 B) reads `10.1 MiB`, never
 * `10.0`; the unit switches once rounding reaches 1024 (1 048 575 B → `1.0 MiB`).
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const whole = Math.ceil(bytes);
  if (whole < KIB) return `${whole} B`;
  const kib = ceilTenths(whole, KIB);
  if (kib < 1024 * 10) return `${tenthsText(kib)} KiB`;
  return `${tenthsText(ceilTenths(whole, MIB))} MiB`;
}

export function formatFileFormat(format: FileFormat): string {
  return format === 'pdf' ? 'PDF' : 'CSV';
}

/** `45%` from upload progress; null when the total is unknown. */
export function formatPercent(sent: number, total: number): string | null {
  if (!(total > 0)) return null;
  const percent = Math.min(100, Math.max(0, Math.floor((sent / total) * 100)));
  return `${percent}%`;
}
