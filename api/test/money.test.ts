// Seed unit test for two small pure money helpers — the baht-amount normalizer that
// cleans slip/OCR text into a 2-decimal string, and the satang-safe equality used by the
// bank auto-matcher. Pure over strings, no DB/network — the smallest habit-forming test.
import { describe, it, expect } from 'vitest';
import { normalizeAmount } from '../src/finance/normalize.js';
import { amountsEqual } from '../src/bank/match.js';
import { computeReRow, type ReReconPayment } from '../src/finance/reRecon.js';
import { buildDiscrepancyComponents, effectivePaidSatang, expectedForPayment, grossSatang, normalizeReCore } from '../src/finance/discrepancy.js';

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

  it('cash plus customer credit settles the RE without changing raw gross', () => {
    const transfer = { ...pay(['A'], '2000.00'), creditUsed: '3000.00' };
    const result = computeReRow('5000.00', [transfer], new Map([['A', '5000.00']]));
    expect(result.status).toBe('matched');
    expect(result.paidGross).toBe(5000);
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

describe('computeReRow ปิดใน Express (clean *** flag = Express already got the money)', () => {
  const oneRe = new Map<string, string>([['A', '400.00']]);
  const pay = (reNumbers: string[], amount: string, whtAmount = ''): ReReconPayment => ({ reNumbers, amount, whtAmount });

  it('clean + no Juno payments → closed (the pre-Pantheon backlog case)', () => {
    const r = computeReRow('400.00', [], oneRe, false);
    expect(r.status).toBe('closed');
    expect(r.paymentCount).toBe(0);
  });

  it('*** + no payments → unpaid (the real chase queue)', () => {
    expect(computeReRow('400.00', [], oneRe, true).status).toBe('unpaid');
  });

  it('clean + matched payments → closed (จับ RE แล้ว advances at the next import)', () => {
    const r = computeReRow('400.00', [pay(['A'], '400.00')], oneRe, false);
    expect(r.status).toBe('closed');
    expect(r.paidGross).toBe(400);
  });

  it('*** + matched payments → matched (money in Juno, Express entry not finished)', () => {
    expect(computeReRow('400.00', [pay(['A'], '400.00')], oneRe, true).status).toBe('matched');
  });

  it('clean + genuinely mismatched payments → mismatch wins over closed (never silenced)', () => {
    const r = computeReRow('400.00', [pay(['A'], '300.00')], oneRe, false);
    expect(r.status).toBe('mismatch');
    expect(r.diff).toBe(-100);
  });

  it('clean + unpriceable transfer (co-receipt missing) → closed, Express is authoritative', () => {
    const r = computeReRow('400.00', [pay(['A', 'C'], '1000.00')], oneRe, false);
    expect(r.status).toBe('closed');
    expect(r.paymentCount).toBe(1);
  });

  it('omitted flag defaults to *** semantics (legacy callers unchanged)', () => {
    expect(computeReRow('400.00', [], oneRe).status).toBe('unpaid');
  });
});

describe('wrong-transfer discrepancy invariants', () => {
  const wrong = { id: 'wrong', amount: '125.50', whtAmount: '', reNumbers: [] as string[], discExpected: '0', status: 'verified' };
  it('treats expected zero as the whole-gross refund even without an RE', () => {
    expect(expectedForPayment(wrong)?.expectedSatang).toBe(0);
    expect(grossSatang(wrong)).toBe(12_550);
  });
  it('keeps the sentinel and void rows out of RE components', () => {
    expect(normalizeReCore('0000000')).toBeNull();
    expect(buildDiscrepancyComponents([{ ...wrong, reNumbers: ['0000000'] }], [])).toEqual([]);
    expect(buildDiscrepancyComponents([{ ...wrong, status: 'void', reNumbers: ['6900001'] }], [{ reNumber: '6900001', amount: '125.50' }])).toEqual([]);
  });
  it('ignores credit on wrong transfers while preserving raw gross', () => {
    expect(grossSatang({ ...wrong, creditUsed: '300.00' })).toBe(12_550);
    expect(effectivePaidSatang({ ...wrong, creditUsed: '300.00', wrongTransferAt: new Date() })).toBe(12_550);
  });
});

describe('customer-credit discrepancy math', () => {
  it('uses cash + WHT + credit for settlement and retains cash + WHT as gross', () => {
    const payment = { id: 'credit', amount: '2000.00', whtAmount: '100.00', creditUsed: '2900.00', reNumbers: ['6900001'] };
    const [component] = buildDiscrepancyComponents([payment], [{ reNumber: '6900001', amount: '5000.00' }]);
    expect(grossSatang(payment)).toBe(210_000);
    expect(effectivePaidSatang(payment)).toBe(500_000);
    expect(component.diffSatang).toBe(0);
  });
});
