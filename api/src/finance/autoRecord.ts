// Automatic stage-4 (ยืนยันใน Express) — owner ruling 2026-07-19: the manual weekend press
// predates the *** discovery; now the evidence drives the stamp. A 'verified' payment advances
// to 'recorded' the moment BOTH are true:
//
//   1. MONEY GROUNDED (same conditions the manual confirm routes enforce):
//        transfer/slip  → at least one linked bank line
//        cash / cheque  → CEO's ได้รับแล้ว (receivedAt)
//        credit         → creditUsed recorded (mirrors POST /status's credit_required gate)
//   2. EXPRESS EVIDENCE: every RE the payment carries is imported AND clean (no ***) — i.e.
//        Express itself says those receipts are received and posted. Payments carrying ONLY
//        MB/XS documents have no Express side at all, so grounding alone suffices (owner
//        decision: option 1, auto-confirm at the grounding moment).
//
// Advancing fires the same side-effects as the manual paths: Jupiter income sync per payment
// (best-effort, logged) and expressConfirmedAt on bank lines whose linked payments are now all
// recorded. โอนเงินผิด rows never advance. The sweep is idempotent — call it after any event
// that could change the inputs (RE import, bank import/automatch, manual link, receive, verify).

import { prisma } from '../db/prisma.js';
import { syncPaymentToJupiter } from '../jupiter/sync.js';
import { num } from './reRecon.js';

export interface AutoRecordCandidate {
  source: string;
  receivedAt: Date | null;
  creditUsed: string;
  reNumbers: string[];
  billNos: string[];
  bankMatchCount: number;
}

/** Pure eligibility check — reClean maps RE core → true when imported AND no ***. */
export function isAutoRecordEligible(p: AutoRecordCandidate, reClean: Map<string, boolean>): boolean {
  if (p.reNumbers.length === 0 && p.billNos.length === 0) return false; // nothing documented
  // Express evidence for every RE carried (vacuously true for MB/XS-only payments).
  for (const core of p.reNumbers) {
    if (reClean.get(core) !== true) return false;
  }
  // Money grounding by channel.
  if (p.source === 'cash' || p.source === 'cheque') return p.receivedAt !== null;
  if (p.source === 'credit') return num(p.creditUsed) > 0;
  return p.bankMatchCount > 0;
}

export interface AutoRecordResult {
  advanced: number;
  paymentIds: string[];
}

export async function autoRecordEligible(log?: { error: (obj: unknown, msg: string) => void }): Promise<AutoRecordResult> {
  const candidates = await prisma.payment.findMany({
    where: { status: 'verified', wrongTransferAt: null },
    select: {
      id: true, source: true, receivedAt: true, creditUsed: true,
      reNumbers: true, billNos: true,
      bankMatches: { select: { bankTxnId: true } },
    },
  });
  if (candidates.length === 0) return { advanced: 0, paymentIds: [] };

  const cores = [...new Set(candidates.flatMap((p) => p.reNumbers))];
  const receipts = cores.length
    ? await prisma.reReceipt.findMany({ where: { reNumber: { in: cores } }, select: { reNumber: true, notPosted: true } })
    : [];
  const reClean = new Map(receipts.map((r) => [r.reNumber, !r.notPosted]));

  const eligible = candidates.filter((p) =>
    isAutoRecordEligible({ ...p, bankMatchCount: p.bankMatches.length }, reClean));
  if (eligible.length === 0) return { advanced: 0, paymentIds: [] };

  const now = new Date();
  const ids = eligible.map((p) => p.id);
  // status-guarded update: a racing manual confirm/void loses nothing — updateMany only moves
  // rows still 'verified'. verifiedById is left as the human who verified; the stamp is system.
  const updated = await prisma.payment.updateMany({
    where: { id: { in: ids }, status: 'verified', wrongTransferAt: null },
    data: { status: 'recorded', verifiedAt: now },
  });

  // Retire fully-settled bank lines from the recon queues, exactly like the manual confirms —
  // but per-line: only stamp a line once ALL its linked (non-โอนผิด) payments are recorded.
  const txnIds = [...new Set(eligible.flatMap((p) => p.bankMatches.map((m) => m.bankTxnId)))];
  for (const txnId of txnIds) {
    const open = await prisma.paymentBankMatch.count({
      where: { bankTxnId: txnId, payment: { wrongTransferAt: null, status: { notIn: ['recorded', 'void'] } } },
    });
    if (open === 0) {
      await prisma.bankTxn.updateMany({
        where: { id: txnId, expressConfirmedAt: null },
        data: { expressConfirmedAt: now },
      });
    }
  }

  for (const id of ids) {
    void syncPaymentToJupiter(id).catch((err) => log?.error({ err, paymentId: id }, 'jupiter sync failed (auto-record)'));
  }

  return { advanced: updated.count, paymentIds: ids };
}
