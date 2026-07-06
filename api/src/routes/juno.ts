import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp, requireRole } from '../auth/middleware.js';
import { parseKbiz } from '../bank/parseKbiz.js';
import { parseKshop } from '../bank/parseKshop.js';
import { makeUniqueDedupeKeys } from '../bank/dedupe.js';
import { paymentTimestamp, amountsEqual, dayDistance, nameSimilarity } from '../bank/match.js';
import type { BankSource, ParsedBankRow } from '../bank/types.js';
import { BankParseError } from '../bank/types.js';
import { readStaffUploadFile, readStaffUploadMeta, UPLOAD_ID_RE } from '../line/staffUploads.js';
import { readSlipFromBuffer } from '../llm/readSlip.js';

// Juno finance API. Reads the Payment table (written by Minerva's /to-finance hook) and
// owns the finance lifecycle: verify → record, flag-queue triage, tax-invoice tracking,
// and reporting/export. INCOME / LINE-slip only for the MVP. Access = requireApp('juno'):
// supervisor (Dr. M) + any employee granted 'juno' (the Finance team — Benz/Meow). See JUNO_BRIEF.md.
//
// PHASE B (see JUNO_PROCESS_BRIEF.md): bank import (KBIZ + K SHOP) + reconciliation
// against checked (RE-carrying) Payments. Owner downloads both files every Wed/Sat;
// Wed/Sat export ranges overlap by design (re-importing the same bank line is a no-op,
// counted as `dup` via dedupeKey) — see the /bank/import/* routes below.

// Lifecycle Juno owns. `flagged` is a SEPARATE boolean (the flag queue), independent of status.
const STATUSES = ['received', 'verified', 'recorded', 'void'] as const;
const TAX_STATUSES = ['none', 'requested', 'issued'] as const;

// All finance day-math is Thai business time (UTC+7) regardless of server TZ.
const TH_OFFSET_MS = 7 * 3600 * 1000;
const thaiDayKey = (d: Date): string => new Date(d.getTime() + TH_OFFSET_MS).toISOString().slice(0, 10);
// "YYYY-MM-DD" (from the UI date inputs) → an inclusive UTC instant range for the Thai day.
function thaiDayRange(from?: string, to?: string): { gte?: Date; lte?: Date } | null {
  const range: { gte?: Date; lte?: Date } = {};
  if (from) { const d = new Date(`${from}T00:00:00+07:00`); if (!Number.isNaN(d.getTime())) range.gte = d; }
  if (to)   { const d = new Date(`${to}T23:59:59.999+07:00`); if (!Number.isNaN(d.getTime())) range.lte = d; }
  return range.gte || range.lte ? range : null;
}

// A parsed baht number for summing/sorting; free-text/blank amounts → 0.
function num(s: string): number {
  const n = parseFloat((s || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// The row shape the Juno UI consumes (the stored Payment plus a couple of derived fields).
function toRow(p: {
  id: string; customerId: string | null; customerCode: string; customerName: string;
  senderName: string; amount: string; ocrAmount: string; bank: string; transferAt: string;
  ref: string; slipMessageId: string | null; slipUrl: string; taxInvoice: string;
  taxInvoiceStatus: string; salesAgentId: string | null; salesName: string; note: string;
  status: string; flagged: boolean; verifiedById: string | null; verifiedAt: Date | null;
  createdAt: Date; reNumber: string; reNumbers: string[]; receiptName: string; customerType: string;
  source: string; settleState: string; settledAt: Date | null;
  receivedAt: Date | null; receivedBy: string | null;
  chequeNo: string; chequeBank: string; chequeDueDate: string;
}) {
  return {
    id: p.id,
    customerId: p.customerId,
    customerCode: p.customerCode,
    customerName: p.customerName,
    senderName: p.senderName,
    amount: p.amount,
    amountNum: num(p.amount),
    ocrAmount: p.ocrAmount,
    bank: p.bank,
    transferAt: p.transferAt,
    ref: p.ref,
    slipMessageId: p.slipMessageId,
    slipUrl: p.slipUrl,
    taxInvoice: p.taxInvoice,
    taxInvoiceStatus: p.taxInvoiceStatus,
    salesName: p.salesName,
    note: p.note,
    status: p.status,
    flagged: p.flagged,
    verifiedById: p.verifiedById,
    verifiedAt: p.verifiedAt ? p.verifiedAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
    // does the confirmed amount differ from what the OCR read? (the fraud/error signal)
    mismatch: !!p.ocrAmount && p.ocrAmount !== p.amount,
    // FIN's check data (see POST /payments/:id/verify — the only route that sets these).
    // reNumber is the DEPRECATED join mirror; reNumbers is the real (list) source of truth.
    reNumber: p.reNumber,
    reNumbers: p.reNumbers,
    receiptName: p.receiptName,
    customerType: p.customerType,
    // how the row was created + cash/cheque banking state (see JUNO_MANUAL_ENTRY_BRIEF.md)
    source: p.source,
    settleState: p.settleState,
    settledAt: p.settledAt ? p.settledAt.toISOString() : null,
    // CEO receipt-verify gate (task 1) — SEPARATE from settleState/settledAt above. See
    // POST /payments/:id/receive.
    receivedAt: p.receivedAt ? p.receivedAt.toISOString() : null,
    receivedBy: p.receivedBy,
    chequeNo: p.chequeNo,
    chequeBank: p.chequeBank,
    chequeDueDate: p.chequeDueDate,
  };
}

// Shared filter schema + where-builder for GET /payments and GET /export.csv, so the two
// routes can never drift on which filters (in particular `q`, the search box) apply.
const listFilterSchema = z.object({
  q: z.string().max(120).optional(),
  status: z.enum(['all', ...STATUSES]).optional(),
  flagged: z.enum(['0', '1']).optional(),
  tax: z.enum(['all', ...TAX_STATUSES]).optional(),
  noVoid: z.enum(['0', '1']).optional(),   // Reports CSV: exclude voids to match the on-screen report
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  // 'transfer' = line + manual_transfer (reconciles in กระทบยอด); 'cashcheque' = cash + cheque
  // (verified in the เงินสด/เช็ค tab); a concrete value narrows to exactly that source.
  source: z.enum(['all', 'transfer', 'cashcheque', 'line', 'manual_transfer', 'cash', 'cheque']).optional(),
  // CEO-only "รอยืนยันรับเงิน" tab (task 1): unconfirmed cash/cheque. Forces its own
  // source/receivedAt/status filter and ignores status/source below — see buildListWhere.
  pendingReceive: z.enum(['true']).optional(),
});
function buildListWhere(q: z.infer<typeof listFilterSchema>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const pendingReceive = q.pendingReceive === 'true';
  if (pendingReceive) {
    // "รอยืนยันรับเงิน" is a fixed queue — force source/receivedAt/status and ignore the
    // status/source dropdowns below entirely (the frontend never sends them alongside it).
    where.source = { in: ['cash', 'cheque'] };
    where.receivedAt = null;
    where.status = { not: 'void' };
  } else if (q.status && q.status !== 'all') where.status = q.status;
  else if (q.noVoid === '1') where.status = { not: 'void' };
  if (q.flagged === '1') where.flagged = true;
  if (q.tax && q.tax !== 'all') where.taxInvoiceStatus = q.tax;
  // flag/tax queues exclude voided rows to match the summary badges (§7a)
  if ((q.flagged === '1' || (q.tax && q.tax !== 'all')) && !where.status) where.status = { not: 'void' };
  if (pendingReceive) {
    // already forced above — skip the source dropdown entirely for this queue.
  } else if (q.source === 'transfer') where.source = { in: ['line', 'manual_transfer'] };
  else if (q.source === 'cashcheque') where.source = { in: ['cash', 'cheque'] };
  else if (q.source && q.source !== 'all') where.source = q.source;
  const range = thaiDayRange(q.from, q.to);
  if (range) where.createdAt = range;
  const term = q.q?.trim();
  if (term) {
    // typing "RE6900123" should find the bare-digit reNumber "6900123" too
    const reTerm = /^re\d+/i.test(term) ? term.replace(/^re/i, '') : term;
    where.OR = [
      { customerName: { contains: term, mode: 'insensitive' } },
      { customerCode: { contains: term, mode: 'insensitive' } },
      { senderName: { contains: term, mode: 'insensitive' } },
      { ref: { contains: term, mode: 'insensitive' } },
      { bank: { contains: term, mode: 'insensitive' } },
      { salesName: { contains: term, mode: 'insensitive' } },
      { amount: { contains: term } },
      { reNumber: { contains: reTerm } },
    ];
  }
  return where;
}

// ── Bank import staging (preview → apply), mirrors Vulcan's stock import pattern ──
// (see stock.ts) — the manager previews a parsed file, eyeballs the diff, then applies the
// EXACT parsed set (server-authoritative; the client can't re-send tampered rows). Lost on
// restart (harmless: just re-upload). Small + short-lived.
interface StagedBankImport {
  source: BankSource;
  fileName: string;
  rows: ParsedBankRow[];
  dedupeKeys: string[]; // 1:1 with rows
  isNew: boolean[]; // 1:1 with rows — precomputed at preview time
  excluded: number;
  parsed: number;
  periodFrom: Date | null;
  periodTo: Date | null;
  at: number;
}
const BANK_PREVIEW_TTL_MS = 30 * 60 * 1000;
const bankPreviews = new Map<string, StagedBankImport>();
function stashBankPreview(s: StagedBankImport): string {
  const now = Date.now();
  for (const [k, v] of bankPreviews) if (now - v.at > BANK_PREVIEW_TTL_MS) bankPreviews.delete(k);
  while (bankPreviews.size >= 10) bankPreviews.delete(bankPreviews.keys().next().value as string);
  const token = randomUUID();
  bankPreviews.set(token, s);
  return token;
}

// house-String baht formatting for the txn row shape (matches Payment.amount convention).
function txnAmountNum(amount: string): number {
  const n = parseFloat((amount || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// The row shape the Recon UI consumes for a bank line, incl. its linked-payment summaries.
function toBankTxnRow(
  t: {
    id: string; source: string; txnAt: Date; amount: string; direction: string; channel: string;
    description: string; details: string; payerName: string; payerBank: string; matchStatus: string;
    refText: string; expressConfirmedAt: Date | null; expressConfirmedById: string | null;
  },
  links: { paymentId: string; reNumber: string; receiptName: string; customerName: string; amount: string }[] = [],
) {
  const linkedSum = links.reduce((s, l) => s + txnAmountNum(l.amount), 0);
  return {
    id: t.id,
    source: t.source,
    txnAt: t.txnAt.toISOString(),
    amount: t.amount,
    amountNum: txnAmountNum(t.amount),
    direction: t.direction,
    channel: t.channel,
    description: t.description,
    details: t.details,
    payerName: t.payerName,
    payerBank: t.payerBank,
    matchStatus: t.matchStatus,
    refText: t.refText,
    expressConfirmedAt: t.expressConfirmedAt ? t.expressConfirmedAt.toISOString() : null,
    expressConfirmedById: t.expressConfirmedById,
    links: links.map((l) => ({ paymentId: l.paymentId, reNumber: l.reNumber, receiptName: l.receiptName, customerName: l.customerName, amount: l.amount })),
    linkedSum,
    sumDelta: links.length ? Number((linkedSum - txnAmountNum(t.amount)).toFixed(2)) : null,
  };
}

// Recompute + persist a BankTxn's matchStatus from its current link count + refText.
// unmatched only when BOTH no links exist AND refText is empty (spec §B3 /unmatch).
async function recomputeTxnMatchStatus(bankTxnId: string): Promise<void> {
  const [linkCount, txn] = await Promise.all([
    prisma.paymentBankMatch.count({ where: { bankTxnId } }),
    prisma.bankTxn.findUnique({ where: { id: bankTxnId }, select: { refText: true } }),
  ]);
  const matched = linkCount > 0 || !!txn?.refText;
  await prisma.bankTxn.update({ where: { id: bankTxnId }, data: { matchStatus: matched ? 'matched' : 'unmatched' } });
}

// Recompute + persist a Payment's denormalized `reconciled` flag from its current link count.
async function recomputePaymentReconciled(paymentId: string): Promise<void> {
  const linkCount = await prisma.paymentBankMatch.count({ where: { paymentId } });
  await prisma.payment.update({ where: { id: paymentId }, data: { reconciled: linkCount > 0 } });
}

// A KBiz credit line is a cheque deposit when its Description is exactly "Cheque Deposit",
// or its Details name a cheque number (some rows carry the number only in Details).
function isChequeDeposit(t: { description: string; details: string }): boolean {
  return t.description.trim() === 'Cheque Deposit' || /cheque no\.?/i.test(t.details);
}
// Pull the cheque number token out of a "… Cheque No. 0001234 …" Details string ('' if none).
function extractChequeNo(t: { details: string }): string {
  return t.details.match(/Cheque No\.?\s*(\S+)/i)?.[1] ?? '';
}
// Canonical cheque-number key: digits only, no leading zeros ('' if nothing survives) — so
// "0001234", "1234", and "No.1234" all compare equal across the bank line and the payment.
function normChq(s: string): string {
  return s.replace(/\D/g, '').replace(/^0+/, '');
}

// The auto-matcher (see spec B3): runs in TWO passes over the in-scope unmatched "in" lines.
//   Pass 1 (cheque): a KBiz "Cheque Deposit … Cheque No. N" line is matched to its hand-added
//     cheque Payment by cheque number + amount, and that payment is auto-set settleState
//     'cleared' (เคลียร์แล้ว) — the settling FIN used to do by hand.
//   Pass 2 (generic): the amount + day-window match for every OTHER credit line ↔ Payment
//     status='verified', not void, reconciled=false (cheque-deposit lines and source='cheque'
//     payments are excluded here — a cheque can ONLY clear via its number, never by amount).
// Both passes link ONLY when the pairing is unambiguous in BOTH directions (exactly one
// candidate each way) — everything else is left for the UI's ranked suggestions. Runs over a
// specific set of new txn ids (import apply) or ALL unmatched in-txns (manual re-run via
// /bank/automatch). createdById is left null on every link this function creates — a
// deliberate marker distinguishing "the system auto-matched this" from a FIN-driven manual
// match (POST /match, which stamps req.agent.id). Returns both link counts.
async function runAutoMatcher(txnIds?: string[]): Promise<{ matched: number; chequesCleared: number }> {
  // Ambiguity is judged against ALL unmatched in-lines, not just the ones this run may link:
  // an import-scoped run would otherwise miss that an OLDER unmatched line is an equally
  // plausible home for the payment, and link the new line with false confidence.
  const [allTxns, payments, chequePayments] = await Promise.all([
    prisma.bankTxn.findMany({
      where: { direction: 'in', matchStatus: 'unmatched' },
    }),
    prisma.payment.findMany({
      where: { status: 'verified', reconciled: false, source: { not: 'cheque' } },
      select: { id: true, amount: true, transferAt: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: { source: 'cheque', reconciled: false, status: { not: 'void' } },
      select: { id: true, amount: true, chequeNo: true },
    }),
  ]);
  const linkTargets = txnIds ? new Set(txnIds) : null;
  const linkable = linkTargets ? allTxns.filter((t) => linkTargets.has(t.id)) : allTxns;
  if (!linkable.length) return { matched: 0, chequesCleared: 0 };

  // ── Pass 1: cheques ──────────────────────────────────────────────────────
  // Match cheque-deposit lines to cheque payments by cheque number + amount, unambiguous
  // BOTH ways (exactly one candidate txn ↔ one candidate payment), computed over ALL
  // unmatched cheque-deposit lines so an older line is seen as an equally plausible home.
  // Linking auto-clears the payment (settleState 'cleared'). Track the linked txn ids so the
  // generic pass skips them (its own filter also drops every cheque-deposit line regardless).
  const chequeMatchedTxnIds = new Set<string>();
  const chequeMatchedPaymentIds = new Set<string>();
  let chequesCleared = 0;
  if (chequePayments.length) {
    const chequeTxnCandidates = new Map<string, string[]>();
    const chequePaymentCandidates = new Map<string, string[]>();
    for (const t of allTxns) {
      if (!isChequeDeposit(t)) continue;
      const key = normChq(extractChequeNo(t));
      if (!key) continue; // no readable cheque number on the line → can't match by number
      const matches: string[] = [];
      for (const p of chequePayments) {
        if (normChq(p.chequeNo) !== key) continue;
        if (!amountsEqual(t.amount, p.amount)) continue;
        matches.push(p.id);
      }
      chequeTxnCandidates.set(t.id, matches);
      for (const pid of matches) chequePaymentCandidates.set(pid, [...(chequePaymentCandidates.get(pid) ?? []), t.id]);
    }

    for (const t of linkable) {
      const matches = chequeTxnCandidates.get(t.id) ?? [];
      if (matches.length !== 1) continue; // ambiguous or no candidate on the txn side
      const pid = matches[0];
      if ((chequePaymentCandidates.get(pid) ?? []).length !== 1) continue; // ambiguous on the payment side too
      await prisma.$transaction([
        prisma.paymentBankMatch.create({ data: { paymentId: pid, bankTxnId: t.id, createdById: null } }),
        prisma.bankTxn.update({ where: { id: t.id }, data: { matchStatus: 'matched' } }),
        // the auto-clear: link + reconcile + settleState 'cleared' (เคลียร์แล้ว)
        prisma.payment.update({ where: { id: pid }, data: { reconciled: true, settleState: 'cleared', settledAt: new Date(), settledById: null } }),
      ]);
      chequeMatchedTxnIds.add(t.id);
      chequeMatchedPaymentIds.add(pid);
      chequesCleared++;
    }
  }

  // ── Pass 2: generic amount + day-window ───────────────────────────────────
  // Excludes cheque-deposit lines and anything the cheque pass already linked; the payment
  // pool already excludes source='cheque' (a cheque must never amount-match a transfer line).
  const genericTxns = allTxns.filter((t) => !isChequeDeposit(t) && !chequeMatchedTxnIds.has(t.id));
  const genericLinkable = linkable.filter((t) => !isChequeDeposit(t) && !chequeMatchedTxnIds.has(t.id));
  let autoMatched = 0;
  if (genericLinkable.length && payments.length) {
    const paymentTimes = new Map(payments.map((p) => [p.id, paymentTimestamp(p.transferAt, p.createdAt)]));

    // candidates[txnId] = list of payment ids that pass the amount+day-window rule —
    // computed over ALL unmatched lines so both ambiguity checks see the full picture.
    const txnCandidates = new Map<string, string[]>();
    const paymentCandidates = new Map<string, string[]>();
    for (const t of genericTxns) {
      const matches: string[] = [];
      for (const p of payments) {
        if (!amountsEqual(t.amount, p.amount)) continue;
        if (dayDistance(t.txnAt, paymentTimes.get(p.id)!) > 3) continue;
        matches.push(p.id);
      }
      txnCandidates.set(t.id, matches);
      for (const pid of matches) paymentCandidates.set(pid, [...(paymentCandidates.get(pid) ?? []), t.id]);
    }

    for (const t of genericLinkable) {
      const matches = txnCandidates.get(t.id) ?? [];
      if (matches.length !== 1) continue; // ambiguous or no candidate on the txn side
      const pid = matches[0];
      if ((paymentCandidates.get(pid) ?? []).length !== 1) continue; // ambiguous on the payment side too
      await prisma.$transaction([
        prisma.paymentBankMatch.create({ data: { paymentId: pid, bankTxnId: t.id, createdById: null } }),
        prisma.bankTxn.update({ where: { id: t.id }, data: { matchStatus: 'matched' } }),
        prisma.payment.update({ where: { id: pid }, data: { reconciled: true } }),
      ]);
      autoMatched++;
    }
  }

  return { matched: autoMatched, chequesCleared };
}

export async function junoRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('juno'));

  // GET /api/juno/summary — headline counts for the Juno dashboard / login landing.
  app.get('/api/juno/summary', async () => {
    const [total, received, verified, recorded, flagged, taxRequested, cashChequePending, awaitingReceive] = await Promise.all([
      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'received' } }),
      prisma.payment.count({ where: { status: 'verified' } }),
      prisma.payment.count({ where: { status: 'recorded' } }),
      prisma.payment.count({ where: { flagged: true, status: { not: 'void' } } }),
      prisma.payment.count({ where: { taxInvoiceStatus: 'requested', status: { not: 'void' } } }),
      // เงินสด/เช็ค tab badge: hand-added cash/cheque rows not yet deposited/cleared.
      prisma.payment.count({ where: { source: { in: ['cash', 'cheque'] }, settleState: '', status: { not: 'void' } } }),
      // รอยืนยันรับเงิน tab badge (task 1): cash/cheque the CEO hasn't yet confirmed he
      // physically received — SEPARATE from cashChequePending above (that's the banking
      // deposit/clear state; this is the receipt-verify gate).
      prisma.payment.count({ where: { source: { in: ['cash', 'cheque'] }, receivedAt: null, status: { not: 'void' } } }),
    ]);
    return { total, received, verified, recorded, flagged, taxRequested, cashChequePending, awaitingReceive };
  });

  // GET /api/juno/payments?q=&status=&flagged=&tax=&from=&to=&limit=
  // The payments inbox: searchable, filterable table (replaces staring at the sheet).
  const paymentsQuerySchema = listFilterSchema.extend({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  app.get('/api/juno/payments', async (req, reply) => {
    const parsed = paymentsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    const where = buildListWhere(q);

    const rows = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 200,
    });
    return { payments: rows.map(toRow) };
  });

  // GET /api/juno/payments/:id — one payment (for the slip verifier detail pane).
  app.get<{ Params: { id: string } }>('/api/juno/payments/:id', async (req, reply) => {
    const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return { payment: toRow(p) };
  });

  // DELETE /api/juno/payments/:id — CEO-ONLY permanent hard delete. Contrast with
  // POST /status {status:'void'}, which only soft-deletes (the row stays, filterable back
  // in). This is the true "gone forever" override — supervisor only, not even md, so it is
  // gated EXPLICITLY here rather than relying on the plugin's requireApp('juno') hook (which
  // now also admits md since Juno access was widened). Any status is deletable; there is no
  // such thing as "too far along to delete" for the CEO override.
  app.delete<{ Params: { id: string } }>('/api/juno/payments/:id', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });

    const existing = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { id: true, bankMatches: { select: { bankTxnId: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    // Capture linked bank lines BEFORE deleting — PaymentBankMatch rows cascade-delete with
    // the Payment (schema onDelete: Cascade), so this is the last chance to know which
    // BankTxns need their matchStatus recomputed afterward.
    const linkedBankTxnIds = [...new Set(existing.bankMatches.map((m) => m.bankTxnId))];

    await prisma.payment.delete({ where: { id: req.params.id } });

    // A previously-matched bank line has just lost this link; it may now have zero links
    // left, in which case it must fall back to 'unmatched' — recomputeTxnMatchStatus already
    // knows to leave it 'matched' if another link or a manual refText still covers it.
    await Promise.all(linkedBankTxnIds.map((id) => recomputeTxnMatchStatus(id)));

    req.log.info({ paymentId: req.params.id, by: req.agent?.id }, 'payment hard-deleted');
    return { ok: true };
  });

  // POST /api/juno/payments { source, customerCode, customerName, amount, note?, senderName?,
  // bank?, transferAt?, ref?, slipUrl?, chequeNo?, chequeBank?, chequeDueDate?, taxInvoice? } —
  // FIN/CEO hand-add a payment that didn't arrive via Minerva's /to-finance LINE hook (see
  // JUNO_MANUAL_ENTRY_BRIEF.md decision 2). 'line' is NOT accepted here — that source is
  // Minerva-only. ocrAmount is left '' so the OCR-mismatch flag never fires on a manual row.
  // taxInvoice mirrors /to-finance: non-empty sets taxInvoiceStatus 'requested', else 'none'.
  const createPaymentBodySchema = z.object({
    source: z.enum(['manual_transfer', 'cash', 'cheque']),
    customerCode: z.string().max(40).default(''),
    customerName: z.string().max(200).default(''),
    amount: z.string().max(40),
    note: z.string().max(600).optional(),
    senderName: z.string().max(200).optional(),
    // transfer-only
    bank: z.string().max(120).optional(),
    transferAt: z.string().max(60).optional(),
    ref: z.string().max(80).optional(),
    slipUrl: z.string().max(500).optional(),
    // cheque-only
    chequeNo: z.string().max(60).optional(),
    chequeBank: z.string().max(120).optional(),
    chequeDueDate: z.string().max(60).optional(),
    // shared (all methods) — ใบกำกับภาษี captured off the slip/customer, mirrors /to-finance
    taxInvoice: z.string().max(600).optional(),
  });
  app.post('/api/juno/payments', async (req, reply) => {
    const body = createPaymentBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const amountNum = parseFloat(body.data.amount.trim());
    if (!Number.isFinite(amountNum) || amountNum <= 0) return reply.code(400).send({ error: 'invalid_amount' });

    const p = await prisma.payment.create({
      data: {
        source: body.data.source,
        customerCode: body.data.customerCode,
        customerName: body.data.customerName,
        amount: body.data.amount.trim(),
        note: body.data.note?.trim() ?? '',
        senderName: body.data.senderName?.trim() ?? '',
        bank: body.data.bank?.trim() ?? '',
        transferAt: body.data.transferAt?.trim() ?? '',
        ref: body.data.ref?.trim() ?? '',
        slipUrl: body.data.slipUrl?.trim() ?? '',
        chequeNo: body.data.chequeNo?.trim() ?? '',
        chequeBank: body.data.chequeBank?.trim() ?? '',
        chequeDueDate: body.data.chequeDueDate?.trim() ?? '',
        taxInvoice: body.data.taxInvoice?.trim() ?? '',
        taxInvoiceStatus: body.data.taxInvoice?.trim() ? 'requested' : 'none',
        status: 'received',
        salesAgentId: req.agent?.id,
        salesName: req.agent?.name ?? '', // the entering user, so reports attribute it correctly
      },
    });
    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/read-slip { uploadId } — OCR a staff-uploaded transfer slip (attached via
  // POST /api/uploads, see uploadSlip() in the Juno client) to prefill the โอนเงิน add-payment
  // form. Reuses Minerva's slip reader (readSlipFromBuffer) against the staff-upload store
  // instead of the LINE content store. Best-effort: empty fields are fine, staff fills the
  // rest manually. Nothing is persisted here — a manually-added row has no tamper-audit need
  // (contrast with /api/messages/:id/read-slip, which stores slipAmount server-side).
  const readSlipBodySchema = z.object({ uploadId: z.string().max(80) });
  app.post('/api/juno/read-slip', async (req, reply) => {
    const body = readSlipBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!UPLOAD_ID_RE.test(body.data.uploadId)) return reply.code(400).send({ error: 'invalid_upload_id' });

    const buf = await readStaffUploadFile(body.data.uploadId);
    if (!buf) return reply.code(404).send({ error: 'not_found' });
    const meta = await readStaffUploadMeta(body.data.uploadId);
    const contentType = meta?.contentType || 'image/jpeg';

    const fields = await readSlipFromBuffer(buf, contentType);
    return {
      amount: fields.amount,
      bank: fields.bank,
      transferAt: fields.transferAt,
      ref: fields.ref,
      senderName: fields.senderName,
    };
  });

  // POST /api/juno/payments/:id/settle { state } — cash/cheque banking state: cash goes
  // '' -> 'deposited' (ฝากธนาคารแล้ว), cheque goes '' -> 'cleared' (เคลียร์แล้ว). Only valid
  // for hand-added cash/cheque rows — transfers reconcile in กระทบยอด instead (decision 4).
  // future: a cheque could also auto-clear when a matching KBiz "Cheque Deposit … Cheque No. …"
  // line imports — not built now, left as a note for a later reconciliation pass.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/settle', async (req, reply) => {
    const body = z.object({ state: z.enum(['deposited', 'cleared', '']) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const cur = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, source: true } });
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.source !== 'cash' && cur.source !== 'cheque') return reply.code(409).send({ error: 'not_cash_cheque' });

    const settling = body.data.state !== '';
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        settleState: body.data.state,
        settledAt: settling ? new Date() : null,
        settledById: settling ? (req.agent?.id ?? null) : null,
      },
    });
    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/payments/:id/receive { received } — CEO-ONLY receipt-verify gate (task 1):
  // the CEO confirms he PHYSICALLY received the cash/cheque. SEPARATE from /settle above (the
  // banking deposit/clear state) — a cheque's KBiz auto-clear does NOT satisfy this; only this
  // route does. This is a hard prerequisite for ยืนยันใน Express (see POST /status below, which
  // 409s status->'recorded' for cash/cheque while receivedAt is null). received=false is the
  // undo path (ยกเลิกการยืนยัน), clearing the stamp — mirrors /settle's '' revert.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/receive', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });

    const body = z.object({ received: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const cur = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, source: true } });
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.source !== 'cash' && cur.source !== 'cheque') return reply.code(409).send({ error: 'not_cash_cheque' });

    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        receivedAt: body.data.received ? new Date() : null,
        receivedBy: body.data.received ? (req.agent?.email ?? null) : null,
      },
    });
    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/payments/:id/status { status } — advance the lifecycle.
  // Moving to recorded stamps who/when; received/void clear the stamps (a payment moved back
  // to received, or voided, must not still read as verified-by-someone). A voided payment is
  // locked — it must be explicitly restored to 'received' before re-verifying. 'verified' is
  // NOT reachable here — the check dialog (POST /verify) is the only path, since FIN must
  // supply the RE number; this route 409s that target so the UI is forced through the modal.
  // Task 1 gate: cash/cheque cannot reach 'recorded' (ยืนยันใน Express) until the CEO has
  // confirmed physical receipt (POST /payments/:id/receive) — transfers are unaffected.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/status', async (req, reply) => {
    const body = z.object({ status: z.enum(STATUSES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_status' });
    if (body.data.status === 'verified') return reply.code(409).send({ error: 'use_verify' });
    const cur = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, source: true, receivedAt: true },
    });
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.status === 'void' && body.data.status === 'recorded') {
      return reply.code(409).send({ error: 'void_locked' });
    }
    if (
      body.data.status === 'recorded' &&
      (cur.source === 'cash' || cur.source === 'cheque') &&
      cur.receivedAt === null
    ) {
      return reply.code(409).send({ error: 'received_required' });
    }
    const advancing = body.data.status === 'recorded';
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        status: body.data.status,
        ...(advancing
          ? { verifiedById: req.agent?.id ?? null, verifiedAt: new Date() }
          : { verifiedById: null, verifiedAt: null }),   // received/void clear the stamps
      },
    });
    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/payments/:id/verify { reNumbers, receiptName?, customerType? } — the ONLY
  // way to reach status 'verified'. FIN types the RE number(s) issued in Express here (one
  // transfer can pay several receipts, and one RE can be split across several payments — so
  // this is a list); re-opening the dialog on an already-verified payment is fine (re-verify
  // just updates fields + re-stamps).
  const customerTypeSchema = z.enum(['โอนก่อนส่ง', 'เครดิต', 'เก็บปลายทาง', '']).default('');
  const verifyBodySchema = z.object({
    reNumbers: z.array(z.string()).min(1).max(50),
    receiptName: z.string().max(200).optional(),
    customerType: customerTypeSchema.optional(),
  });
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/verify', async (req, reply) => {
    const body = verifyBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    // Normalize each: trim, strip a leading RE/re, require exactly 7 digits — store bare
    // digits. Dedupe preserving order. Any invalid token (or an empty result) 400s the whole
    // request — there is no such thing as "verify with a partially-valid RE list".
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of body.data.reNumbers) {
      const stripped = raw.trim().replace(/^re/i, '');
      if (!/^\d{7}$/.test(stripped)) return reply.code(400).send({ error: 'invalid_re' });
      if (!seen.has(stripped)) { seen.add(stripped); normalized.push(stripped); }
    }
    if (normalized.length === 0) return reply.code(400).send({ error: 'invalid_re' });

    const cur = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.status === 'void') return reply.code(409).send({ error: 'void_locked' });

    // Editing the check data on an already-recorded (ยืนยันใน Express) payment must NOT
    // demote it back to 'verified' or re-stamp — the owner's Express confirmation stands;
    // only the field values are refreshed.
    const keepRecorded = cur.status === 'recorded';
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        status: keepRecorded ? 'recorded' : 'verified',
        reNumbers: normalized,
        reNumber: normalized.join('/'), // deprecated join mirror — see schema comment
        receiptName: body.data.receiptName?.trim() ?? '',
        customerType: body.data.customerType ?? '',
        ...(keepRecorded ? {} : { verifiedById: req.agent?.id ?? null, verifiedAt: new Date() }),
      },
    });

    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/payments/:id/flag { flagged, note? } — raise/clear the flag queue.
  // Appends an optional finance note (keeps the sales-entered note intact) for the audit trail.
  // Atomic (single UPDATE) so two near-simultaneous flag notes can't clobber one another.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/flag', async (req, reply) => {
    const body = z.object({ flagged: z.boolean(), note: z.string().max(600).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    // "Solving" (clearing) a flag is CEO-only; finance may RAISE a flag but not resolve it.
    if (body.data.flagged === false && req.agent?.role !== 'supervisor') {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const extra = body.data.note?.trim();
    const tag = extra ? `[finance] ${extra}` : null;
    const updated = await prisma.$executeRaw`
      UPDATE "Payment"
      SET "flagged" = ${body.data.flagged},
          "note" = CASE WHEN ${tag}::text IS NULL THEN "note"
                        WHEN "note" = '' THEN ${tag}
                        ELSE "note" || E'\n' || ${tag} END
      WHERE "id" = ${req.params.id}`;
    if (updated === 0) return reply.code(404).send({ error: 'not_found' });
    const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
    return { ok: true, payment: toRow(p!) };
  });

  // POST /api/juno/payments/:id/tax-invoice { status } — track ใบกำกับภาษี requested → issued.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/tax-invoice', async (req, reply) => {
    const body = z.object({ status: z.enum(TAX_STATUSES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_status' });
    const exists = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: { taxInvoiceStatus: body.data.status },
    });
    return { ok: true, payment: toRow(p) };
  });

  // GET /api/juno/reports?from=&to=&groupBy=day|rep|bank|customer
  // Daily/monthly totals by rep / bank / customer for the reports view. Voided payments excluded.
  const reportsQuerySchema = z.object({
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    groupBy: z.enum(['day', 'rep', 'bank', 'customer']).optional(),
  });
  // Reports — CEO-only (finance staff do slip work + reconciliation, not reporting).
  app.get('/api/juno/reports', { preHandler: requireRole('supervisor') }, async (req, reply) => {
    const parsed = reportsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;

    const where: Record<string, unknown> = { status: { not: 'void' } };
    const range = thaiDayRange(q.from, q.to);
    if (range) where.createdAt = range;

    const rows = await prisma.payment.findMany({
      where,
      select: { amount: true, salesName: true, bank: true, customerName: true, customerCode: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const groupBy = q.groupBy ?? 'day';
    const buckets = new Map<string, { key: string; label: string; count: number; total: number }>();
    for (const r of rows) {
      let key = '';
      let label = '';
      if (groupBy === 'day') { key = thaiDayKey(r.createdAt); label = key; }
      else if (groupBy === 'rep') { key = r.salesName || '—'; label = r.salesName || '(ไม่ระบุ)'; }
      else if (groupBy === 'bank') { key = r.bank || '—'; label = r.bank || '(ไม่ระบุ)'; }
      else { key = r.customerCode || r.customerName || '—'; label = [r.customerCode, r.customerName].filter(Boolean).join(' ') || '(ไม่ระบุ)'; }
      const b = buckets.get(key) ?? { key, label, count: 0, total: 0 };
      b.count += 1;
      b.total += num(r.amount);
      buckets.set(key, b);
    }
    const groups = [...buckets.values()].sort((a, b) => (groupBy === 'day' ? b.key.localeCompare(a.key) : b.total - a.total));
    const grandTotal = rows.reduce((s, r) => s + num(r.amount), 0);
    return { groupBy, count: rows.length, grandTotal, groups };
  });

  // GET /api/juno/export.csv?q=&status=&flagged=&tax=&from=&to=&noVoid= — one-click sheet-style
  // export. Same filters as the inbox (shared buildListWhere so this can never drift from it
  // again). Excel-friendly (UTF-8 BOM so Thai renders in Excel).
  // CSV export — CEO-only.
  app.get('/api/juno/export.csv', { preHandler: requireRole('supervisor') }, async (req, reply) => {
    const parsed = listFilterSchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const where = buildListWhere(parsed.data);

    // Page through everything with a stable cursor — a plain `take: 5000` newest-first would
    // silently drop the OLDEST rows on a big export with no signal the file is partial.
    // Volumes are modest (tens/day) so memory is a non-issue for years.
    const rows = [] as Awaited<ReturnType<typeof prisma.payment.findMany>>;
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],   // id tiebreak → stable cursor pagination
        take: 5000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      rows.push(...batch);
      if (batch.length < 5000) break;
      cursor = batch[batch.length - 1].id;
    }

    const headers = [
      'createdAt (UTC+7)', 'code', 'customer', 'sender', 'amount', 'ocrAmount', 'bank',
      'transferAt', 'ref', 'sales', 'status', 'reNumber', 'receiptName', 'customerType',
      'flagged', 'taxInvoiceStatus', 'taxInvoice', 'note',
      'source', 'settleState', 'chequeNo', 'chequeBank', 'chequeDueDate',
    ];
    const esc = (v: unknown): string => {
      const raw = String(v ?? '');
      // Excel evaluates a leading =/+/-/@ as a formula even inside a quoted field — neutralize
      // with a leading apostrophe (renders as text). Also fold \t and \r into the safe path.
      const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const p of rows) {
      lines.push([
        new Date(p.createdAt.getTime() + TH_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' '),
        p.customerCode, p.customerName, p.senderName, p.amount, p.ocrAmount,
        p.bank, p.transferAt, p.ref, p.salesName, p.status, p.reNumber, p.receiptName, p.customerType,
        p.flagged ? 'yes' : '', p.taxInvoiceStatus, p.taxInvoice, p.note,
        p.source, p.settleState, p.chequeNo, p.chequeBank, p.chequeDueDate,
      ].map(esc).join(','));
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="juno-payments.csv"');
    return reply.send('﻿' + lines.join('\r\n'));
  });

  // ── Phase B: bank import + reconciliation (กระทบยอด) ──────────────────────

  // POST /api/juno/bank/import/preview { dataB64, fileName } — parse an uploaded bank file
  // (auto-detects KBIZ vs K SHOP), compute dedupeKeys, look up which already exist. NO
  // writes. Returns a token to apply this exact parsed set. Auth is re-checked here at
  // onRequest (BEFORE body parsing) — same reasoning as stock.ts's import route: with a
  // large bodyLimit, preHandler-only auth would let an anonymous client make the server
  // buffer+parse a multi-MB payload first.
  app.post('/api/juno/bank/import/preview', {
    onRequest: [requireAuth, requireRole('supervisor')], // bank import is CEO-only
    bodyLimit: 17 * 1024 * 1024, // ~15MB cap after base64 inflation, plus envelope headroom
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({ dataB64: z.string().min(1), fileName: z.string().max(300).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'missing_data' });
    const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
    if (body.data.dataB64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) return reply.code(413).send({ error: 'too_large' });
    const buf = Buffer.from(body.data.dataB64, 'base64');
    if (!buf.length) return reply.code(400).send({ error: 'empty' });
    if (buf.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: 'too_large' });

    let parsedFile;
    try {
      const utf8 = buf.toString('utf8').replace(/^﻿/, '');
      if (utf8.includes('TRANSACTION REPORT')) parsedFile = parseKshop(utf8);
      else if (utf8.includes('K-DEPOSIT STATEMENT')) parsedFile = parseKbiz(buf);
      else return reply.code(422).send({ error: 'unknown_format', detail: 'ไม่รู้จักรูปแบบไฟล์ — ต้องเป็น KBIZ statement หรือ K SHOP transaction report' });
    } catch (err) {
      if (err instanceof BankParseError) return reply.code(422).send({ error: err.message });
      req.log.error({ err }, 'bank import preview: parse failed');
      return reply.code(422).send({ error: 'parse_failed' });
    }

    const dedupeKeys = makeUniqueDedupeKeys(
      parsedFile.rows.map((r) => ({ source: parsedFile!.source, txnAt: r.txnAt, amount: r.amount, details: r.details })),
    );
    const existing = await prisma.bankTxn.findMany({
      where: { dedupeKey: { in: dedupeKeys } },
      select: { dedupeKey: true },
    });
    const existingSet = new Set(existing.map((e) => e.dedupeKey));
    const isNew = dedupeKeys.map((k) => !existingSet.has(k));
    const newCount = isNew.filter(Boolean).length;

    const token = stashBankPreview({
      source: parsedFile.source,
      fileName: String(body.data.fileName ?? ''),
      rows: parsedFile.rows,
      dedupeKeys,
      isNew,
      excluded: parsedFile.excluded,
      parsed: parsedFile.parsed,
      periodFrom: parsedFile.periodFrom,
      periodTo: parsedFile.periodTo,
      at: Date.now(),
    });

    return {
      token,
      source: parsedFile.source,
      fileName: String(body.data.fileName ?? ''),
      periodFrom: parsedFile.periodFrom ? parsedFile.periodFrom.toISOString() : null,
      periodTo: parsedFile.periodTo ? parsedFile.periodTo.toISOString() : null,
      rows: parsedFile.rows.slice(0, 50).map((r, i) => ({
        txnAt: r.txnAt.toISOString(),
        amount: r.amount,
        direction: r.direction,
        channel: r.channel,
        payerName: r.payerName,
        details: r.details,
        isNew: isNew[i],
      })),
      counts: { parsed: parsedFile.parsed, new: newCount, dup: parsedFile.rows.length - newCount, excluded: parsedFile.excluded },
    };
  });

  // POST /api/juno/bank/import/apply { token } — apply a previewed import: insert the NEW
  // BankTxns (dup rows are skipped — the same reasoning as Vulcan's apply), write a
  // BankImport audit row, then run the auto-matcher over the freshly inserted lines.
  app.post('/api/juno/bank/import/apply', { preHandler: requireRole('supervisor') }, async (req, reply) => {
    const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'missing_token' });
    const staged = bankPreviews.get(body.data.token);
    if (!staged || Date.now() - staged.at > BANK_PREVIEW_TTL_MS) {
      bankPreviews.delete(body.data.token);
      return reply.code(410).send({ error: 'preview_expired', detail: 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' });
    }
    bankPreviews.delete(body.data.token);

    const newIdx = staged.isNew.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);

    const imp = await prisma.bankImport.create({
      data: {
        source: staged.source,
        fileName: staged.fileName,
        importedBy: req.agent?.id,
        rowsParsed: staged.parsed,
        txnsNew: newIdx.length,
        txnsDup: staged.rows.length - newIdx.length,
        txnsExcluded: staged.excluded,
      },
    });

    const insertedIds: string[] = [];
    const CHUNK = 50;
    for (let i = 0; i < newIdx.length; i += CHUNK) {
      const slice = newIdx.slice(i, i + CHUNK);
      const created = await prisma.$transaction(
        slice.map((idx) => {
          const r = staged.rows[idx];
          return prisma.bankTxn.create({
            data: {
              source: staged.source,
              txnAt: r.txnAt,
              amount: r.amount,
              direction: r.direction,
              channel: r.channel,
              description: r.description,
              details: r.details,
              payerName: r.payerName,
              payerBank: r.payerBank,
              dedupeKey: staged.dedupeKeys[idx],
              importId: imp.id,
            },
            select: { id: true, direction: true },
          });
        }),
      );
      insertedIds.push(...created.filter((c) => c.direction === 'in').map((c) => c.id));
    }

    const { matched, chequesCleared } = await runAutoMatcher(insertedIds);

    return {
      ok: true,
      importId: imp.id,
      source: staged.source,
      counts: { parsed: staged.parsed, new: newIdx.length, dup: staged.rows.length - newIdx.length, excluded: staged.excluded },
      autoMatched: matched,
      autoCleared: chequesCleared,
    };
  });

  // POST /api/juno/bank/automatch — re-run the auto-matcher over ALL currently-unmatched
  // "in" bank txns (e.g. after FIN checks a backlog of payments post-import).
  app.post('/api/juno/bank/automatch', async () => {
    const { matched, chequesCleared } = await runAutoMatcher();
    return { ok: true, autoMatched: matched, autoCleared: chequesCleared };
  });

  // GET /api/juno/bank/txns?status=&dir=&from=&to=&q= — the เงินเข้า/เงินออก list, with
  // linked-payment summaries joined through PaymentBankMatch.
  const bankTxnsQuerySchema = z.object({
    status: z.enum(['all', 'unmatched', 'matched', 'confirmed']).optional(),
    dir: z.enum(['in', 'out', 'all']).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    q: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  app.get('/api/juno/bank/txns', async (req, reply) => {
    const parsed = bankTxnsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;

    const where: Record<string, unknown> = {};
    where.direction = q.dir && q.dir !== 'all' ? q.dir : 'in';
    if (q.status === 'unmatched') where.matchStatus = 'unmatched';
    else if (q.status === 'matched') { where.matchStatus = 'matched'; where.expressConfirmedAt = null; }
    else if (q.status === 'confirmed') where.expressConfirmedAt = { not: null };
    const range = thaiDayRange(q.from, q.to);
    if (range) where.txnAt = range;
    const term = q.q?.trim();
    if (term) {
      where.OR = [
        { details: { contains: term, mode: 'insensitive' } },
        { payerName: { contains: term, mode: 'insensitive' } },
        { refText: { contains: term, mode: 'insensitive' } },
        { amount: { contains: term } },
      ];
    }

    const txns = await prisma.bankTxn.findMany({ where, orderBy: { txnAt: 'desc' }, take: q.limit ?? 200 });
    const links = await prisma.paymentBankMatch.findMany({
      where: { bankTxnId: { in: txns.map((t) => t.id) } },
      select: { bankTxnId: true, payment: { select: { id: true, reNumber: true, receiptName: true, customerName: true, amount: true } } },
    });
    const byTxn = new Map<string, typeof links>();
    for (const l of links) byTxn.set(l.bankTxnId, [...(byTxn.get(l.bankTxnId) ?? []), l]);

    return {
      txns: txns.map((t) =>
        toBankTxnRow(
          t,
          (byTxn.get(t.id) ?? []).map((l) => ({
            paymentId: l.payment.id, reNumber: l.payment.reNumber, receiptName: l.payment.receiptName,
            customerName: l.payment.customerName, amount: l.payment.amount,
          })),
        ),
      ),
    };
  });

  // GET /api/juno/bank/txns/:id/suggestions — ranked candidate payments for the จับคู่ panel.
  // Exact-amount first (by day distance), then name-similarity, then same-day ± small delta.
  app.get<{ Params: { id: string } }>('/api/juno/bank/txns/:id/suggestions', async (req, reply) => {
    const txn = await prisma.bankTxn.findUnique({ where: { id: req.params.id } });
    if (!txn) return reply.code(404).send({ error: 'not_found' });

    const linked = await prisma.paymentBankMatch.findMany({ where: { bankTxnId: txn.id }, select: { paymentId: true } });
    const excludeIds = new Set(linked.map((l) => l.paymentId));

    const candidates = await prisma.payment.findMany({
      where: { status: 'verified', id: { notIn: [...excludeIds] } },
      select: { id: true, reNumber: true, receiptName: true, customerName: true, senderName: true, amount: true, transferAt: true, createdAt: true },
      take: 500, // ranked below; a bound keeps this cheap even on a large backlog
    });

    const txnAmount = parseFloat(txn.amount);
    const scored = candidates.map((p) => {
      const pAt = paymentTimestamp(p.transferAt, p.createdAt);
      const days = dayDistance(txn.txnAt, pAt);
      const exact = amountsEqual(txn.amount, p.amount);
      const nameScore = Math.max(
        nameSimilarity(txn.payerName || txn.details, p.senderName || p.customerName),
        nameSimilarity(txn.payerName || txn.details, p.receiptName),
      );
      const delta = Math.abs(txnAmount - parseFloat(p.amount || '0'));
      // Rank tiers: exact-amount (closer day wins ties) > name-similarity > same-day-small-delta.
      // Encoded as a single sortable number: tier * 1000 - tiebreak, higher = better.
      let score = 0;
      if (exact) score = 3000 - days;
      else if (nameScore > 0.3) score = 2000 + nameScore * 100 - days;
      else if (days < 1 && delta <= Math.max(1, txnAmount * 0.02)) score = 1000 - delta;
      else score = -1;
      return { p, days, exact, nameScore, delta, score };
    }).filter((s) => s.score > -1);

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 10);

    return {
      suggestions: top.map((s) => ({
        paymentId: s.p.id,
        reNumber: s.p.reNumber,
        receiptName: s.p.receiptName,
        customerName: s.p.customerName,
        senderName: s.p.senderName,
        amount: s.p.amount,
        dayDistance: Number(s.days.toFixed(2)),
        exactAmount: s.exact,
        nameScore: Number(s.nameScore.toFixed(2)),
      })),
    };
  });

  // POST /api/juno/bank/txns/:id/match { paymentIds: string[] } — link several payments to
  // one bank line (many-to-many; adds to existing links). Each link sets payment.reconciled.
  // Sum mismatch is allowed (fees) — the caller gets `sumDelta` back for the UI badge.
  app.post<{ Params: { id: string } }>('/api/juno/bank/txns/:id/match', async (req, reply) => {
    const body = z.object({ paymentIds: z.array(z.string().min(1)).min(1).max(50) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const txn = await prisma.bankTxn.findUnique({ where: { id: req.params.id } });
    if (!txn) return reply.code(404).send({ error: 'not_found' });

    const payments = await prisma.payment.findMany({ where: { id: { in: body.data.paymentIds } }, select: { id: true, amount: true } });
    if (payments.length !== body.data.paymentIds.length) return reply.code(400).send({ error: 'unknown_payment' });

    // createMany + skipDuplicates so re-adding an already-linked payment (e.g. a double
    // click) is idempotent rather than 500ing on the @@unique([paymentId, bankTxnId]).
    await prisma.paymentBankMatch.createMany({
      data: payments.map((p) => ({ paymentId: p.id, bankTxnId: txn.id, createdById: req.agent?.id ?? null })),
      skipDuplicates: true,
    });
    await Promise.all(payments.map((p) => recomputePaymentReconciled(p.id)));
    await recomputeTxnMatchStatus(txn.id);

    const allLinks = await prisma.paymentBankMatch.findMany({
      where: { bankTxnId: txn.id },
      select: { payment: { select: { amount: true } } },
    });
    const linkedSum = allLinks.reduce((s, l) => s + txnAmountNum(l.payment.amount), 0);
    const sumDelta = Number((linkedSum - txnAmountNum(txn.amount)).toFixed(2));

    return { ok: true, sumDelta };
  });

  // POST /api/juno/bank/txns/:id/unmatch { paymentId } — remove one link; recompute both
  // sides (payment.reconciled and txn.matchStatus — unmatched only when no links AND
  // refText is empty, so a line with a manual reference doesn't flip back to unmatched).
  app.post<{ Params: { id: string } }>('/api/juno/bank/txns/:id/unmatch', async (req, reply) => {
    const body = z.object({ paymentId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const link = await prisma.paymentBankMatch.findUnique({
      where: { paymentId_bankTxnId: { paymentId: body.data.paymentId, bankTxnId: req.params.id } },
    });
    if (!link) return reply.code(404).send({ error: 'not_found' });

    await prisma.paymentBankMatch.delete({ where: { id: link.id } });
    await recomputePaymentReconciled(body.data.paymentId);
    await recomputeTxnMatchStatus(req.params.id);

    return { ok: true };
  });

  // POST /api/juno/bank/txns/:id/ref { refText } — manual reference for non-Payment income
  // (cheque no. / บิล 38/13 / Shopee / a typed RE list). Non-empty → matched; empty →
  // recompute (falls back to unmatched unless links still exist).
  app.post<{ Params: { id: string } }>('/api/juno/bank/txns/:id/ref', async (req, reply) => {
    const body = z.object({ refText: z.string().max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const exists = await prisma.bankTxn.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'not_found' });

    await prisma.bankTxn.update({ where: { id: req.params.id }, data: { refText: body.data.refText.trim() } });
    await recomputeTxnMatchStatus(req.params.id);
    const updated = await prisma.bankTxn.findUnique({ where: { id: req.params.id } });
    return { ok: true, txn: toBankTxnRow(updated!) };
  });

  // POST /api/juno/bank/txns/:id/confirm { } — per-line ยืนยัน Express: stamp
  // expressConfirmedAt/By on this matched line AND advance every linked Payment with
  // status 'verified' → 'recorded' (payments already recorded are left alone).
  app.post<{ Params: { id: string } }>('/api/juno/bank/txns/:id/confirm', async (req, reply) => {
    const txn = await prisma.bankTxn.findUnique({ where: { id: req.params.id } });
    if (!txn) return reply.code(404).send({ error: 'not_found' });
    if (txn.matchStatus !== 'matched') return reply.code(409).send({ error: 'not_matched' });

    const links = await prisma.paymentBankMatch.findMany({ where: { bankTxnId: txn.id }, select: { paymentId: true } });
    const now = new Date();
    await prisma.$transaction([
      prisma.bankTxn.update({ where: { id: txn.id }, data: { expressConfirmedAt: now, expressConfirmedById: req.agent?.id ?? null } }),
      prisma.payment.updateMany({
        where: { id: { in: links.map((l) => l.paymentId) }, status: 'verified' },
        data: { status: 'recorded', verifiedById: req.agent?.id ?? null, verifiedAt: now },
      }),
    ]);
    return { ok: true };
  });

  // POST /api/juno/bank/confirm-matched { to? } — the WEEKEND bulk action: stamps
  // expressConfirmedAt/By on every matched-but-unconfirmed "in" line (≤ `to`, Thai day
  // inclusive) AND advances every linked Payment whose status is 'verified' → 'recorded'.
  // Payments that are received/void/already-recorded are untouched, exactly as spec'd.
  const confirmMatchedBodySchema = z.object({ to: z.string().max(40).optional() });
  app.post('/api/juno/bank/confirm-matched', async (req, reply) => {
    const body = confirmMatchedBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const range = thaiDayRange(undefined, body.data.to);
    const where: Record<string, unknown> = {
      direction: 'in', matchStatus: 'matched', expressConfirmedAt: null,
    };
    if (range?.lte) where.txnAt = { lte: range.lte };

    const txns = await prisma.bankTxn.findMany({ where, select: { id: true } });
    if (!txns.length) return { ok: true, txnsConfirmed: 0, paymentsAdvanced: 0 };

    const links = await prisma.paymentBankMatch.findMany({
      where: { bankTxnId: { in: txns.map((t) => t.id) } },
      select: { paymentId: true },
    });
    const paymentIds = [...new Set(links.map((l) => l.paymentId))];
    const now = new Date();

    const [, advanced] = await prisma.$transaction([
      prisma.bankTxn.updateMany({
        where: { id: { in: txns.map((t) => t.id) } },
        data: { expressConfirmedAt: now, expressConfirmedById: req.agent?.id ?? null },
      }),
      prisma.payment.updateMany({
        where: { id: { in: paymentIds }, status: 'verified' }, // only 'verified' advances; received/void/recorded untouched
        data: { status: 'recorded', verifiedById: req.agent?.id ?? null, verifiedAt: now },
      }),
    ]);

    return { ok: true, txnsConfirmed: txns.length, paymentsAdvanced: advanced.count };
  });

  // GET /api/juno/bank/summary — cards for the กระทบยอด tab.
  app.get('/api/juno/bank/summary', async () => {
    const [unmatchedIn, matchedUnconfirmed, unreconciledVerified, lastKbiz, lastKshop] = await Promise.all([
      prisma.bankTxn.findMany({ where: { direction: 'in', matchStatus: 'unmatched' }, select: { amount: true } }),
      prisma.bankTxn.findMany({ where: { direction: 'in', matchStatus: 'matched', expressConfirmedAt: null }, select: { amount: true } }),
      prisma.payment.findMany({ where: { status: 'verified', reconciled: false }, select: { amount: true, verifiedAt: true, createdAt: true } }),
      prisma.bankImport.findFirst({ where: { source: 'kbiz' }, orderBy: { importedAt: 'desc' } }),
      prisma.bankImport.findFirst({ where: { source: 'kshop' }, orderBy: { importedAt: 'desc' } }),
    ]);
    const sum = (rows: { amount: string }[]) => rows.reduce((s, r) => s + txnAmountNum(r.amount), 0);
    const now = Date.now();
    const oldestDays = unreconciledVerified.length
      ? Math.max(...unreconciledVerified.map((p) => (now - (p.verifiedAt ?? p.createdAt).getTime()) / (24 * 3600 * 1000)))
      : 0;

    return {
      unmatchedIn: { count: unmatchedIn.length, sum: sum(unmatchedIn) },
      matchedUnconfirmed: { count: matchedUnconfirmed.length, sum: sum(matchedUnconfirmed) },
      verifiedUnreconciled: { count: unreconciledVerified.length, sum: sum(unreconciledVerified), oldestDays: Math.round(oldestDays) },
      lastImports: { kbiz: lastKbiz, kshop: lastKshop },
    };
  });

  // GET /api/juno/bank/watchlist?limit= — ใบเสร็จที่ยังไม่พบเงินเข้า: Payments verified +
  // !reconciled, oldest first (the fraud/error watchlist the sheet never had).
  app.get('/api/juno/bank/watchlist', async (req) => {
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit) || 100, 1), 500);
    const rows = await prisma.payment.findMany({
      where: { status: 'verified', reconciled: false },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return { payments: rows.map(toRow) };
  });
}
