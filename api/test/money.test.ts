// Seed unit test for two small pure money helpers — the baht-amount normalizer that
// cleans slip/OCR text into a 2-decimal string, and the satang-safe equality used by the
// bank auto-matcher. Pure over strings, no DB/network — the smallest habit-forming test.
import { describe, it, expect } from 'vitest';
import { normalizeAmount } from '../src/finance/normalize.js';
import { amountsEqual } from '../src/bank/match.js';
import { computeReRow, type ReReconPayment } from '../src/finance/reRecon.js';

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

describe('computeReRow (กระทบยอด RE apportionment)', () => {
  // A pays 400, B pays 600 — the two receipts a single 1,000 transfer settles.
  const twoRe = new Map<string, string>([
    ['A', '400.00'],
    ['B', '600.00'],
  ]);
  const pay = (reNumbers: string[], amount: string, whtAmount = ''): ReReconPayment => ({ reNumbers, amount, whtAmount });

  it('no payment → unpaid', () => {
    const r = computeReRow('400.00', [], twoRe);
    expect(r.status).toBe('unpaid');
    expect(r.paidGross).toBe(0);
    expect(r.paymentCount).toBe(0);
  });

  it('single-RE transfer that ties out → matched, paid = its own amount', () => {
    const r = computeReRow('400.00', [pay(['A'], '400.00')], new Map([['A', '400.00']]));
    expect(r.status).toBe('matched');
    expect(r.paidGross).toBe(400);
    expect(r.diff).toBe(0);
  });

  it('ONE transfer paying [A,B] does NOT double-count — each RE gets only its own share', () => {
    // The regression: the old view added the whole 1,000 gross to BOTH A and B.
    const transfer = pay(['A', 'B'], '1000.00');
    const a = computeReRow('400.00', [transfer], twoRe);
    const b = computeReRow('600.00', [transfer], twoRe);
    expect(a.status).toBe('matched');
    expect(a.paidGross).toBe(400); // not 1000
    expect(a.diff).toBe(0);
    expect(b.status).toBe('matched');
    expect(b.paidGross).toBe(600); // not 1000
    expect(b.diff).toBe(0);
  });

  it('GROSS = net + WHT is reconciled against the receipt sum', () => {
    // Customer sent 970 net + withheld 30 = 1,000 gross against A(400)+B(600).
    const transfer = pay(['A', 'B'], '970.00', '30.00');
    const a = computeReRow('400.00', [transfer], twoRe);
    expect(a.status).toBe('matched');
    expect(a.paidGross).toBe(400);
  });

  it('a genuinely short multi-RE transfer → mismatch, diff is the RE’s proportional share', () => {
    const short = pay(['A', 'B'], '900.00'); // 100 short of 1,000
    const a = computeReRow('400.00', [short], twoRe);
    expect(a.status).toBe('mismatch');
    expect(a.paidGross).toBe(360); // 900 * 400/1000
    expect(a.diff).toBe(-40); // A's 40% share of the 100 shortfall
  });

  it('sub-baht rounding is tolerated (still matched)', () => {
    const r = computeReRow('400.00', [pay(['A', 'B'], '1000.75')], twoRe); // 0.75 over
    expect(r.status).toBe('matched');
  });

  it('a co-receipt not yet imported → stays unresolved (⏳ unpaid), never a false mismatch', () => {
    // Transfer pays A (imported) and C (no ReReceipt row yet) — can’t price it, so don’t alarm.
    const r = computeReRow('400.00', [pay(['A', 'C'], '1000.00')], new Map([['A', '400.00']]));
    expect(r.status).toBe('unpaid');
    expect(r.paymentCount).toBe(1); // but the UI still knows a transfer exists
  });
});
