// Automatic overpay-credit disc-confirm — owner ruling 2026-07-21: for overpays, the CEO's
// re-upload of a clean Express RE file IS his acceptance. Today an OVERPAY case requires FIN to
// record a resolution (POST /disc-resolve, default เก็บเป็นเครดิตรอบหน้า = 'credit') and the CEO
// to confirm (POST /disc-confirm) before the customer's credit is actually granted (grantCredit +
// netPendingUseCredit). This sweep automates the CEO's confirm — and, when FIN left the
// resolution blank, the resolve too — the moment ALL of the following are true:
//
//   1. FIN HAS DECLARED A CASE: either the resolution is already 'credit' (disc-resolve pressed
//      explicitly), or it is blank WITH a typed ยอดตามเอกสาร (discExpected) — the system never
//      invents a resolution FIN never touched (2026-07-19 manual-create ruling). A blank
//      resolution + typed discExpected auto-resolves to 'credit' (disc-resolve's own default)
//      before confirming.
//   2. MONEY GROUNDED — the identical gate the manual /disc-confirm route enforces via
//      discrepancyConfirmGate: transfer/slip → at least one linked bank line (or already
//      reconciled); cash/cheque → CEO's ได้รับแล้ว (receivedAt); credit-source → always grounded.
//   3. EXPRESS EVIDENCE: every RE the payment carries is imported AND clean (no ***) — mirrors
//      autoRecord.ts's rule exactly. Payments carrying ONLY MB/XS documents have no Express side
//      at all, so grounding alone suffices (same option-1 reasoning as autoRecord).
//   4. A CUSTOMER TO CREDIT: customerCreditKey(payment) must be truthy — a grant needs someone to
//      attach to; no key, no auto-grant, the row just stays in the queue for a human.
//   5. STRICT OVERPAY: the live discrepancy (getDiscrepancyForPayment) must show diffSatang > 0 at
//      confirm time — underpays and exactly-balanced rows are left for FIN, same as the manual
//      route's credit_overpay_required gate.
//
// Refund / chase / writeoff / use_credit resolutions NEVER auto-confirm — only 'credit' grants
// money the payment doesn't otherwise owe anyone; the other resolutions stay human-only.
//
// Idempotent — call it after any event that could change the inputs (RE import, bank import/
// automatch, manual link, receive, disc-resolve). A second run finds nothing (discConfirmedAt is
// now set). Per-payment try/catch: one bad row (e.g. a locked/already-spent grant) must never
// kill the sweep for the rest of the queue.

import { prisma } from '../db/prisma.js';
import { getDiscrepancyForPayment } from './discrepancy.js';
import {
  customerCreditKey,
  discrepancyConfirmGate,
  grantCredit,
  lockPayment,
  netPendingUseCredit,
} from './customerCredit.js';

// Shows in the UI's discConfirmedBy / discResolvedBy fields for rows this sweep touched.
export const AUTO_DISC_CONFIRM_ACTOR = 'อัตโนมัติ';

export interface AutoDiscConfirmCandidate {
  reNumbers: string[];
  billNos: string[];
  discResolution: string;
  discExpected: string;
  source: string;
  receivedAt: Date | null;
  reconciled: boolean;
  bankMatchCount: number;
  customerCode: string;
  customerName: string;
}

/** Pure eligibility check — reClean maps RE core → true when imported AND no ***. */
export function isAutoDiscConfirmEligible(p: AutoDiscConfirmCandidate, reClean: Map<string, boolean>): boolean {
  // Only a declared-or-defaultable-to 'credit' resolution ever auto-confirms.
  if (p.discResolution !== '' && p.discResolution !== 'credit') return false;
  if (p.reNumbers.length === 0 && p.billNos.length === 0) return false; // nothing documented
  // FIN must have declared the case: either resolution already 'credit', or an explicit
  // ยอดตามเอกสาร to auto-default to 'credit' from — never invented (2026-07-19 ruling).
  if (p.discResolution === '' && !p.discExpected.trim()) return false;
  // Express evidence for every RE carried (vacuously true for MB/XS-only payments).
  for (const core of p.reNumbers) {
    if (reClean.get(core) !== true) return false;
  }
  // Money grounding — identical gate to the manual /disc-confirm route.
  const gate = discrepancyConfirmGate(
    { source: p.source, reconciled: p.reconciled, receivedAt: p.receivedAt },
    p.bankMatchCount,
  );
  if (gate) return false;
  // Credit needs someone to attach to.
  if (!customerCreditKey({ customerCode: p.customerCode, customerName: p.customerName })) return false;
  return true;
}

export interface AutoDiscConfirmResult {
  confirmed: number;
  paymentIds: string[];
}

export async function autoConfirmOverpayCredits(
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<AutoDiscConfirmResult> {
  const candidates = await prisma.payment.findMany({
    where: {
      status: { in: ['verified', 'recorded'] },
      wrongTransferAt: null,
      discConfirmedAt: null,
      discResolution: { in: ['', 'credit'] },
    },
    select: {
      id: true, source: true, receivedAt: true, reconciled: true,
      reNumbers: true, billNos: true, discResolution: true, discExpected: true,
      customerCode: true, customerName: true,
      bankMatches: { select: { bankTxnId: true } },
    },
  });
  if (candidates.length === 0) return { confirmed: 0, paymentIds: [] };

  const cores = [...new Set(candidates.flatMap((p) => p.reNumbers))];
  const receipts = cores.length
    ? await prisma.reReceipt.findMany({ where: { reNumber: { in: cores } }, select: { reNumber: true, notPosted: true } })
    : [];
  const reClean = new Map(receipts.map((r) => [r.reNumber, !r.notPosted]));

  const eligible = candidates.filter((p) =>
    isAutoDiscConfirmEligible({ ...p, bankMatchCount: p.bankMatches.length }, reClean));
  if (eligible.length === 0) return { confirmed: 0, paymentIds: [] };

  const now = new Date();
  const confirmedIds: string[] = [];
  for (const candidate of eligible) {
    try {
      // Its own transaction per candidate — one bad/racing row (lock contention, a grant already
      // spent, etc.) must never abort the rest of the sweep.
      const confirmed = await prisma.$transaction(async (tx) => {
        await lockPayment(tx, candidate.id);
        let current = await tx.payment.findUnique({ where: { id: candidate.id } });
        if (!current) return false;
        // Re-check everything dynamic — the row may have moved since the candidate query ran.
        if (current.status === 'void') return false;
        if (current.wrongTransferAt) return false;
        if (current.discConfirmedAt) return false;
        if (current.discResolution !== '' && current.discResolution !== 'credit') return false;
        if (current.discResolution === '' && !current.discExpected.trim()) return false;

        const d = await getDiscrepancyForPayment(tx, current.id);
        if (!d || d.diffSatang <= 0) return false; // strict overpay only — underpay/balanced skip

        if (current.discResolution === '') {
          // FIN left it blank with an explicit discExpected — auto-default to 'credit', the same
          // default disc-resolve itself uses. discNote is left untouched (not in this update).
          current = await tx.payment.update({
            where: { id: current.id },
            data: { discResolution: 'credit', discResolvedAt: now, discResolvedBy: AUTO_DISC_CONFIRM_ACTOR },
          });
        }

        // Mirrors the manual /disc-confirm route's credit branch exactly.
        const grant = await grantCredit(tx, current, d.diffSatang, AUTO_DISC_CONFIRM_ACTOR);
        await netPendingUseCredit(tx, grant.customerKey, AUTO_DISC_CONFIRM_ACTOR);

        await tx.payment.update({
          where: { id: current.id },
          data: { discConfirmedAt: now, discConfirmedBy: AUTO_DISC_CONFIRM_ACTOR },
        });
        return true;
      });
      if (confirmed) confirmedIds.push(candidate.id);
    } catch (err) {
      log?.error({ err, paymentId: candidate.id }, 'auto disc-confirm failed');
    }
  }

  return { confirmed: confirmedIds.length, paymentIds: confirmedIds };
}
