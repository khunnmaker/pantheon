import { Prisma } from '@prisma/client';
import type { Payment } from '@prisma/client';
import { prisma } from '../db/prisma.js';

// Jupiter Phase-1b — the deity sync feed. Mirrors real money already captured elsewhere in the
// suite INTO the group books (JupiterTxn) so the cockpit + close pack reflect reality instead of
// hand-typed rows. First source: Juno (money IN). Every synced row carries source='sync:juno' +
// sourceRef=<Payment.id>, so it is idempotent (a partial UNIQUE index on (source,sourceRef)
// WHERE source LIKE 'sync:%' is the DB backstop; upsert-by-find is the app-level guarantee).
//
// SCOPE (agreed): income + WHT now. Juno slips carry NO VAT (output VAT is on the RE/tax
// invoice, not the cash slip), so vatAmount stays "" until a later RE-date/VAT enrichment pass.
// All Juno money is Prominent's, so companyCode is always PROM.

const SOURCE = 'sync:juno';
const COMPANY = 'PROM';

// String baht → exact Decimal (or null for ""/garbage). Same parse convention as baht() in the
// accounting routes, but preserved as Decimal for the P2 ledger's exact arithmetic.
function dec(s: string | null | undefined): Prisma.Decimal | null {
  if (!s) return null;
  const cleaned = String(s).replace(/[,\s฿]/g, '');
  if (cleaned === '' || Number.isNaN(Number(cleaned))) return null;
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

// A recorded Payment → the JupiterTxn write payload (income for PROM). amount = the NET received
// (Juno's corrected model), whtAmount = the withheld slice; both mirrored into the Decimal shadow.
function paymentToTxn(p: Payment) {
  const net = p.amount || '';
  const wht = p.whtAmount || '';
  const re = p.reNumbers?.length ? `RE ${p.reNumbers.join('/')}` : '';
  return {
    companyCode: COMPANY,
    direction: 'income',
    // Accounting date: when it was checked/recorded (booked), falling back to when it arrived.
    // (A later pass can prefer the matched RE's receiptDate for exact tax-period placement.)
    date: p.verifiedAt ?? p.createdAt,
    party: p.receiptName || p.customerName || p.senderName || '',
    category: 'ขายสินค้า',
    amount: net,
    vatAmount: '',
    whtAmount: wht,
    note: [re, p.note].filter(Boolean).join(' · '),
    source: SOURCE,
    sourceRef: p.id,
    amountNum: dec(net),
    vatNum: null,
    whtNum: dec(wht),
  } satisfies Prisma.JupiterTxnUncheckedCreateInput;
}

// Idempotent upsert keyed on (source, sourceRef) — find-then-write (the partial unique index
// guards against a concurrent double-create). Never throws to the caller's flow.
async function upsertSynced(data: Prisma.JupiterTxnUncheckedCreateInput): Promise<void> {
  const existing = await prisma.jupiterTxn.findFirst({
    where: { source: data.source, sourceRef: data.sourceRef },
    select: { id: true },
  });
  if (existing) {
    await prisma.jupiterTxn.update({ where: { id: existing.id }, data });
  } else {
    await prisma.jupiterTxn.create({ data });
  }
}

// Live per-slip hook: call (fire-and-forget) after a payment's status changes. If it is now
// 'recorded' → upsert its JupiterTxn; if it left 'recorded' (void/undo) → remove the synced row
// so the books never carry income for an un-booked/void payment. Best-effort; caller ignores.
export async function syncPaymentToJupiter(paymentId: string): Promise<void> {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) return;
  if (p.status === 'recorded' && p.wrongTransferAt === null) {
    await upsertSynced(paymentToTxn(p));
  } else {
    await prisma.jupiterTxn.deleteMany({ where: { source: SOURCE, sourceRef: paymentId } });
  }
}

// Batch backfill/reconcile: make JupiterTxn's sync:juno rows exactly mirror the set of
// currently-'recorded' payments — upsert every recorded payment, and delete any leftover synced
// row whose payment is no longer recorded (voided/undone). Returns counts. Supervisor-triggered.
export async function syncAllJunoToJupiter(): Promise<{ synced: number; removed: number }> {
  const recorded = await prisma.payment.findMany({ where: { status: 'recorded', wrongTransferAt: null } });
  for (const p of recorded) await upsertSynced(paymentToTxn(p));

  const recordedIds = new Set(recorded.map((p) => p.id));
  const existing = await prisma.jupiterTxn.findMany({
    where: { source: SOURCE },
    select: { id: true, sourceRef: true },
  });
  const staleIds = existing.filter((t) => !recordedIds.has(t.sourceRef)).map((t) => t.id);
  if (staleIds.length) await prisma.jupiterTxn.deleteMany({ where: { id: { in: staleIds } } });

  return { synced: recorded.length, removed: staleIds.length };
}
