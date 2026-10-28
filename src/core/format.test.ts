import { describe, expect, it } from 'vitest';

import {
  formatCadence,
  formatDate,
  formatFileFormat,
  formatItemLine,
  formatMoney,
  formatMonthlyTotal,
  formatPercent,
  formatSize,
  monthlyTotalMinor,
} from './format';

const RESULT = {
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

describe('format', () => {
  it('money uses integer minor units', () => {
    expect(formatMoney(1999, 'AUD')).toBe('19.99 AUD');
    expect(formatMoney(13200, 'AUD')).toBe('132.00 AUD');
    expect(formatMoney(5, 'AUD')).toBe('0.05 AUD');
    expect(formatMoney(0, 'AUD')).toBe('0.00 AUD');
    expect(formatMoney(-1999, 'AUD')).toBe('-19.99 AUD');
    expect(formatMoney(500, 'JPY')).toBe('500 JPY');
  });

  it('monthly total of the mock result is exactly "151.99 AUD/month"', () => {
    expect(monthlyTotalMinor(RESULT)).toBe(15199);
    expect(formatMonthlyTotal(RESULT)).toBe('151.99 AUD/month');
    const withYearly = {
      ...RESULT,
      items: [...RESULT.items, { ...RESULT.items[0]!, id: 'y', cadence: 'yearly' }],
    };
    expect(formatMonthlyTotal(withYearly)).toBe('151.99 AUD/month');
  });

  it('item lines', () => {
    expect(formatItemLine(RESULT.items[0]!, 'AUD')).toBe(
      'StreamBeam — 19.99 AUD, monthly, last charged 1 Oct 2026',
    );
    expect(formatItemLine(RESULT.items[1]!, 'AUD')).toBe(
      'BrightGrid — 132.00 AUD, monthly, last charged 3 Oct 2026',
    );
  });

  it('dates, cadence, sizes, formats, percent', () => {
    expect(formatDate('2026-10-01')).toBe('1 Oct 2026');
    expect(formatDate('2026-03-09')).toBe('9 Mar 2026');
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
    expect(formatDate('2026-13-01')).toBe('2026-13-01');
    expect(formatDate('garbage')).toBe('garbage');
    expect(formatCadence('monthly')).toBe('monthly');
    expect(formatCadence('annual')).toBe('yearly');
    expect(formatCadence('fortnightly')).toBe('fortnightly');
    expect(formatSize(112)).toBe('112 B');
    expect(formatSize(34_000)).toBe('33.3 KiB');
    expect(formatSize(-1)).toBe('—');
    expect(formatFileFormat('pdf')).toBe('PDF');
    expect(formatFileFormat('csv')).toBe('CSV');
    expect(formatPercent(56, 112)).toBe('50%');
    expect(formatPercent(1, 0)).toBeNull();
    expect(formatPercent(200, 112)).toBe('100%');
  });

  it('sizes near the 10 MiB limit never read as the limit when they exceed it', () => {
    expect(formatSize(10_485_760)).toBe('10.0 MiB'); // exactly the limit (accepted)
    expect(formatSize(10_485_761)).toBe('10.1 MiB'); // one byte over (rejected)
    expect(formatSize(10_485_771)).toBe('10.1 MiB'); // the kit's oversize.csv
    expect(formatSize(10_485_759)).toBe('10.0 MiB');
    // Rounding up to 1024 KiB switches the unit.
    expect(formatSize(1_048_575)).toBe('1.0 MiB');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KiB');
    expect(formatSize(1025)).toBe('1.1 KiB');
  });
});
