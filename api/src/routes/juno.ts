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
import { syncPaymentToJupiter } from '../jupiter/sync.js';
import { readChequeFromBuffer, readSlipFromBuffer } from '../llm/readSlip.js';
import { parseReReceipts, decodeExpressBytes } from '../finance/parseReReceipts.js';
import { computeReRow } from '../finance/reRecon.js';
import {
  buildDiscrepancyComponents,
  componentByPaymentId,
  expectedForPayment,
  grossSatang,
  isMoneyString,
  mismatchedMultiPaymentComponentCount,
  satangToBaht,
} from '../finance/discrepancy.js';

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
const DISC_RESOLUTIONS = ['', 'refund', 'credit', 'chase', 'writeoff'] as const;
const moneyStringSchema = z.string().max(40).refine((value) => isMoneyString(value), 'invalid_money');
const manualBillNoSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^/,\s]+$/, 'เลขบิลห้ามมี / , หรือช่องว่าง')
  .transform((value) => value.toUpperCase());
const manualBillItemSchema = z.object({
  productId: z.string().max(120).optional(),
  sku: z.string().max(120).optional(),
  name: z.string().trim().min(1).max(300),
  qty: z.number().positive().finite(),
  unitPrice: moneyStringSchema,
  amount: moneyStringSchema,
});
const manualBillFieldsSchema = z.object({
  billedAt: z.string().max(40),
  buyerName: z.string().max(300),
  buyerPhone: z.string().max(100),
  buyerAddress: z.string().max(1000),
  items: z.array(manualBillItemSchema).max(40),
  amount: moneyStringSchema.refine((value) => value.trim() !== '', 'amount_required'),
  note: z.string().max(1000),
});
const createManualBillSchema = manualBillFieldsSchema.extend({ billNo: manualBillNoSchema.optional() });
const patchManualBillSchema = manualBillFieldsSchema.partial();

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

// Withholding tax (หัก ณ ที่จ่าย, task 2): the payment `amount` is the money the customer
// ACTUALLY sent — already net of any WHT (that's what the slip/bank shows and what the bank
// matcher reconciles directly, no adjustment). grossOf adds the withheld slice back to recover
// the full price / RE amount (amount + wht). whtAmount '' (the default + every pre-task-2 row) →
// grossOf === num(amount). Used only for the WHT tab + DTO display, never for bank matching.
function grossOf(p: { amount: string; whtAmount: string }): number {
  return num(p.amount) + num(p.whtAmount || '0');
}

// The row shape the Juno UI consumes (the stored Payment plus a couple of derived fields).
function toRow(p: {
  id: string; customerId: string | null; customerCode: string; customerName: string;
  senderName: string; amount: string; ocrAmount: string; bank: string; transferAt: string;
  ref: string; slipMessageId: string | null; slipUrl: string; taxInvoice: string;
  taxInvoiceStatus: string; salesAgentId: string | null; salesName: string; note: string;
  status: string; flagged: boolean; verifiedById: string | null; verifiedAt: Date | null;
  createdAt: Date; reNumber: string; reNumbers: string[]; billNos: string[]; receiptName: string; customerType: string;
  source: string; settleState: string; settledAt: Date | null;
  receivedAt: Date | null; receivedBy: string | null;
  chequeNo: string; chequeBank: string; chequeDueDate: string;
  whtRate: number; whtAmount: string;
  discExpected: string; discResolution: string; discNote: string;
  discResolvedAt: Date | null; discResolvedBy: string;
  discConfirmedAt: Date | null; discConfirmedBy: string;
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
    // withholding tax (task 2) — `amount`/`amountNum` above is the net the customer actually sent
    // (matches the bank directly); grossAmount adds the WHT back to recover the full price/RE.
    // whtAmount '' → grossAmount === amountNum unchanged.
    whtRate: p.whtRate,
    whtAmount: p.whtAmount,
    grossAmount: grossOf(p),
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
    billNos: p.billNos,
    receiptName: p.receiptName,
    customerType: p.customerType,
    // how the row was created + legacy read-only cash/cheque banking state
    source: p.source,
    settleState: p.settleState,
    settledAt: p.settledAt ? p.settledAt.toISOString() : null,
    // CEO receipt-verify gate (task 1); bank matching is unrelated bookkeeping. See
    // POST /payments/:id/receive.
    receivedAt: p.receivedAt ? p.receivedAt.toISOString() : null,
    receivedBy: p.receivedBy,
    chequeNo: p.chequeNo,
    chequeBank: p.chequeBank,
    chequeDueDate: p.chequeDueDate,
    discExpected: p.discExpected,
    discResolution: p.discResolution,
    discNote: p.discNote,
    discResolvedAt: p.discResolvedAt?.toISOString() ?? null,
    discResolvedBy: p.discResolvedBy,
    discConfirmedAt: p.discConfirmedAt?.toISOString() ?? null,
    discConfirmedBy: p.discConfirmedBy,
  };
}

async function getDiscrepancySnapshot() {
  const [payments, receipts] = await Promise.all([
    prisma.payment.findMany({ where: { status: { not: 'void' } }, orderBy: { createdAt: 'desc' } }),
    prisma.reReceipt.findMany({ select: { reNumber: true, amount: true } }),
  ]);
  const components = buildDiscrepancyComponents(payments, receipts);
  const componentsByPayment = componentByPaymentId(components);

  const rows = payments.flatMap((payment) => {
    let expected = expectedForPayment(payment, componentsByPayment.get(payment.id));
    const hasStamps = !!(
      payment.discResolution || payment.discResolvedAt || payment.discResolvedBy ||
      payment.discConfirmedAt || payment.discConfirmedBy
    );

    // A resolved auto row may cease to be a single-payment candidate when a completing payment
    // arrives. Keep its audit row visible and show the live self-healed diff as zero.
    if (!expected && hasStamps) expected = { expectedSatang: grossSatang(payment), source: 're' as const };
    if (!expected) return [];

    const gross = grossSatang(payment);
    const diff = gross - expected.expectedSatang;
    if (diff === 0 && !hasStamps) return [];
    return [{
      id: payment.id,
      transferAt: payment.transferAt,
      createdAt: payment.createdAt.toISOString(),
      customerCode: payment.customerCode,
      customerName: payment.customerName,
      receiptName: payment.receiptName,
      source: payment.source,
      hasSlip: !!payment.slipUrl,
      reNumbers: payment.reNumbers,
      status: payment.status,
      expected: satangToBaht(expected.expectedSatang),
      expectedSource: expected.source,
      gross: satangToBaht(gross),
      diff: satangToBaht(diff),
      _diffSatang: diff,
      direction: diff > 0 ? 'over' as const : diff < 0 ? 'under' as const : 'balanced' as const,
      discExpected: payment.discExpected,
      discResolution: payment.discResolution,
      discNote: payment.discNote,
      discResolvedAt: payment.discResolvedAt?.toISOString() ?? null,
      discResolvedBy: payment.discResolvedBy,
      discConfirmedAt: payment.discConfirmedAt?.toISOString() ?? null,
      discConfirmedBy: payment.discConfirmedBy,
    }];
  });

  const open = rows.filter((row) => row._diffSatang !== 0 && !row.discResolution);
  const over = open.filter((row) => row._diffSatang > 0);
  const under = open.filter((row) => row._diffSatang < 0);
  return {
    rows: rows.map(({ _diffSatang: _internal, ...row }) => row),
    totals: {
      over: { count: over.length, sum: satangToBaht(over.reduce((sum, row) => sum + row._diffSatang, 0)) },
      under: { count: under.length, sum: satangToBaht(under.reduce((sum, row) => sum + row._diffSatang, 0)) },
      pendingConfirm: rows.filter((row) => !!row.discResolution && !row.discConfirmedAt).length,
    },
    groupHints: mismatchedMultiPaymentComponentCount(components),
    openCount: open.length,
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
  // หัก ณ ที่จ่าย (WHT, task 2) tab — every withheld payment, any status except void.
  wht: z.enum(['true']).optional(),
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
  if (q.wht === 'true') {
    where.whtAmount = { not: '' };
    if (!where.status) where.status = { not: 'void' };
  }
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

// ── Bank import staging (preview → apply), mirrors Vesta's stock import pattern ──
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
  links: { paymentId: string; reNumber: string; chequeNo: string; receiptName: string; customerName: string; amount: string }[] = [],
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
    links: links.map((l) => ({ paymentId: l.paymentId, reNumber: l.reNumber, chequeNo: l.chequeNo, receiptName: l.receiptName, customerName: l.customerName, amount: l.amount })),
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
//   Pass 1 (cheque): a KBiz "Cheque Deposit … Cheque No. N" line is linked to its hand-added
//     cheque Payment by cheque number + amount. This is bank-side bookkeeping only.
//   Pass 2 (generic): the amount + day-window match for every OTHER credit line ↔ Payment
//     status='verified', not void, reconciled=false (cheque-deposit lines and source='cheque'
//     payments are excluded here — a cheque can ONLY link via its number, never by amount).
// Both passes link ONLY when the pairing is unambiguous in BOTH directions (exactly one
// candidate each way) — everything else is left for the UI's ranked suggestions. Runs over a
// specific set of new txn ids (import apply) or ALL unmatched in-txns (manual re-run via
// /bank/automatch). createdById is left null on every link this function creates — a
// deliberate marker distinguishing "the system auto-matched this" from a FIN-driven manual
// match (POST /match, which stamps req.agent.id). Returns both link counts.
async function runAutoMatcher(txnIds?: string[]): Promise<{ matched: number; chequeMatched: number }> {
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
  if (!linkable.length) return { matched: 0, chequeMatched: 0 };

  // ── Pass 1: cheques ──────────────────────────────────────────────────────
  // Match cheque-deposit lines to cheque payments by cheque number + amount, unambiguous
  // BOTH ways (exactly one candidate txn ↔ one candidate payment), computed over ALL
  // unmatched cheque-deposit lines so an older line is seen as an equally plausible home.
  // Track the linked txn ids so the generic pass skips them (its own filter also drops every
  // cheque-deposit line regardless).
  const chequeMatchedTxnIds = new Set<string>();
  const chequeMatchedPaymentIds = new Set<string>();
  let chequeMatched = 0;
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
        prisma.payment.update({ where: { id: pid }, data: { reconciled: true } }),
      ]);
      chequeMatchedTxnIds.add(t.id);
      chequeMatchedPaymentIds.add(pid);
      chequeMatched++;
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
        // The payment `amount` is already the net the customer sent, so it equals the bank
        // credit directly — WHT needs no adjustment here (see grossOf's note).
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

  return { matched: autoMatched, chequeMatched };
}

export async function junoRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('juno'));

  // GET /api/juno/summary — headline counts for the Juno dashboard / login landing.
  app.get('/api/juno/summary', async () => {
    const [total, received, verified, recorded, flagged, taxRequested, awaitingReceive, discrepancy] = await Promise.all([
      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'received' } }),
      prisma.payment.count({ where: { status: 'verified' } }),
      prisma.payment.count({ where: { status: 'recorded' } }),
      prisma.payment.count({ where: { flagged: true, status: { not: 'void' } } }),
      prisma.payment.count({ where: { taxInvoiceStatus: 'requested', status: { not: 'void' } } }),
      // รอยืนยันรับเงิน tab badge (task 1): cash/cheque the CEO hasn't yet confirmed he
      // physically received.
      prisma.payment.count({ where: { source: { in: ['cash', 'cheque'] }, receivedAt: null, status: { not: 'void' } } }),
      getDiscrepancySnapshot(),
    ]);
    return {
      total, received, verified, recorded, flagged, taxRequested, awaitingReceive,
      discrepancyOpen: discrepancy.openCount,
    };
  });

  // ── Manual bills (บิลมือ) ──────────────────────────────────────────────
  // A bill is a document, not an income row. Paid-ness is computed live from non-void
  // Payments carrying its billNo, exactly like the RE reconciliation lane.
  const billsQuerySchema = z.object({
    q: z.string().max(120).optional(),
    status: z.enum(['all', 'paid', 'unpaid', 'mismatch', 'void']).optional(),
  });
  app.get('/api/juno/bills', async (req, reply) => {
    const parsed = billsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    // Query 1: every bill. Text/status filtering stays in JS so `counts` remains the global
    // unpaid+mismatch badge even while the open tab has a search/filter applied.
    const bills = await prisma.manualBill.findMany({ orderBy: { createdAt: 'desc' } });
    const candidatePayments = await prisma.payment.findMany({
      where: { status: { not: 'void' }, billNos: { isEmpty: false } },
      select: {
        id: true, billNos: true, amount: true, whtAmount: true, status: true, source: true,
        createdAt: true, customerName: true,
      },
    });
    const byBill = new Map<string, typeof candidatePayments>();
    for (const payment of candidatePayments) {
      for (const billNo of payment.billNos) {
        const linked = byBill.get(billNo);
        if (linked) linked.push(payment);
        else byBill.set(billNo, [payment]);
      }
    }

    const allRows = bills.map((bill) => {
      const payments = byBill.get(bill.billNo) ?? [];
      const paidGross = payments.reduce((sum, payment) => sum + grossOf(payment), 0);
      const billStatus = bill.status === 'void'
        ? 'void'
        : payments.length === 0
          ? 'unpaid'
          : amountsEqual(String(paidGross), bill.amount.replace(/,/g, '')) ? 'paid' : 'mismatch';
      return {
        ...bill,
        createdAt: bill.createdAt.toISOString(),
        updatedAt: bill.updatedAt.toISOString(),
        voidedAt: bill.voidedAt?.toISOString() ?? null,
        items: (bill.items as unknown as z.infer<typeof manualBillItemSchema>[] | null) ?? [],
        linkedPayments: payments.map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          whtAmount: payment.whtAmount,
          status: payment.status,
          source: payment.source,
          createdAt: payment.createdAt.toISOString(),
          customerName: payment.customerName,
        })),
        billStatus,
        paidGross,
      };
    });
    const counts = {
      unpaid: allRows.filter((bill) => bill.billStatus === 'unpaid').length,
      mismatch: allRows.filter((bill) => bill.billStatus === 'mismatch').length,
    };
    const needle = q.q?.trim().toLocaleLowerCase();
    const searchedRows = needle
      ? allRows.filter((bill) => bill.billNo.toLocaleLowerCase().includes(needle) || bill.buyerName.toLocaleLowerCase().includes(needle))
      : allRows;
    const rows = !q.status || q.status === 'all'
      ? searchedRows
      : searchedRows.filter((bill) => bill.billStatus === q.status);
    return { bills: rows, counts };
  });

  const normalizedBillItems = (items: z.infer<typeof manualBillItemSchema>[]) => items.map((item) => ({
    ...(item.productId?.trim() ? { productId: item.productId.trim() } : {}),
    ...(item.sku?.trim() ? { sku: item.sku.trim() } : {}),
    name: item.name.trim(),
    qty: item.qty,
    unitPrice: item.unitPrice.trim(),
    amount: item.amount.trim(),
  }));
  const billTotalMatches = (items: z.infer<typeof manualBillItemSchema>[], amount: string): boolean =>
    amountsEqual(String(items.reduce((sum, item) => sum + num(item.amount), 0)), amount.replace(/,/g, ''));

  app.post('/api/juno/bills', async (req, reply) => {
    const parsed = createManualBillSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((entry) => entry.path[0] === 'billNo');
      return reply.code(400).send({ error: issue ? 'invalid_bill_no' : 'invalid_body', message: issue?.message });
    }
    const items = normalizedBillItems(parsed.data.items);
    const amount = parsed.data.amount.trim();
    if (!billTotalMatches(items, amount)) {
      return reply.code(400).send({ error: 'amount_mismatch', message: 'ยอดรวมต้องตรงกับผลรวมของรายการ' });
    }
    const base = {
      billedAt: parsed.data.billedAt.trim(),
      buyerName: parsed.data.buyerName.trim(),
      buyerPhone: parsed.data.buyerPhone.trim(),
      buyerAddress: parsed.data.buyerAddress.trim(),
      items,
      amount,
      note: parsed.data.note.trim(),
      createdById: req.agent?.id ?? null,
      createdByName: req.agent?.name ?? '',
    };
    const isUniqueError = (error: unknown): boolean => (error as { code?: string })?.code === 'P2002';

    if (parsed.data.billNo) {
      try {
        const bill = await prisma.manualBill.create({ data: { ...base, billNo: parsed.data.billNo } });
        return { ok: true, bill };
      } catch (error) {
        if (isUniqueError(error)) {
          return reply.code(409).send({ error: 'duplicate_bill_no', message: 'เลขบิลนี้มีอยู่แล้ว' });
        }
        throw error;
      }
    }

    // Bangkok year, not server/UTC year. Buddhist year 2569 -> two-digit 69.
    const gregorianYear = Number(thaiDayKey(new Date()).slice(0, 4));
    const year2 = String((gregorianYear + 543) % 100).padStart(2, '0');
    const prefix = `MB${year2}-`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const bill = await prisma.$transaction(async (tx) => {
          const existing = await tx.manualBill.findMany({
            where: { billNo: { startsWith: prefix } },
            select: { billNo: true },
          });
          const max = existing.reduce((current, row) => {
            const match = row.billNo.match(new RegExp(`^${prefix}(\\d{4})$`));
            return match ? Math.max(current, Number(match[1])) : current;
          }, 0);
          const billNo = `${prefix}${String(max + 1).padStart(4, '0')}`;
          return tx.manualBill.create({ data: { ...base, billNo } });
        });
        return { ok: true, bill };
      } catch (error) {
        if (isUniqueError(error) && attempt === 0) continue;
        if (isUniqueError(error)) {
          return reply.code(409).send({ error: 'duplicate_bill_no', message: 'เลขบิลนี้มีอยู่แล้ว' });
        }
        throw error;
      }
    }
    return reply.code(409).send({ error: 'duplicate_bill_no', message: 'เลขบิลนี้มีอยู่แล้ว' });
  });

  app.patch<{ Params: { id: string } }>('/api/juno/bills/:id', async (req, reply) => {
    const parsed = patchManualBillSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const existing = await prisma.manualBill.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const currentItems = (existing.items as unknown as z.infer<typeof manualBillItemSchema>[] | null) ?? [];
    const items = parsed.data.items ? normalizedBillItems(parsed.data.items) : currentItems;
    const amount = parsed.data.amount?.trim() ?? existing.amount;
    if (!billTotalMatches(items, amount)) {
      return reply.code(400).send({ error: 'amount_mismatch', message: 'ยอดรวมต้องตรงกับผลรวมของรายการ' });
    }
    const bill = await prisma.manualBill.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.billedAt === undefined ? {} : { billedAt: parsed.data.billedAt.trim() }),
        ...(parsed.data.buyerName === undefined ? {} : { buyerName: parsed.data.buyerName.trim() }),
        ...(parsed.data.buyerPhone === undefined ? {} : { buyerPhone: parsed.data.buyerPhone.trim() }),
        ...(parsed.data.buyerAddress === undefined ? {} : { buyerAddress: parsed.data.buyerAddress.trim() }),
        ...(parsed.data.items === undefined ? {} : { items }),
        ...(parsed.data.amount === undefined ? {} : { amount }),
        ...(parsed.data.note === undefined ? {} : { note: parsed.data.note.trim() }),
      },
    });
    return { ok: true, bill };
  });

  app.post<{ Params: { id: string } }>('/api/juno/bills/:id/void', async (req, reply) => {
    const parsed = z.object({ void: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const existing = await prisma.manualBill.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const bill = await prisma.manualBill.update({
      where: { id: req.params.id },
      data: parsed.data.void
        ? { status: 'void', voidedAt: new Date(), voidedById: req.agent?.id ?? null }
        : { status: 'open', voidedAt: null, voidedById: null },
    });
    return { ok: true, bill };
  });

  // Read-only shared Product picker. The normalized comparison makes 071009 find 07-10-09.
  app.get('/api/juno/products', async (req, reply) => {
    const parsed = z.object({ q: z.string().max(120).optional() }).safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const needle = (parsed.data.q ?? '').trim().replace(/[-\s]/g, '').toLowerCase();
    const products = await prisma.product.findMany({
      where: { status: 'active' },
      select: { sku: true, nameTh: true, nameEn: true, price: true, stock: true, stockAt: true },
      orderBy: { sku: 'asc' },
    });
    const matches = needle
      ? products.filter((product) => {
          const sku = product.sku.replace(/[-\s]/g, '').toLowerCase();
          const name = `${product.nameTh} ${product.nameEn}`.replace(/[-\s]/g, '').toLowerCase();
          return sku.includes(needle) || name.includes(needle);
        })
      : products;
    return {
      products: matches.slice(0, 20).map((product) => ({
        id: product.sku,
        sku: product.sku.replace(/-/g, ''),
        name: product.nameTh || product.nameEn || product.sku,
        price: product.price,
        stock: product.stock,
        stockAt: product.stockAt?.toISOString() ?? null,
      })),
    };
  });

  // GET /api/juno/discrepancies — live single-payment discrepancy ledger plus preserved
  // resolution/confirmation audit rows. Every comparison uses gross = amount + whtAmount.
  app.get('/api/juno/discrepancies', async () => {
    const { rows, totals, groupHints } = await getDiscrepancySnapshot();
    return { rows, totals, groupHints };
  });

  // FIN may explicitly set, adjust, or clear the expected gross outside the RE-check dialog.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/discrepancy', async (req, reply) => {
    const body = z.object({ expected: moneyStringSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const current = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!current) return reply.code(404).send({ error: 'not_found' });
    if (current.status === 'void') return reply.code(409).send({ error: 'void_locked' });
    const payment = await prisma.payment.update({
      where: { id: req.params.id },
      data: { discExpected: body.data.expected.trim() },
    });
    return { ok: true, payment: toRow(payment) };
  });

  // FIN records how the difference was handled. An empty resolution is the explicit reset path.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/disc-resolve', async (req, reply) => {
    const body = z.object({
      resolution: z.enum(DISC_RESOLUTIONS),
      note: z.string().max(600).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const current = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!current) return reply.code(404).send({ error: 'not_found' });
    if (current.status === 'void') return reply.code(409).send({ error: 'void_locked' });

    const clearing = body.data.resolution === '';
    const payment = await prisma.payment.update({
      where: { id: req.params.id },
      data: clearing ? {
        discResolution: '', discNote: '', discResolvedAt: null, discResolvedBy: '',
        discConfirmedAt: null, discConfirmedBy: '',
      } : {
        discResolution: body.data.resolution,
        discNote: body.data.note?.trim() ?? '',
        discResolvedAt: new Date(),
        discResolvedBy: req.agent?.email ?? req.agent?.id ?? '',
        // Editing a resolution sends it back through the CEO confirmation gate.
        discConfirmedAt: null,
        discConfirmedBy: '',
      },
    });
    return { ok: true, payment: toRow(payment) };
  });

  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/disc-confirm', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    const body = z.object({ confirmed: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const current = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, discResolution: true },
    });
    if (!current) return reply.code(404).send({ error: 'not_found' });
    if (current.status === 'void') return reply.code(409).send({ error: 'void_locked' });
    if (body.data.confirmed && !current.discResolution) {
      return reply.code(409).send({ error: 'resolution_required' });
    }
    const payment = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        discConfirmedAt: body.data.confirmed ? new Date() : null,
        discConfirmedBy: body.data.confirmed ? (req.agent?.email ?? req.agent?.id ?? '') : '',
      },
    });
    return { ok: true, payment: toRow(payment) };
  });

  // GET /api/juno/wht/summary?from=&to= — period totals for the หัก ณ ที่จ่าย (WHT, task 2)
  // tab: count + net(received)/wht/gross(full-price) over non-void payments with a withheld amount,
  // in the given Thai-day range. Visible to every Juno user (list + totals only — no
  // certificate tracking) — same requireApp('juno') gate as the rest of this file, no extra
  // supervisor check (contrast with the CEO-only /reports below).
  const whtSummaryQuerySchema = z.object({
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
  });
  app.get('/api/juno/wht/summary', async (req, reply) => {
    const parsed = whtSummaryQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;

    const where: Record<string, unknown> = { whtAmount: { not: '' }, status: { not: 'void' } };
    const range = thaiDayRange(q.from, q.to);
    if (range) where.createdAt = range;

    const rows = await prisma.payment.findMany({ where, select: { amount: true, whtAmount: true } });
    // `amount` is the NET the customer actually sent; wht is the withheld slice; the full
    // price / RE (gross) = net + wht.
    const net = rows.reduce((s, r) => s + num(r.amount), 0);
    const wht = rows.reduce((s, r) => s + num(r.whtAmount), 0);
    return { count: rows.length, net, wht, gross: net + wht };
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

  // PATCH /api/juno/payments/:id { customerCode?, customerName?, senderName?, amount?, bank?,
  // transferAt?, ref?, salesName?, note?, taxInvoice?, chequeNo?, chequeBank?, chequeDueDate? } —
  // แก้ไขรายละเอียด: let any Juno user (FIN/MD/CEO — same requireApp('juno') gate as the rest of
  // this file, NOT supervisor-only) fix typos on an existing payment — wrong customer code/name,
  // a mis-typed sender/bank/ref, etc. This is routine data-entry correction, unlike the CEO-only
  // ลบถาวร above. Every field is OPTIONAL (partial update) — the client sends only what changed.
  //
  // Deliberately EXCLUDED (not editable here — each has its own route/owner):
  //   id/source/slipUrl (identity + provenance), status/flagged (lifecycle, see /status /flag),
  //   reNumber(s)/receiptName/customerType/whtRate/whtAmount (FIN's check data, see /verify),
  //   legacy banking fields/receivedAt (read-only history/receipt gate), verifiedById/At
  //   (stamped by /status /verify only), and every disc* field (see the dedicated discrepancy,
  //   disc-resolve, and disc-confirm routes). No disc* key exists in this schema by design.
  const editPaymentBodySchema = z.object({
    customerCode: z.string().max(40).optional(),
    customerName: z.string().max(200).optional(),
    senderName: z.string().max(200).optional(),
    amount: z.string().max(40).optional(),
    bank: z.string().max(120).optional(),
    transferAt: z.string().max(60).optional(),
    ref: z.string().max(80).optional(),
    salesName: z.string().max(200).optional(),
    note: z.string().max(600).optional(),
    taxInvoice: z.string().max(600).optional(),
    chequeNo: z.string().max(60).optional(),
    chequeBank: z.string().max(120).optional(),
    chequeDueDate: z.string().max(60).optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/juno/payments/:id', async (req, reply) => {
    const body = editPaymentBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const existing = await prisma.payment.findUnique({
      where: { id: req.params.id },
      select: { id: true, amount: true, bankMatches: { select: { bankTxnId: true } } },
    });
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    // Build `data` from only the keys the client actually sent (partial update) — an omitted
    // field must NOT be clobbered back to ''. Every value trimmed, matching the create route's
    // convention. amount gets an extra positive-number check (same rule as POST /payments) so a
    // typo fix can't silently null out the reconciled figure.
    const data: Record<string, string> = {};
    for (const key of Object.keys(body.data) as (keyof typeof body.data)[]) {
      const v = body.data[key];
      if (v !== undefined) data[key] = v.trim();
    }
    if (data.amount !== undefined) {
      const amountNum = parseFloat(data.amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) return reply.code(400).send({ error: 'invalid_amount' });
    }

    // Amount ↔ reconciliation: a bank match was linked against the OLD amount (amountsEqual
    // in runAutoMatcher/suggestions), so changing the amount can leave a stale/wrong match
    // sitting on the row. Keep this surgical — only touch matches when amount actually changed,
    // and only for THIS payment's links (mirrors the DELETE route's capture-then-recompute
    // pattern, just without deleting the Payment itself). Folding `reconciled: false` into the
    // SAME update as the field edits (rather than a second write) keeps this to one payment
    // UPDATE either way.
    const amountChanged = data.amount !== undefined && data.amount !== existing.amount;
    const detaching = amountChanged && existing.bankMatches.length > 0;
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: detaching ? { ...data, reconciled: false } : data,
    });

    if (detaching) {
      const bankTxnIds = [...new Set(existing.bankMatches.map((m) => m.bankTxnId))];
      await prisma.paymentBankMatch.deleteMany({ where: { paymentId: req.params.id } });
      await Promise.all(bankTxnIds.map((id) => recomputeTxnMatchStatus(id)));
      req.log.info(
        { paymentId: req.params.id, by: req.agent?.id, detachedMatches: bankTxnIds.length },
        'payment amount edited — detached stale bank match(es)',
      );
    }

    return { ok: true, payment: toRow(p) };
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

  app.post('/api/juno/read-cheque', async (req, reply) => {
    const body = readSlipBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!UPLOAD_ID_RE.test(body.data.uploadId)) return reply.code(400).send({ error: 'invalid_upload_id' });

    const buf = await readStaffUploadFile(body.data.uploadId);
    if (!buf) return reply.code(404).send({ error: 'not_found' });
    const meta = await readStaffUploadMeta(body.data.uploadId);
    const contentType = meta?.contentType || 'image/jpeg';

    const fields = await readChequeFromBuffer(buf, contentType);
    return {
      chequeNo: fields.chequeNo,
      chequeBank: fields.chequeBank,
      chequeDueDate: fields.chequeDueDate,
      amount: fields.amount,
    };
  });

  // POST /api/juno/payments/:id/receive { received } — CEO-ONLY receipt-verify gate (task 1):
  // the CEO confirms he PHYSICALLY received the cash/cheque. This is the only cash/cheque payment
  // state; bank matching is unrelated bookkeeping. It is a hard prerequisite for ยืนยันใน Express
  // (see POST /status below, which
  // 409s status->'recorded' for cash/cheque while receivedAt is null). received=false is the
  // undo path (ยกเลิกการยืนยัน), clearing the stamp.
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
    // Phase-1b: mirror this payment into the Jupiter group books (PROM income) now it is
    // 'recorded', or drop it if it just left 'recorded' (void/undo). Fire-and-forget — a books
    // sync must NEVER affect the Juno flow. Bank-reconciliation records sync via /sync/juno.
    void syncPaymentToJupiter(p.id).catch((err) => req.log.error({ err }, 'jupiter sync failed'));
    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/payments/:id/verify { reNumbers, billNos?, receiptName?, customerType?, ... }
  // — the ONLY way to reach status 'verified'. A payment may carry Express REs, manual bills,
  // or both. Both lists are replaced in full on every save.
  // WHT (task 2): whtRate/whtAmount are entered in this SAME dialog (owner-approved design —
  // one WHT figure per payment, not tracked per-RE). whtRate 0 (default) = no WHT; whtAmount is
  // the editable withheld baht (may not be an exact rate×gross calc — matches the 50-ทวิ cert).
  const customerTypeSchema = z.enum(['โอนก่อนส่ง', 'เครดิต', 'เก็บปลายทาง', '']).default('');
  const WHT_RATES = [0, 1, 2, 3, 5] as const;
  const verifyBodySchema = z.object({
    reNumbers: z.array(z.string()).max(50),
    billNos: z.array(z.string()).max(20).optional(),
    receiptName: z.string().max(200).optional(),
    customerType: customerTypeSchema.optional(),
    whtRate: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(5)]).optional(),
    whtAmount: z.string().max(40).optional(),
    discExpected: moneyStringSchema.optional(),
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
    const seenBills = new Set<string>();
    const normalizedBills: string[] = [];
    for (const raw of body.data.billNos ?? []) {
      const checked = manualBillNoSchema.safeParse(raw);
      if (!checked.success) {
        return reply.code(400).send({ error: 'invalid_bill_no', message: 'เลขบิลห้ามมี / , หรือช่องว่าง' });
      }
      if (!seenBills.has(checked.data)) { seenBills.add(checked.data); normalizedBills.push(checked.data); }
    }
    if (normalized.length === 0 && normalizedBills.length === 0) {
      return reply.code(400).send({ error: 'receipt_required' });
    }

    // whtRate defaults to 0 (no WHT) when omitted; whtAmount only makes sense alongside a
    // nonzero rate, so a rate of 0 always clears whtAmount too regardless of what was sent —
    // there is no such thing as "no WHT but a withheld baht figure on file".
    const whtRate: (typeof WHT_RATES)[number] = body.data.whtRate ?? 0;
    const whtAmount = whtRate === 0 ? '' : (body.data.whtAmount?.trim() ?? '');

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
        billNos: normalizedBills,
        receiptName: body.data.receiptName?.trim() ?? '',
        customerType: body.data.customerType ?? '',
        whtRate,
        whtAmount,
        ...(body.data.discExpected === undefined ? {} : { discExpected: body.data.discExpected.trim() }),
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
      'transferAt', 'ref', 'sales', 'status', 'reNumber', 'บิลมือ', 'receiptName', 'customerType',
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
        p.bank, p.transferAt, p.ref, p.salesName, p.status, p.reNumber, p.billNos.join('/'), p.receiptName, p.customerType,
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
  // BankTxns (dup rows are skipped — the same reasoning as Vesta's apply), write a
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

    const { matched, chequeMatched } = await runAutoMatcher(insertedIds);

    return {
      ok: true,
      importId: imp.id,
      source: staged.source,
      counts: { parsed: staged.parsed, new: newIdx.length, dup: staged.rows.length - newIdx.length, excluded: staged.excluded },
      autoMatched: matched,
      chequeMatched,
    };
  });

  // POST /api/juno/bank/automatch — re-run the auto-matcher over ALL currently-unmatched
  // "in" bank txns (e.g. after FIN checks a backlog of payments post-import).
  app.post('/api/juno/bank/automatch', async () => {
    const { matched, chequeMatched } = await runAutoMatcher();
    return { ok: true, autoMatched: matched, chequeMatched };
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
      select: { bankTxnId: true, payment: { select: { id: true, reNumber: true, chequeNo: true, receiptName: true, customerName: true, amount: true } } },
    });
    const byTxn = new Map<string, typeof links>();
    for (const l of links) byTxn.set(l.bankTxnId, [...(byTxn.get(l.bankTxnId) ?? []), l]);

    return {
      txns: txns.map((t) =>
        toBankTxnRow(
          t,
          (byTxn.get(t.id) ?? []).map((l) => ({
            paymentId: l.payment.id, reNumber: l.payment.reNumber, chequeNo: l.payment.chequeNo, receiptName: l.payment.receiptName,
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
      select: { id: true, reNumber: true, chequeNo: true, receiptName: true, customerName: true, senderName: true, amount: true, transferAt: true, createdAt: true },
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
        chequeNo: s.p.chequeNo,
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
        // Task 1 gate: cash/cheque can't be booked to Express until the CEO has confirmed
        // physical receipt (receivedAt) — transfers advance as before. Mirrors POST /status.
        where: {
          id: { in: links.map((l) => l.paymentId) },
          status: 'verified',
          OR: [{ source: { notIn: ['cash', 'cheque'] } }, { receivedAt: { not: null } }],
        },
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
        // only 'verified' advances; received/void/recorded untouched. Task 1 gate: cash/cheque
        // also need the CEO's receipt confirm (receivedAt) first — transfers advance as before.
        where: {
          id: { in: paymentIds },
          status: 'verified',
          OR: [{ source: { notIn: ['cash', 'cheque'] } }, { receivedAt: { not: null } }],
        },
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

  // ─── RE reconciliation (the "future RE-import" the WHT task's grossOf() was built for) ──
  // The CEO periodically imports Express's ARRCPDAT.TXT (AR-receipt report); every RE gets
  // cross-checked LIVE against the Juno Payment(s) that carry it (Payment.reNumbers). See
  // JUNO_BRIEF.md + parseReReceipts.ts for the file format.

  // POST /api/juno/re/import { dataB64, fileName } — parse + UPSERT an ARRCPDAT.TXT export
  // by reNumber (a re-import refreshes amount/customer/etc., never duplicates). CEO-only,
  // same large-bodyLimit + re-checked-at-onRequest reasoning as bank import above.
  app.post('/api/juno/re/import', {
    onRequest: [requireAuth, requireRole('supervisor')], // RE import is CEO-only
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

    let parsed;
    try {
      const { text } = decodeExpressBytes(buf);
      parsed = parseReReceipts(text);
    } catch (err) {
      req.log.error({ err }, 're import: parse failed');
      return reply.code(422).send({ error: 'parse_failed' });
    }
    if (parsed.parsedCount === 0) {
      return reply.code(422).send({ error: 'no_receipts', detail: 'ไม่พบรายการใบเสร็จในไฟล์ — ตรวจสอบว่าเป็นไฟล์ ARRCPDAT.TXT ที่ถูกต้อง' });
    }

    // UPSERT each receipt by reNumber, CHUNKed the same way bank import chunks its inserts —
    // this file can carry a few hundred receipts and each upsert is its own round trip.
    let imported = 0;
    let updated = 0;
    const CHUNK = 50;
    for (let i = 0; i < parsed.receipts.length; i += CHUNK) {
      const slice = parsed.receipts.slice(i, i + CHUNK);
      const results = await prisma.$transaction(
        slice.map((r) =>
          prisma.reReceipt.upsert({
            where: { reNumber: r.reNumber },
            create: {
              reNumber: r.reNumber,
              receiptDate: r.receiptDate,
              customerName: r.customerName,
              salesName: r.salesName,
              amount: r.amount.toFixed(2),
              notPosted: r.notPosted,
              invoices: r.invoices as unknown as object,
              importedAt: new Date(),
            },
            update: {
              receiptDate: r.receiptDate,
              customerName: r.customerName,
              salesName: r.salesName,
              amount: r.amount.toFixed(2),
              notPosted: r.notPosted,
              invoices: r.invoices as unknown as object,
              importedAt: new Date(),
            },
          }),
        ),
      );
      // Prisma upsert doesn't report create-vs-update directly; infer it from createdAt ===
      // updatedAt (true only on the row's first-ever write, satang-safe since both are
      // server `now()` timestamps set in the same statement).
      for (const row of results) {
        if (row.createdAt.getTime() === row.updatedAt.getTime()) imported++;
        else updated++;
      }
    }

    req.log.info({ by: req.agent?.id, parsed: parsed.parsedCount, imported, updated }, 're receipts imported');

    return {
      parsed: parsed.parsedCount,
      imported,
      updated,
      cancelledSkipped: parsed.cancelledSkipped,
      totalAmount: parsed.totalAmount,
      fileTotal: parsed.fileTotal,
      totalsMatch: parsed.totalsMatch,
    };
  });

  // GET /api/juno/re?status=&q=&from=&to= — the กระทบยอด RE tab: every imported RE, each
  // cross-checked LIVE against current Payments (never stored — always up to date). Visible
  // to every Juno user (no supervisor gate, unlike the import above). Built in ≤2 queries
  // total (ReReceipt list + one Payment scan), never one query per RE.
  const reQuerySchema = z.object({
    status: z.enum(['all', 'matched', 'mismatch', 'unpaid']).optional(),
    q: z.string().max(120).optional(),
    from: z.string().max(20).optional(),
    to: z.string().max(20).optional(),
  });
  app.get('/api/juno/re', async (req, reply) => {
    const parsedQ = reQuerySchema.safeParse(req.query ?? {});
    if (!parsedQ.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsedQ.data;

    const where: Record<string, unknown> = {};
    if (q.q?.trim()) {
      const needle = q.q.trim();
      where.OR = [
        { reNumber: { contains: needle, mode: 'insensitive' } },
        { customerName: { contains: needle, mode: 'insensitive' } },
      ];
    }
    // receiptDate is stored as printed ("dd/mm/yy", Thai Buddhist) — not a real date column,
    // so a from/to range can't be pushed into SQL. Filtered in JS below instead (same
    // "feasible, not exact SQL range" compromise the spec allows for).
    const receiptDateInRange = (dd: string): boolean => {
      if (!q.from && !q.to) return true;
      const m = dd.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
      if (!m) return true; // unparseable date — don't hide it behind a range filter
      const greg = 2500 + Number(m[3]) - 543;
      const iso = `${greg}-${m[2]}-${m[1]}`;
      if (q.from && iso < q.from) return false;
      if (q.to && iso > q.to) return false;
      return true;
    };

    // Query 1: every RE row matching the text filter (status filtering happens after the
    // live match computation below, since status isn't a stored column).
    const receipts = await prisma.reReceipt.findMany({ where, orderBy: { reNumber: 'desc' } });

    // Query 2: every candidate Payment that could possibly cover an RE — non-void, at least
    // one reNumber — loaded ONCE and grouped in JS into a reCore -> payments[] map. This is
    // the whole reason it's 2 queries instead of N: no per-RE lookup.
    const candidatePayments = await prisma.payment.findMany({
      where: { status: { not: 'void' }, reNumbers: { isEmpty: false } },
      select: { id: true, reNumbers: true, amount: true, whtAmount: true, customerName: true, status: true },
    });
    const byRe = new Map<string, typeof candidatePayments>();
    for (const p of candidatePayments) {
      for (const re of p.reNumbers) {
        const list = byRe.get(re);
        if (list) list.push(p);
        else byRe.set(re, [p]);
      }
    }

    // A transfer covering several REs must be priced against the SUM of the receipts it pays, so we
    // need the gross of EVERY covered RE core — including ones a text filter dropped from `receipts`.
    // Seed the amount map from the rows we already loaded (free), then fetch only the missing cores
    // (usually none → still 2 queries; the gap query is bounded by the cores a payment references).
    const reAmountByCore = new Map<string, string>();
    for (const r of receipts) reAmountByCore.set(r.reNumber, r.amount);
    const missingCores = [...byRe.keys()].filter((c) => !reAmountByCore.has(c));
    if (missingCores.length) {
      const extra = await prisma.reReceipt.findMany({
        where: { reNumber: { in: missingCores } },
        select: { reNumber: true, amount: true },
      });
      for (const rr of extra) reAmountByCore.set(rr.reNumber, rr.amount);
    }

    const rows = receipts
      .filter((r) => receiptDateInRange(r.receiptDate))
      .map((r) => {
        // Apportion each covering transfer by this RE's own receipt amount — never add a multi-RE
        // payment's whole gross to every RE it lists (that was the double-count bug). See reRecon.ts.
        const c = computeReRow(r.amount, byRe.get(r.reNumber) ?? [], reAmountByCore);
        return {
          id: r.id,
          reNumber: r.reNumber,
          receiptDate: r.receiptDate,
          customerName: r.customerName,
          salesName: r.salesName,
          amount: num(r.amount),
          notPosted: r.notPosted,
          invoices: (r.invoices as unknown as { docNo: string; date: string; amount: number }[] | null) ?? [],
          status: c.status,
          paidGross: c.paidGross,
          diff: c.diff,
          paymentCount: c.paymentCount,
        };
      })
      .filter((r) => !q.status || q.status === 'all' || r.status === q.status);

    const summary = {
      total: rows.length,
      matched: rows.filter((r) => r.status === 'matched').length,
      mismatch: rows.filter((r) => r.status === 'mismatch').length,
      unpaid: rows.filter((r) => r.status === 'unpaid').length,
      totalAmount: rows.reduce((s, r) => s + r.amount, 0),
      matchedAmount: rows.filter((r) => r.status === 'matched').reduce((s, r) => s + r.amount, 0),
    };

    return { rows, summary };
  });

  // GET /api/juno/re/names?res=6907402,6907403 — the imported Express receipt's customer name
  // per RE core, for just the cores asked about (any Juno user). The ใบปะหน้า cover uses this so
  // ชื่อบนใบเสร็จ prints the name on the ACTUAL RE (ReReceipt.customerName) instead of the LINE
  // display name that got prefilled into receiptName — the client falls back to receiptName for
  // any core not imported yet.
  app.get('/api/juno/re/names', async (req, reply) => {
    const q = z.object({ res: z.string().max(8000).optional() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const cores = [...new Set((q.data.res ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (cores.length === 0) return {};
    const rows = await prisma.reReceipt.findMany({
      where: { reNumber: { in: cores } },
      select: { reNumber: true, customerName: true },
    });
    const map: Record<string, string> = {};
    for (const r of rows) if (r.customerName) map[r.reNumber] = r.customerName;
    return map;
  });
}
