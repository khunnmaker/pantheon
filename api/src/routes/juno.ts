import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

// Juno finance API. Reads the Payment table (written by Minerva's /to-finance hook) and
// owns the finance lifecycle: verify → record, flag-queue triage, tax-invoice tracking,
// and reporting/export. INCOME / LINE-slip only for the MVP. Gated to supervisor for v1
// (finance logs in as Dr. M — the owner chose to reuse the supervisor role). See JUNO_BRIEF.md.

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
  createdAt: Date; reNumber: string; receiptName: string; customerType: string;
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
    // FIN's check data (see POST /payments/:id/verify — the only route that sets these)
    reNumber: p.reNumber,
    receiptName: p.receiptName,
    customerType: p.customerType,
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
});
function buildListWhere(q: z.infer<typeof listFilterSchema>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (q.status && q.status !== 'all') where.status = q.status;
  else if (q.noVoid === '1') where.status = { not: 'void' };
  if (q.flagged === '1') where.flagged = true;
  if (q.tax && q.tax !== 'all') where.taxInvoiceStatus = q.tax;
  // flag/tax queues exclude voided rows to match the summary badges (§7a)
  if ((q.flagged === '1' || (q.tax && q.tax !== 'all')) && !where.status) where.status = { not: 'void' };
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

export async function junoRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole('supervisor'));

  // GET /api/juno/summary — headline counts for the Juno dashboard / login landing.
  app.get('/api/juno/summary', async () => {
    const [total, received, verified, recorded, flagged, taxRequested] = await Promise.all([
      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'received' } }),
      prisma.payment.count({ where: { status: 'verified' } }),
      prisma.payment.count({ where: { status: 'recorded' } }),
      prisma.payment.count({ where: { flagged: true, status: { not: 'void' } } }),
      prisma.payment.count({ where: { taxInvoiceStatus: 'requested', status: { not: 'void' } } }),
    ]);
    return { total, received, verified, recorded, flagged, taxRequested };
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

  // POST /api/juno/payments/:id/status { status } — advance the lifecycle.
  // Moving to recorded stamps who/when; received/void clear the stamps (a payment moved back
  // to received, or voided, must not still read as verified-by-someone). A voided payment is
  // locked — it must be explicitly restored to 'received' before re-verifying. 'verified' is
  // NOT reachable here — the check dialog (POST /verify) is the only path, since FIN must
  // supply the RE number; this route 409s that target so the UI is forced through the modal.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/status', async (req, reply) => {
    const body = z.object({ status: z.enum(STATUSES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_status' });
    if (body.data.status === 'verified') return reply.code(409).send({ error: 'use_verify' });
    const cur = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, status: true } });
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.status === 'void' && body.data.status === 'recorded') {
      return reply.code(409).send({ error: 'void_locked' });
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

  // POST /api/juno/payments/:id/verify { reNumber, receiptName?, customerType? } — the ONLY
  // way to reach status 'verified'. FIN types the RE number issued in Express here; re-opening
  // the dialog on an already-verified payment is fine (re-verify just updates fields + re-stamps).
  const customerTypeSchema = z.enum(['โอนก่อนส่ง', 'เครดิต', 'เก็บปลายทาง', '']).default('');
  const verifyBodySchema = z.object({
    reNumber: z.string().max(40),
    receiptName: z.string().max(200).optional(),
    customerType: customerTypeSchema.optional(),
  });
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/verify', async (req, reply) => {
    const body = verifyBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    // Normalize: trim, strip a leading RE/re, require exactly 7 digits — store bare digits.
    const stripped = body.data.reNumber.trim().replace(/^re/i, '');
    if (!/^\d{7}$/.test(stripped)) return reply.code(400).send({ error: 'invalid_re' });

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
        reNumber: stripped,
        receiptName: body.data.receiptName?.trim() ?? '',
        customerType: body.data.customerType ?? '',
        ...(keepRecorded ? {} : { verifiedById: req.agent?.id ?? null, verifiedAt: new Date() }),
      },
    });

    // Duplicate-RE guard: informational only (many-to-many bank matching is expected in
    // phase B), but FIN should see it immediately in case it's a typo.
    const reDuplicates = await prisma.payment.count({
      where: { id: { not: p.id }, reNumber: stripped, status: { not: 'void' } },
    });

    return { ok: true, payment: toRow(p), reDuplicates };
  });

  // POST /api/juno/payments/:id/flag { flagged, note? } — raise/clear the flag queue.
  // Appends an optional finance note (keeps the sales-entered note intact) for the audit trail.
  // Atomic (single UPDATE) so two near-simultaneous flag notes can't clobber one another.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/flag', async (req, reply) => {
    const body = z.object({ flagged: z.boolean(), note: z.string().max(600).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
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
  app.get('/api/juno/reports', async (req, reply) => {
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
  app.get('/api/juno/export.csv', async (req, reply) => {
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
      ].map(esc).join(','));
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="juno-payments.csv"');
    return reply.send('﻿' + lines.join('\r\n'));
  });
}
