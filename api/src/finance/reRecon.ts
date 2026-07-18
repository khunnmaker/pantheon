// Pure, DB-free reconciliation math for the กระทบยอด RE tab (GET /api/juno/re).
//
// THE BUG THIS FIXES: a single bank transfer can pay several receipts at once — one Payment then
// carries `reNumbers = ['A','B',…]`. The old view added that Payment's WHOLE gross to EVERY RE it
// listed, so each RE looked fully/over-paid and every multi-RE transfer flipped to ⚠️ยอดไม่ตรง.
//
// THE MODEL (owner-decided money-of-record): apportion by each RE's OWN amount from the imported
// Express receipts (ReReceipt.amount). For a transfer covering [A,B] the EXPECTED total is
// ReReceipt[A].amount + ReReceipt[B].amount, and the transfer is ✅matched when its GROSS
// (Payment.amount + whtAmount) ≈ that sum. Each RE's own paid figure is then its apportioned slice
// of the real gross — which equals its ReReceipt amount when the transfer ties out (the normal
// case), and shows its proportional share of any shortfall/overage when it doesn't.
//
// Kept pure (no Prisma/Fastify) so the apportionment is unit-testable — see api/test/money.test.ts.

// Baht string → number. Mirrors the `num()` helper in routes/juno.ts (kept local so this stays a
// zero-dependency module the tests can import cheaply).
export function num(s: string): number {
  const n = parseFloat((s || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Full price of a payment = what the customer actually sent (net) + the tax they withheld. Mirrors
// grossOf() in routes/juno.ts; this is the figure that must equal the Express receipt total.
export function grossOf(p: { amount: string; whtAmount: string }): number {
  return num(p.amount) + num(p.whtAmount || '0');
}

export function effectivePaidOf(p: { amount: string; whtAmount: string; creditUsed?: string }): number {
  return grossOf(p) + num(p.creditUsed || '0');
}

// Rounding tolerance for the transfer↔receipts gross comparison. The receipt amounts are satang-
// exact, so the only drift is per-payment WHT rounding summed across a multi-RE transfer — a small
// tolerance absorbs that without masking a genuine short-/over-payment (those are far larger).
export const RE_MATCH_TOL_BAHT = 1;

export type ReReconStatus = 'unpaid' | 'matched' | 'mismatch';

export interface ReReconPayment {
  reNumbers: string[];
  amount: string;
  whtAmount: string;
  creditUsed?: string;
}

export interface ReRowResult {
  status: ReReconStatus;
  paidGross: number; // this RE's apportioned share of the covering transfer(s) — NOT the whole payment
  diff: number; // paidGross − this RE's own amount (≈0 when the transfer reconciles)
  paymentCount: number;
}

/**
 * Compute one กระทบยอด RE row.
 *
 * @param reAmount        this RE's own gross from Express (ReReceipt.amount, String baht)
 * @param payments        every non-void Payment whose reNumbers include this RE
 * @param reAmountByCore  ReReceipt.amount for EVERY covered RE core (so a multi-RE transfer can be
 *                        priced against the SUM of the receipts it pays, not just this one)
 *
 * Edge case — a covering transfer that references a co-receipt not yet imported (no ReReceipt row):
 * its expected total is unknowable, so we do NOT raise a false ⚠️mismatch. That RE stays in the
 * ⏳ "not reconciled" bucket (status 'unpaid') until the missing receipt is imported; paymentCount
 * still reflects that a transfer exists so the UI can show the "N รายการรับเงิน" hint.
 */
export function computeReRow(
  reAmount: string,
  payments: ReReconPayment[],
  reAmountByCore: Map<string, string>,
): ReRowResult {
  const own = num(reAmount);
  if (payments.length === 0) {
    return { status: 'unpaid', paidGross: 0, diff: Number((0 - own).toFixed(2)), paymentCount: 0 };
  }

  let paidGross = 0;
  let anyUnresolved = false;
  let allMatched = true;

  for (const p of payments) {
    let expected = 0;
    let allImported = true;
    for (const re of p.reNumbers) {
      const amt = reAmountByCore.get(re);
      if (amt === undefined) {
        allImported = false; // a receipt this transfer pays isn't imported yet
        continue;
      }
      expected += num(amt);
    }
    if (!allImported || expected <= 0) {
      anyUnresolved = true; // can't fully price this transfer — leave it unresolved, not mismatched
      continue;
    }
    const gross = effectivePaidOf(p);
    // apportion the real gross across the transfer's receipts, weighted by each receipt's amount →
    // this RE gets only its own share (double-count fix), and its share === its receipt amount when
    // the transfer ties out.
    paidGross += gross * (own / expected);
    if (Math.abs(gross - expected) > RE_MATCH_TOL_BAHT) allMatched = false;
  }

  paidGross = Number(paidGross.toFixed(2));
  const diff = Number((paidGross - own).toFixed(2));

  if (anyUnresolved) {
    return { status: 'unpaid', paidGross, diff, paymentCount: payments.length };
  }
  return { status: allMatched ? 'matched' : 'mismatch', paidGross, diff, paymentCount: payments.length };
}
