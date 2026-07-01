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
  createdAt: Date;
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
  };
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
  app.get('/api/juno/payments', async (req) => {
    const q = z.object({
      q: z.string().max(120).optional(),
      status: z.enum(['all', ...STATUSES]).optional(),
      flagged: z.enum(['0', '1']).optional(),
      tax: z.enum(['all', ...TAX_STATUSES]).optional(),
      from: z.string().max(40).optional(), // ISO date (inclusive) — filters createdAt
      to: z.string().max(40).optional(),   // ISO date (inclusive)
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query ?? {});

    const where: Record<string, unknown> = {};
    if (q.status && q.status !== 'all') where.status = q.status;
    if (q.flagged === '1') where.flagged = true;
    if (q.tax && q.tax !== 'all') where.taxInvoiceStatus = q.tax;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      const from = q.from ? new Date(q.from) : null;
      const to = q.to ? new Date(q.to) : null;
      if (from && !Number.isNaN(from.getTime())) range.gte = from;
      if (to && !Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999); // make `to` inclusive of the whole day
        range.lte = to;
      }
      if (Object.keys(range).length) where.createdAt = range;
    }
    const term = q.q?.trim();
    if (term) {
      where.OR = [
        { customerName: { contains: term, mode: 'insensitive' } },
        { customerCode: { contains: term, mode: 'insensitive' } },
        { senderName: { contains: term, mode: 'insensitive' } },
        { ref: { contains: term, mode: 'insensitive' } },
        { bank: { contains: term, mode: 'insensitive' } },
        { salesName: { contains: term, mode: 'insensitive' } },
        { amount: { contains: term } },
      ];
    }

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
  // Moving to verified/recorded stamps who/when; a recorded payment is finance's final word.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/status', async (req, reply) => {
    const body = z.object({ status: z.enum(STATUSES) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_status' });
    const exists = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    const advancing = body.data.status === 'verified' || body.data.status === 'recorded';
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: {
        status: body.data.status,
        ...(advancing ? { verifiedById: req.agent?.id ?? null, verifiedAt: new Date() } : {}),
      },
    });
    return { ok: true, payment: toRow(p) };
  });

  // POST /api/juno/payments/:id/flag { flagged, note? } — raise/clear the flag queue.
  // Appends an optional finance note (keeps the sales-entered note intact) for the audit trail.
  app.post<{ Params: { id: string } }>('/api/juno/payments/:id/flag', async (req, reply) => {
    const body = z.object({ flagged: z.boolean(), note: z.string().max(600).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const cur = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const extra = body.data.note?.trim();
    const note = extra ? (cur.note ? `${cur.note}\n[finance] ${extra}` : `[finance] ${extra}`) : cur.note;
    const p = await prisma.payment.update({
      where: { id: req.params.id },
      data: { flagged: body.data.flagged, note },
    });
    return { ok: true, payment: toRow(p) };
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
  app.get('/api/juno/reports', async (req) => {
    const q = z.object({
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      groupBy: z.enum(['day', 'rep', 'bank', 'customer']).optional(),
    }).parse(req.query ?? {});

    const where: Record<string, unknown> = { status: { not: 'void' } };
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      const from = q.from ? new Date(q.from) : null;
      const to = q.to ? new Date(q.to) : null;
      if (from && !Number.isNaN(from.getTime())) range.gte = from;
      if (to && !Number.isNaN(to.getTime())) { to.setHours(23, 59, 59, 999); range.lte = to; }
      if (Object.keys(range).length) where.createdAt = range;
    }

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
      if (groupBy === 'day') { key = r.createdAt.toISOString().slice(0, 10); label = key; }
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

  // GET /api/juno/export.csv?from=&to=&status=&flagged=&tax= — one-click sheet-style export.
  // Same filters as the inbox. Excel-friendly (UTF-8 BOM so Thai renders in Excel).
  app.get('/api/juno/export.csv', async (req, reply) => {
    const q = z.object({
      status: z.enum(['all', ...STATUSES]).optional(),
      flagged: z.enum(['0', '1']).optional(),
      tax: z.enum(['all', ...TAX_STATUSES]).optional(),
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
    }).parse(req.query ?? {});

    const where: Record<string, unknown> = {};
    if (q.status && q.status !== 'all') where.status = q.status;
    if (q.flagged === '1') where.flagged = true;
    if (q.tax && q.tax !== 'all') where.taxInvoiceStatus = q.tax;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      const from = q.from ? new Date(q.from) : null;
      const to = q.to ? new Date(q.to) : null;
      if (from && !Number.isNaN(from.getTime())) range.gte = from;
      if (to && !Number.isNaN(to.getTime())) { to.setHours(23, 59, 59, 999); range.lte = to; }
      if (Object.keys(range).length) where.createdAt = range;
    }

    const rows = await prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000 });
    const headers = [
      'createdAt', 'code', 'customer', 'sender', 'amount', 'ocrAmount', 'bank',
      'transferAt', 'ref', 'sales', 'status', 'flagged', 'taxInvoiceStatus', 'taxInvoice', 'note',
    ];
    const esc = (v: unknown): string => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const p of rows) {
      lines.push([
        p.createdAt.toISOString(), p.customerCode, p.customerName, p.senderName, p.amount, p.ocrAmount,
        p.bank, p.transferAt, p.ref, p.salesName, p.status, p.flagged ? 'yes' : '', p.taxInvoiceStatus,
        p.taxInvoice, p.note,
      ].map(esc).join(','));
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="juno-payments.csv"');
    return reply.send('﻿' + lines.join('\r\n'));
  });
}
