// Seed unit test for two small pure money helpers — the baht-amount normalizer that
// cleans slip/OCR text into a 2-decimal string, and the satang-safe equality used by the
// bank auto-matcher. Pure over strings, no DB/network — the smallest habit-forming test.
import { describe, it, expect } from 'vitest';
import { normalizeAmount } from '../src/finance/normalize.js';
import { amountsEqual } from '../src/bank/match.js';
import { buildReReconIndex, computeReRow, type ReReconPayment } from '../src/finance/reRecon.js';

// One-liner for the tests: build the group index from the given payments and compute one row.
const reRow = (
  core: string,
  own: string,
  payments: ReReconPayment[],
  amounts: Map<string, string>,
  notPosted = true,
  bills: Map<string, string> = new Map(),
) => computeReRow(core, own, buildReReconIndex(payments, amounts, bills), notPosted);
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
    const r = reRow('A', '400.00', [], twoRe);
    expect(r.status).toBe('unpaid');
    expect(r.paidGross).toBe(0);
    expect(r.paymentCount).toBe(0);
  });

  it('single-RE transfer that ties out → matched, paid = its own amount', () => {
    const r = reRow('A', '400.00', [pay(['A'], '400.00')], new Map([['A', '400.00']]));
    expect(r.status).toBe('matched');
    expect(r.paidGross).toBe(400);
    expect(r.diff).toBe(0);
  });

  it('ONE transfer paying [A,B] does NOT double-count — each RE gets only its own share', () => {
    // The regression: the old view added the whole 1,000 gross to BOTH A and B.
    const transfer = pay(['A', 'B'], '1000.00');
    const a = reRow('A', '400.00', [transfer], twoRe);
    const b = reRow('B', '600.00', [transfer], twoRe);
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
    const a = reRow('A', '400.00', [transfer], twoRe);
    expect(a.status).toBe('matched');
    expect(a.paidGross).toBe(400);
  });

  it('cash plus customer credit settles the RE without changing raw gross', () => {
    const transfer = { ...pay(['A'], '2000.00'), creditUsed: '3000.00' };
    const result = reRow('A', '5000.00', [transfer], new Map([['A', '5000.00']]));
    expect(result.status).toBe('matched');
    expect(result.paidGross).toBe(5000);
  });

  it('a genuinely short multi-RE transfer → mismatch, diff is the RE’s proportional share', () => {
    const short = pay(['A', 'B'], '900.00'); // 100 short of 1,000
    const a = reRow('A', '400.00', [short], twoRe);
    expect(a.status).toBe('mismatch');
    expect(a.paidGross).toBe(360); // 900 * 400/1000
    expect(a.diff).toBe(-40); // A's 40% share of the 100 shortfall
  });

  it('sub-baht rounding is tolerated (still matched)', () => {
    const r = reRow('A', '400.00', [pay(['A', 'B'], '1000.75')], twoRe); // 0.75 over
    expect(r.status).toBe('matched');
  });

  it('a co-receipt not yet imported → stays unresolved (⏳ unpaid), never a false mismatch', () => {
    // Transfer pays A (imported) and C (no ReReceipt row yet) — can’t price it, so don’t alarm.
    const r = reRow('A', '400.00', [pay(['A', 'C'], '1000.00')], new Map([['A', '400.00']]));
    expect(r.status).toBe('unpaid');
    expect(r.paymentCount).toBe(1); // but the UI still knows a transfer exists
  });
});

describe('computeReRow split payments (group-level matching)', () => {
  const pay = (reNumbers: string[], amount: string, whtAmount = ''): ReReconPayment => ({ reNumbers, amount, whtAmount });

  it('ONE RE paid by TWO transfers that sum exactly → matched (RE6907847 regression)', () => {
    // The old per-payment check judged each 1,199 alone against the full 2,398 → false ⚠️.
    const amounts = new Map([['A', '2398.00']]);
    const r = reRow('A', '2398.00', [pay(['A'], '1199.00'), pay(['A'], '1199.00')], amounts);
    expect(r.status).toBe('matched');
    expect(r.paidGross).toBe(2398);
    expect(r.diff).toBe(0);
    expect(r.paymentCount).toBe(2);
  });

  it('chained group [A]=400 + [A,B]=600 covering A(400)+B(600) → both matched', () => {
    const amounts = new Map([['A', '400.00'], ['B', '600.00']]);
    const payments = [pay(['A'], '400.00'), pay(['A', 'B'], '600.00')];
    // The second payment alone (600) never equals its own covered sum (1,000) — only the GROUP
    // ties out. Requires the index to pull payment 1 into payment 2's component via core A.
    expect(reRow('A', '400.00', payments, amounts).status).toBe('matched');
    expect(reRow('B', '600.00', payments, amounts).status).toBe('matched');
  });

  it('a genuine double payment of the same RE → mismatch, overage visible', () => {
    const amounts = new Map([['A', '400.00']]);
    const r = reRow('A', '400.00', [pay(['A'], '400.00'), pay(['A'], '400.00')], amounts);
    expect(r.status).toBe('mismatch');
    expect(r.diff).toBe(400);
  });

  it('a genuinely short split → mismatch, not silently matched', () => {
    const amounts = new Map([['A', '2398.00']]);
    const r = reRow('A', '2398.00', [pay(['A'], '1000.00'), pay(['A'], '1000.00')], amounts);
    expect(r.status).toBe('mismatch');
    expect(r.diff).toBe(-398);
  });
});

describe('computeReRow unified documents (RE + MB + XS priced together)', () => {
  const pay = (reNumbers: string[], amount: string, billNos: string[] = []): ReReconPayment =>
    ({ reNumbers, billNos, amount, whtAmount: '' });

  it('one transfer paying RE + MB prices BOTH documents (RE6908047 regression)', () => {
    // 5,070.60 onto RE 4,440.60 + MB 9690009 (630.00) — the RE-only engine saw a false +630.
    const res = new Map([['6908047', '4440.60']]);
    const bills = new Map([['9690009', '630.00']]);
    const payments = [pay(['6908047'], '5070.60', ['9690009'])];
    const re = reRow('6908047', '4440.60', payments, res, true, bills);
    expect(re.status).toBe('matched');
    expect(re.paidGross).toBe(4440.6); // apportioned to its own share only
    const mb = reRow('9690009', '630.00', payments, res, true, bills);
    expect(mb.status).toBe('matched');
    expect(mb.paidGross).toBe(630);
  });

  it('XS docs price the same way via the registry map', () => {
    const bills = new Map([['XS6900342', '630.00']]);
    const r = reRow('XS6900342', '630.00', [pay([], '630.00', ['XS6900342'])], new Map(), true, bills);
    expect(r.status).toBe('matched');
  });

  it('an UNREGISTERED bill ref is an annotation — ignored, never freezes the group', () => {
    // Legacy free-text refs (Shopee ids, paper bills never entered) must not price or unprice.
    const res = new Map([['6908047', '4440.60']]);
    const r = reRow('6908047', '4440.60', [pay(['6908047'], '4440.60', ['SHOPEE12345'])], res, true, new Map());
    expect(r.status).toBe('matched'); // priced purely from the RE; the stray ref changed nothing
  });

  it('closed XS (clean-equivalent) + no payments → closed; open XS → unpaid', () => {
    const bills = new Map([['XS6900343', '1925.00']]);
    expect(reRow('XS6900343', '1925.00', [], new Map(), false, bills).status).toBe('closed');
    expect(reRow('XS6900343', '1925.00', [], new Map(), true, bills).status).toBe('unpaid');
  });
});

describe('computeReRow ยอดตามเอกสาร cap (declared document total limits a payment’s contribution)', () => {
  const twoRe = new Map<string, string>([['A', '400.00'], ['B', '600.00']]);
  const pay = (reNumbers: string[], amount: string, discExpected = ''): ReReconPayment =>
    ({ reNumbers, amount, whtAmount: '', discExpected });

  it('overpay with FIN-typed ยอดตามเอกสาร → matched, excess ignored (เด็นทาเนียร์ case)', () => {
    // 1,500 paid onto documents worth 1,000 — FIN declared 1,000; the +500 is เกิน-ledger money.
    const transfer = pay(['A', 'B'], '1500.00', '1000.00');
    const a = reRow('A', '400.00', [transfer], twoRe);
    const b = reRow('B', '600.00', [transfer], twoRe);
    expect(a.status).toBe('matched');
    expect(a.paidGross).toBe(400); // apportioned from the CAPPED contribution
    expect(b.status).toBe('matched');
    expect(b.paidGross).toBe(600);
  });

  it('cap + clean *** flag → closed (resolved overpays retire fully)', () => {
    const transfer = pay(['A', 'B'], '1500.00', '1000.00');
    expect(reRow('A', '400.00', [transfer], twoRe, false).status).toBe('closed');
  });

  it('the cap never RAISES a short payment — underpay still alarms', () => {
    const short = pay(['A'], '300.00', '400.00'); // FIN declared 400 but only 300 arrived
    const r = reRow('A', '400.00', [short], new Map([['A', '400.00']]));
    expect(r.status).toBe('mismatch');
    expect(r.diff).toBe(-100);
  });

  it('blank ยอดตามเอกสาร → no cap (raw paid, unchanged behavior)', () => {
    const r = reRow('A', '400.00', [pay(['A'], '500.00', '')], new Map([['A', '400.00']]));
    expect(r.status).toBe('mismatch');
    expect(r.diff).toBe(100);
  });
});

describe('computeReRow ปิดใน Express (clean *** flag = Express already got the money)', () => {
  const oneRe = new Map<string, string>([['A', '400.00']]);
  const pay = (reNumbers: string[], amount: string, whtAmount = ''): ReReconPayment => ({ reNumbers, amount, whtAmount });

  it('clean + no Juno payments → closed (the pre-Pantheon backlog case)', () => {
    const r = reRow('A', '400.00', [], oneRe, false);
    expect(r.status).toBe('closed');
    expect(r.paymentCount).toBe(0);
  });

  it('*** + no payments → unpaid (the real chase queue)', () => {
    expect(reRow('A', '400.00', [], oneRe, true).status).toBe('unpaid');
  });

  it('clean + matched payments → closed (จับ RE แล้ว advances at the next import)', () => {
    const r = reRow('A', '400.00', [pay(['A'], '400.00')], oneRe, false);
    expect(r.status).toBe('closed');
    expect(r.paidGross).toBe(400);
  });

  it('*** + matched payments → matched (money in Juno, Express entry not finished)', () => {
    expect(reRow('A', '400.00', [pay(['A'], '400.00')], oneRe, true).status).toBe('matched');
  });

  it('clean + genuinely mismatched payments → mismatch wins over closed (never silenced)', () => {
    const r = reRow('A', '400.00', [pay(['A'], '300.00')], oneRe, false);
    expect(r.status).toBe('mismatch');
    expect(r.diff).toBe(-100);
  });

  it('clean + unpriceable group (co-receipt missing) → closed, Express is authoritative', () => {
    const r = reRow('A', '400.00', [pay(['A', 'C'], '1000.00')], oneRe, false);
    expect(r.status).toBe('closed');
    expect(r.paymentCount).toBe(1);
  });

  it('omitted flag defaults to *** semantics (legacy callers unchanged)', () => {
    expect(reRow('A', '400.00', [], oneRe).status).toBe('unpaid');
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
