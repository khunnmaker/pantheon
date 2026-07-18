// Pure, DB-free reconciliation math for the กระทบยอด RE tab (GET /api/juno/re).
//
// THE MODEL (owner-decided money-of-record): payments and receipts form CONNECTED GROUPS via the
// RE numbers each payment carries (one transfer paying several REs, one RE split across several
// transfers — many-to-many both ways). A group ties out when the SUM of its payments' effective
// paid (net + WHT + credit used) equals the SUM of its receipts' Express amounts. Judging any
// smaller unit produces false alarms in both directions:
//   • per-payment (the old bug, round two): one RE paid by two half-transfers made EACH half look
//     short against the full receipt → false ⚠️ยอดไม่ตรง even though the halves summed exactly
//     (RE6907847, 2026-07-18). Same group semantics as the เกิน/ขาด engine (discrepancy.ts),
//     which already judged components — baht tolerance here, satang-exact there, deliberately
//     (see RE_MATCH_TOL_BAHT).
//   • per-RE whole-gross (the original double-count bug): adding a multi-RE transfer's WHOLE
//     gross to EVERY RE it lists made each look over-paid. Each RE reports only its apportioned
//     share: group paid × (own amount / group expected).
//
// 'closed' = ปิดใน Express / ปิดแล้ว, the terminal state. Express (or the in-app confirm for
// MB/XS) is AUTHORITATIVE (owner ruling 2026-07-19): a closed document is closed even when
// Juno's linked amounts disagree — the diff stays visible in the row detail, but ยอดไม่ตรง is
// a LIVE-document alarm only. (This supersedes the 07-18 "mismatch wins over closed" guard:
// real data showed clean-but-mismatched rows are settled history, not open cases.) `***` /
// unconfirmed = money not received yet → the live unpaid/matched/mismatch flow.
//
// Kept pure (no Prisma/Fastify) so the math is unit-testable — see api/test/money.test.ts.

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

// Rounding tolerance for the group paid↔expected comparison. The receipt amounts are satang-
// exact, so the only drift is per-payment WHT rounding summed across a group — a small tolerance
// absorbs that without masking a genuine short-/over-payment (those are far larger).
export const RE_MATCH_TOL_BAHT = 1;

export type ReReconStatus = 'unpaid' | 'matched' | 'mismatch' | 'closed';

export interface ReReconPayment {
  reNumbers: string[];
  // MB (9-lead) / XS / free-text refs from the ตรวจแล้ว chips. Entries found in the bill/XS
  // registry are priced documents; anything else is an annotation and ignored for pricing —
  // NEVER unpriceable, so legacy free-text refs can't freeze a group at ⏳ (doc-recon rule,
  // 2026-07-19: strictly additive over the RE-only engine).
  billNos?: string[];
  amount: string;
  whtAmount: string;
  creditUsed?: string;
  // FIN-typed ยอดตามเอกสาร (ก่อนหัก) from the ตรวจแล้ว dialog / เกิน-ขาด flow ('' = not declared).
  discExpected?: string;
}

export interface ReRowResult {
  status: ReReconStatus;
  paidGross: number; // this RE's apportioned share of its group's paid total — NOT any whole payment
  diff: number; // paidGross − this RE's own amount (≈0 when the group reconciles)
  paymentCount: number; // payments carrying THIS RE (not the whole group) — feeds "N รายการรับเงิน"
}

interface CoreVerdict {
  paid: number; // Σ effective paid across the whole connected group
  expected: number; // Σ receipt amounts across the group's RE cores (0 when unpriceable)
  priced: boolean; // every core in the group has an imported ReReceipt and expected > 0
  matched: boolean; // priced && |paid − expected| ≤ RE_MATCH_TOL_BAHT
  directCount: number; // payments whose reNumbers include this core
}

export interface ReReconIndex {
  byCore: Map<string, CoreVerdict>;
}

// A payment never contributes MORE to its receipts than the document total FIN declared on it
// (discExpected, "ยอดตามเอกสาร"): the excess of an overpay is เกิน/ขาด-ledger money (credit or
// refund, e.g. the เด็นทาเนียร์ ฿2.96M transfer whose +555k was a มัดจำ deposit) — not receipt
// money, so it must not keep the receipts ⚠️ forever after the discrepancy is handled. The cap
// only ever LOWERS a contribution: an underpaid document still alarms until real money (or spent
// credit) covers it. Blank/zero/unparseable discExpected = no declaration = raw paid.
function contributionOf(p: ReReconPayment): number {
  const paid = effectivePaidOf(p);
  const declared = (p.discExpected ?? '').trim();
  if (!declared) return paid;
  const cap = num(declared);
  if (cap <= 0) return paid;
  return Math.min(paid, cap);
}

/**
 * Group every payment into connected components (union-find over shared RE cores) and precompute
 * each core's verdict. Build ONCE from ALL candidate payments — a component can reach payments
 * that never mention a given RE directly (A's second transfer also paying B pulls B's payments
 * into A's group), so a per-RE payment list cannot see the full picture.
 */
export function buildReReconIndex(
  payments: ReReconPayment[],
  reAmountByCore: Map<string, string>,
  // Registered MB/XS documents: key = the exact Payment.billNos value (e.g. "9690009",
  // "XS6900342"), value = the document's own total. Key spaces can't collide with RE cores
  // (RE = 7 digits not starting 9; MB = 9-lead; XS = XS-prefixed).
  billAmountByNo: Map<string, string> = new Map(),
): ReReconIndex {
  const docRefsOf = (p: ReReconPayment): string[] => [
    ...p.reNumbers,
    ...(p.billNos ?? []).filter((b) => billAmountByNo.has(b)),
  ];
  const parent = payments.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const coreFirstPayment = new Map<string, number>();
  payments.forEach((p, i) => {
    for (const core of docRefsOf(p)) {
      const first = coreFirstPayment.get(core);
      if (first === undefined) coreFirstPayment.set(core, i);
      else union(first, i);
    }
  });

  const compPaid = new Map<number, number>();
  const compCores = new Map<number, Set<string>>();
  payments.forEach((p, i) => {
    const root = find(i);
    compPaid.set(root, (compPaid.get(root) ?? 0) + contributionOf(p));
    let cores = compCores.get(root);
    if (!cores) {
      cores = new Set();
      compCores.set(root, cores);
    }
    for (const core of docRefsOf(p)) cores.add(core);
  });

  const byCore = new Map<string, CoreVerdict>();
  for (const [core, first] of coreFirstPayment) {
    const root = find(first);
    const cores = compCores.get(root)!;
    let expected = 0;
    let allImported = true;
    for (const c of cores) {
      const amt = reAmountByCore.get(c) ?? billAmountByNo.get(c);
      if (amt === undefined) {
        allImported = false; // an RE this group pays isn't imported yet — can't price the group
        break;
      }
      expected += num(amt);
    }
    const paid = compPaid.get(root) ?? 0;
    const priced = allImported && expected > 0;
    byCore.set(core, {
      paid,
      expected: priced ? expected : 0,
      priced,
      matched: priced && Math.abs(paid - expected) <= RE_MATCH_TOL_BAHT,
      directCount: 0,
    });
  }
  for (const p of payments) {
    for (const core of docRefsOf(p)) {
      const v = byCore.get(core);
      if (v) v.directCount += 1;
    }
  }
  return { byCore };
}

/**
 * Compute one กระทบยอด RE row from the prebuilt index.
 *
 * @param reCore     this RE's bare 7-digit core (ReReceipt.reNumber)
 * @param reAmount   this RE's own gross from Express (ReReceipt.amount, String baht)
 * @param index      buildReReconIndex over ALL candidate payments
 * @param notPosted  the RE's *** flag from the import. Clean (false) = Express already has the
 *                   money → terminal 'closed', except when the group genuinely mismatches.
 *                   Defaults to true so ***-era callers/tests keep the live-flow semantics.
 *
 * Unpriceable group (a co-receipt not imported yet): its expected total is unknowable, so we do
 * NOT raise a false ⚠️mismatch. A *** RE stays ⏳'unpaid' until the missing receipt is imported
 * (a clean RE still closes — Express is authoritative and there is no priced contradiction);
 * paymentCount still shows a transfer exists so the UI can render the "N รายการรับเงิน" hint.
 */
export function computeReRow(
  reCore: string,
  reAmount: string,
  index: ReReconIndex,
  notPosted = true,
): ReRowResult {
  const own = num(reAmount);
  const v = index.byCore.get(reCore);
  if (!v || v.directCount === 0) {
    return { status: notPosted ? 'unpaid' : 'closed', paidGross: 0, diff: Number((0 - own).toFixed(2)), paymentCount: 0 };
  }
  if (!v.priced) {
    return { status: notPosted ? 'unpaid' : 'closed', paidGross: 0, diff: Number((0 - own).toFixed(2)), paymentCount: v.directCount };
  }
  // apportion the group's real paid total across its receipts, weighted by each receipt's amount →
  // this RE gets only its own share, which equals its receipt amount when the group ties out.
  const paidGross = Number((v.paid * (own / v.expected)).toFixed(2));
  const diff = Number((paidGross - own).toFixed(2));
  if (!v.matched) {
    // ยอดไม่ตรง is a live-document alarm only — a closed document stays closed (Express /
    // the in-app confirm is authoritative); the diff remains in the payload for the detail view.
    return { status: notPosted ? 'mismatch' : 'closed', paidGross, diff, paymentCount: v.directCount };
  }
  return { status: notPosted ? 'matched' : 'closed', paidGross, diff, paymentCount: v.directCount };
}
