import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { requireCeresRole } from '../../ceres/auth.js';
import { thaiDayKey, thaiDayRange } from './common.js';

// P5 — weekly export pack (CERES_BRIEF §2 P5 step 3: "Ceres provides a weekly export
// pack" for the CEO's physical cross-check). House CSV style copied exactly from
// routes/juno.ts: UTF-8 BOM, CRLF, formula-injection-safe esc(), content-disposition
// attachment headers. gm|ceo only, same gate as the rest of Ceres.

const TH_OFFSET_MS = 7 * 3600 * 1000;

// Excel evaluates a leading =/+/-/@ as a formula even inside a quoted field — neutralize
// with a leading apostrophe (renders as text). Also fold \t and \r into the safe path.
const esc = (v: unknown): string => {
  const raw = String(v ?? '');
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function sendCsv(reply: { header: (k: string, v: string) => unknown; send: (b: string) => unknown }, filenamePrefix: string, headers: string[], rows: unknown[][]) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  const today = thaiDayKey(new Date());
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${filenamePrefix}-${today}.csv"`);
  return reply.send('﻿' + lines.join('\r\n'));
}

function fmtDate(d: Date): string {
  return new Date(d.getTime() + TH_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

const rangeQuery = z.object({ from: z.string().optional(), to: z.string().optional() });

export function exportsRoutes(app: FastifyInstance) {
  // GET /api/ceres/export/expenses.csv?from=&to=
  app.get('/api/ceres/export/expenses.csv', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = rangeQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = thaiDayRange(parsed.data.from, parsed.data.to);
    const where = range ? { createdAt: range } : {};

    const rows = await prisma.ceresExpense.findMany({ where, orderBy: { createdAt: 'desc' } });
    const headers = [
      'createdAt (UTC+7)', 'party', 'enteredBy', 'entity', 'category', 'customerNote',
      'amount', 'ocrAmount', 'status', 'aiVerdict', 'approvedAt', 'settlementId', 'note',
    ];
    const data = rows.map((e) => [
      fmtDate(e.createdAt), e.partyName, e.enteredByName, e.entity, e.category, e.customerNote,
      e.amount, e.ocrAmount, e.status, e.aiVerdict, e.approvedAt ? fmtDate(e.approvedAt) : '', e.settlementId ?? '', e.note,
    ]);
    return sendCsv(reply, 'ceres-expenses', headers, data);
  });

  // GET /api/ceres/export/movements.csv?from=&to=
  app.get('/api/ceres/export/movements.csv', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = rangeQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = thaiDayRange(parsed.data.from, parsed.data.to);
    const where = range ? { createdAt: range } : {};

    const rows = await prisma.cashMovement.findMany({ where, orderBy: { createdAt: 'desc' } });
    const headers = ['createdAt (UTC+7)', 'type', 'party', 'entity', 'amount', 'note', 'createdBy'];
    const data = rows.map((m) => [fmtDate(m.createdAt), m.type, m.partyName, m.entity, m.amount, m.note, m.createdByName]);
    return sendCsv(reply, 'ceres-movements', headers, data);
  });

  // GET /api/ceres/export/requests.csv?from=&to=
  app.get('/api/ceres/export/requests.csv', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = rangeQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = thaiDayRange(parsed.data.from, parsed.data.to);
    const where = range ? { createdAt: range } : {};

    const rows = await prisma.ceresPaymentRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
    const headers = [
      'createdAt (UTC+7)', 'payee', 'entity', 'category', 'amount', 'billPeriod', 'status',
      'requestedBy', 'decidedAt', 'decisionNote', 'paidAt', 'paidRef',
    ];
    const data = rows.map((r) => [
      fmtDate(r.createdAt), r.payee, r.entity, r.category, r.amount, r.billPeriod, r.status,
      r.requestedByName, r.decidedAt ? fmtDate(r.decidedAt) : '', r.decisionNote, r.paidAt ? fmtDate(r.paidAt) : '', r.paidRef,
    ]);
    return sendCsv(reply, 'ceres-requests', headers, data);
  });

  // GET /api/ceres/export/reviews.csv?from=&to=
  app.get('/api/ceres/export/reviews.csv', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = rangeQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = thaiDayRange(parsed.data.from, parsed.data.to);
    const where = range ? { createdAt: range } : {};

    const rows = await prisma.ceresAIReview.findMany({ where, orderBy: { createdAt: 'desc' } });
    const headers = ['createdAt (UTC+7)', 'subjectType', 'subjectId', 'verdict', 'reasoning', 'policyVersion', 'model'];
    const data = rows.map((r) => [fmtDate(r.createdAt), r.subjectType, r.subjectId, r.verdict, r.reasoning, r.policyVersion, r.model]);
    return sendCsv(reply, 'ceres-reviews', headers, data);
  });

  // GET /api/ceres/export/statement-lines.csv?from=&to=
  app.get('/api/ceres/export/statement-lines.csv', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = rangeQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = thaiDayRange(parsed.data.from, parsed.data.to);
    const where = range ? { txnAt: range } : {};

    const rows = await prisma.ceresStatementLine.findMany({ where, orderBy: { txnAt: 'desc' } });
    const headers = ['txnAt (UTC+7)', 'direction', 'amount', 'channel', 'payerName', 'details', 'matchStatus', 'matchedType', 'refText'];
    const data = rows.map((l) => [fmtDate(l.txnAt), l.direction, l.amount, l.channel, l.payerName, l.details, l.matchStatus, l.matchedType, l.refText]);
    return sendCsv(reply, 'ceres-statement-lines', headers, data);
  });
}
