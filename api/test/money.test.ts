// Seed unit test for two small pure money helpers — the baht-amount normalizer that
// cleans slip/OCR text into a 2-decimal string, and the satang-safe equality used by the
// bank auto-matcher. Pure over strings, no DB/network — the smallest habit-forming test.
import { describe, it, expect } from 'vitest';
import { normalizeAmount } from '../src/finance/normalize.js';
import { amountsEqual } from '../src/bank/match.js';

describe('normalizeAmount', () => {
  it('strips thousands commas to a 2-decimal string', () => {
    expect(normalizeAmount('1,500')).toBe('1500.00');
  });

  it('strips a ฿ symbol and surrounding spaces', () => {
    expect(normalizeAmount(' ฿ 1,234.50 ')).toBe('1234.50');
  });

  it('pads a bare integer to two decimals', () => {
    expect(normalizeAmount('42')).toBe('42.00');
  });

  it('returns an empty string for empty / non-numeric input', () => {
    expect(normalizeAmount('')).toBe('');
    expect(normalizeAmount('n/a')).toBe('');
  });
});

describe('amountsEqual', () => {
  it('treats "1234.5" and "1234.50" as equal (satang-normalized)', () => {
    expect(amountsEqual('1234.5', '1234.50')).toBe(true);
  });

  it('distinguishes a 1-satang difference', () => {
    expect(amountsEqual('1234.50', '1234.51')).toBe(false);
  });

  it('treats blank as zero without a false NaN mismatch', () => {
    expect(amountsEqual('', '0')).toBe(true);
  });
});
