import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../env.js';
import { requireCeresRole, ceresRole as ceresRoleOf } from '../../ceres/auth.js';
import { saveCeresReceipt, readCeresReceiptMeta } from '../../ceres/receiptStore.js';
import { readReceiptImage } from '../../llm/readReceipt.js';
import { ceresReceiptUrl, isValidAmount, thaiDayKey, thaiDayRange, toExpenseRow, computeBoard } from './common.js';

const ENTITIES = ['PROM', 'DENL'] as const;

function reqBase(req: { headers: Record<string, unknown> }): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  return `${proto}://${req.headers.host}`;
}

// POST /close guard failures inside the transaction surface as typed throws → 409s.
class CloseGuard extends Error {
  constructor(public code: 'already_closed_today' | 'pending_exist', public pendingCount = 0) {
    super(code);
  }
}

// P1 (petty cash) routes — messenger self-entry, Nee approval, expected-change
// board, manual daily close. Mounted under the requireCeresAuth scope (see
// routes/ceres/index.ts) — every route here already has req.agent set.
export function p1Routes(app: FastifyInstance) {
  // GET /api/ceres/bootstrap — role + identity + reference data for the frontend shell.
  app.get('/api/ceres/bootstrap', async (req) => {
    const agent = req.agent!;
    const role = ceresRoleOf(agent) as 'messenger' | 'md' | 'ceo';
    const [party, categories, parties] = await Promise.all([
      prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } }),
      prisma.ceresCategory.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      role === 'md' || role === 'ceo'
        ? prisma.ceresParty.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } })
        : Promise.resolve([]),
    ]);
    return {
      role,
      agent: { id: agent.id, name: agent.name },
      party: party ? { id: party.id, name: party.name } : null,
      categories,
      parties,
      entities: ENTITIES,
      floor: env.CERES_FLOOR,
      ceoThreshold: env.CERES_CEO_THRESHOLD,
    };
  });

  // POST /api/ceres/receipts { dataB64, contentType } — save a receipt photo + best-effort OCR.
  app.post(
    '/api/ceres/receipts',
    {
      preHandler: requireCeresRole('messenger', 'md', 'ceo'),
      bodyLimit: 15 * 1024 * 1024,
    },
    async (req, reply) => {
      const body = z.object({ dataB64: z.string().min(1), contentType: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const saved = await saveCeresReceipt(body.data.dataB64, body.data.contentType);
      if (!saved) return reply.code(400).send({ error: 'invalid_image' });

      const buf = Buffer.from(body.data.dataB64, 'base64');
      const ocrFields = await readReceiptImage(buf, body.data.contentType).catch(() => ({ amount: '', vendor: '', dateText: '' }));

      return {
        uploadId: saved.uploadId,
        url: ceresReceiptUrl(reqBase(req), saved.uploadId),
        ocr: ocrFields,
      };
    },
  );

  // POST /api/ceres/expenses — messenger self-entry / md,ceo carrier-bucket entry.
  const expenseBody = z.object({
    entity: z.enum(ENTITIES),
    category: z.string().min(1),
    customerNote: z.string().max(300).optional(),
    amount: z.string().refine(isValidAmount, 'invalid_amount'),
    spentAt: z.string().datetime().optional(),
    receiptUploadId: z.string().optional(),
    note: z.string().max(600).optional(),
    partyId: z.string().optional(),
  });
  app.post('/api/ceres/expenses', { preHandler: requireCeresRole('messenger', 'md', 'ceo') }, async (req, reply) => {
    const parsed = expenseBody.safeParse(req.body);
    if (!parsed.success) {
      const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const b = parsed.data;
    const agent = req.agent!;
    const role = ceresRoleOf(agent);

    let partyId: string | null = null;
    let partyName = '';
    if (role === 'messenger') {
      const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email, active: true } });
      if (!own) return reply.code(403).send({ error: 'no_party' });
      partyId = own.id;
      partyName = own.name;
    } else {
      // md/ceo must pick a party too — a party-less expense would never appear on the
      // board or in a settlement line (every sum keys by partyId), i.e. it would be
      // stamped "settled" invisibly. The seeded party list always offers a right
      // choice (carrier buckets + ทั่วไป).
      if (!b.partyId) return reply.code(400).send({ error: 'missing_party' });
      const p = await prisma.ceresParty.findUnique({ where: { id: b.partyId } });
      if (!p || !p.active) return reply.code(400).send({ error: 'invalid_party' });
      partyId = p.id;
      partyName = p.name;
    }

    let receiptSha = '';
    if (b.receiptUploadId) {
      const meta = await readCeresReceiptMeta(b.receiptUploadId);
      if (meta) receiptSha = meta.sha256;
    }

    const expense = await prisma.ceresExpense.create({
      data: {
        partyId,
        partyName,
        enteredById: agent.id,
        enteredByName: agent.name,
        entity: b.entity,
        category: b.category,
        customerNote: b.customerNote ?? '',
        amount: b.amount,
        spentAt: b.spentAt ? new Date(b.spentAt) : new Date(),
        receiptUploadId: b.receiptUploadId ?? null,
        receiptSha,
        note: b.note ?? '',
        status: 'pending',
      },
    });
    return { expense: toExpenseRow(expense, reqBase(req)) };
  });

  // GET /api/ceres/expenses?scope=mine|all&status=&from=&to=&partyId=
  const listQuery = z.object({
    scope: z.enum(['mine', 'all']).optional(),
    status: z.enum(['pending', 'approved', 'settled', 'rejected']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    partyId: z.string().optional(),
  });
  app.get('/api/ceres/expenses', { preHandler: requireCeresRole('messenger', 'md', 'ceo') }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    const agent = req.agent!;
    const role = ceresRoleOf(agent);

    const where: Record<string, unknown> = {};
    if (role === 'messenger' || q.scope === 'mine') {
      const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } });
      where.partyId = own?.id ?? '__none__';
    } else if (q.partyId) {
      where.partyId = q.partyId;
    }
    if (q.status) where.status = q.status;
    const range = thaiDayRange(q.from, q.to);
    if (range) where.createdAt = range;

    const rows = await prisma.ceresExpense.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    const base = reqBase(req);
    return { expenses: rows.map((e) => toExpenseRow(e, base)) };
  });

  // PATCH /api/ceres/expenses/:id — edit (own+pending for messenger; any non-settled for md/ceo).
  const patchBody = z.object({
    entity: z.enum(ENTITIES).optional(),
    category: z.string().min(1).optional(),
    customerNote: z.string().max(300).optional(),
    amount: z.string().refine(isValidAmount, 'invalid_amount').optional(),
    spentAt: z.string().datetime().optional(),
    receiptUploadId: z.string().optional(),
    note: z.string().max(600).optional(),
    reason: z.string().max(300).optional(),
  });
  app.patch<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id',
    { preHandler: requireCeresRole('messenger', 'md', 'ceo') },
    async (req, reply) => {
      const parsed = patchBody.safeParse(req.body);
      if (!parsed.success) {
        const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
        return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
      }
      const b = parsed.data;
      const agent = req.agent!;
      const role = ceresRoleOf(agent);

      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status === 'settled') return reply.code(409).send({ error: 'settled_locked' });

      if (role === 'messenger') {
        const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } });
        if (!own || existing.partyId !== own.id) return reply.code(403).send({ error: 'not_yours' });
        // approved/rejected — not necessarily settled (that case 409'd above for everyone)
        if (existing.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
      }

      const { reason, ...fields } = b;
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (k === 'spentAt') { changed[k] = new Date(v as string); continue; }
        changed[k] = v;
      }
      if (Object.keys(changed).length === 0) {
        return { expense: toExpenseRow(existing, reqBase(req)) };
      }
      // Swapping the receipt must also refresh receiptSha, or duplicate detection
      // would keep keying off the OLD image's hash. Empty when the meta is missing.
      if ('receiptUploadId' in changed) {
        const meta = await readCeresReceiptMeta(changed.receiptUploadId as string);
        changed.receiptSha = meta?.sha256 ?? '';
      }

      // Editing a non-pending row after the fact writes a revision (never a silent
      // overwrite) and the row STAYS in its current status (CERES_BRIEF §5 integrity model).
      const needsRevision = existing.status !== 'pending';
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(changed)) {
        before[k] = (existing as Record<string, unknown>)[k];
      }

      const [updated] = await prisma.$transaction([
        prisma.ceresExpense.update({ where: { id: existing.id }, data: changed }),
        ...(needsRevision
          ? [
              prisma.ceresRevision.create({
                data: {
                  subjectType: 'expense',
                  subjectId: existing.id,
                  changedById: agent.id,
                  changedByName: agent.name,
                  // JSON round-trip: `changed`/`before` can hold Date values (e.g. spentAt),
                  // which aren't valid Prisma JSON input on their own — stringify first so
                  // the stored revision is plain JSON-safe (dates become ISO strings).
                  before: JSON.parse(JSON.stringify(before)),
                  after: JSON.parse(JSON.stringify(changed)),
                  reason: reason ?? '',
                },
              }),
            ]
          : []),
      ]);
      return { expense: toExpenseRow(updated, reqBase(req)) };
    },
  );

  // DELETE /api/ceres/expenses/:id — pending only (drafts), for anyone who owns/manages it.
  app.delete<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id',
    { preHandler: requireCeresRole('messenger', 'md', 'ceo') },
    async (req, reply) => {
      const agent = req.agent!;
      const role = ceresRoleOf(agent);
      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });

      if (role === 'messenger') {
        const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } });
        if (!own || existing.partyId !== own.id) return reply.code(403).send({ error: 'not_yours' });
      }

      await prisma.ceresExpense.delete({ where: { id: existing.id } });
      return { ok: true };
    },
  );

  // POST /api/ceres/expenses/:id/approve — Nee's daily approval (P1 step 3).
  app.post<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id/approve',
    { preHandler: requireCeresRole('md', 'ceo') },
    async (req, reply) => {
      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
      const updated = await prisma.ceresExpense.update({
        where: { id: existing.id },
        data: { status: 'approved', approvedById: req.agent!.id, approvedAt: new Date() },
      });
      return { expense: toExpenseRow(updated, reqBase(req)) };
    },
  );

  // POST /api/ceres/expenses/:id/reject { reason }
  app.post<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id/reject',
    { preHandler: requireCeresRole('md', 'ceo') },
    async (req, reply) => {
      const body = z.object({ reason: z.string().min(1).max(300) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
      const updated = await prisma.ceresExpense.update({
        where: { id: existing.id },
        data: { status: 'rejected', rejectReason: body.data.reason },
      });
      return { expense: toExpenseRow(updated, reqBase(req)) };
    },
  );

  // POST /api/ceres/advances { partyId, amount, entity?, note? } — Nee's morning cash advance.
  app.post('/api/ceres/advances', { preHandler: requireCeresRole('md', 'ceo') }, async (req, reply) => {
    const body = z
      .object({
        partyId: z.string().min(1),
        amount: z.string().refine(isValidAmount, 'invalid_amount'),
        entity: z.enum(ENTITIES).optional(),
        note: z.string().max(600).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      const amountIssue = body.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const party = await prisma.ceresParty.findUnique({ where: { id: body.data.partyId } });
    if (!party || !party.active) return reply.code(400).send({ error: 'invalid_party' });
    const movement = await prisma.cashMovement.create({
      data: {
        accountId: 'pettyCash',
        type: 'advance',
        partyId: party.id,
        partyName: party.name,
        entity: body.data.entity ?? '',
        amount: body.data.amount,
        note: body.data.note ?? '',
        createdById: req.agent!.id,
        createdByName: req.agent!.name,
      },
    });
    return { movement };
  });

  // POST /api/ceres/refunds { partyId, amount, note? } — messenger returns unspent cash.
  app.post('/api/ceres/refunds', { preHandler: requireCeresRole('md', 'ceo') }, async (req, reply) => {
    const body = z
      .object({
        partyId: z.string().min(1),
        amount: z.string().refine(isValidAmount, 'invalid_amount'),
        note: z.string().max(600).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      const amountIssue = body.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const party = await prisma.ceresParty.findUnique({ where: { id: body.data.partyId } });
    if (!party || !party.active) return reply.code(400).send({ error: 'invalid_party' });
    const movement = await prisma.cashMovement.create({
      data: {
        accountId: 'pettyCash',
        type: 'refund',
        partyId: party.id,
        partyName: party.name,
        amount: body.data.amount,
        note: body.data.note ?? '',
        createdById: req.agent!.id,
        createdByName: req.agent!.name,
      },
    });
    return { movement };
  });

  // POST /api/ceres/movements { type: deposit|topup, amount, note? } — box deposit / CEO top-up.
  app.post('/api/ceres/movements', { preHandler: requireCeresRole('md', 'ceo') }, async (req, reply) => {
    const body = z
      .object({
        type: z.enum(['deposit', 'topup']),
        amount: z.string().refine(isValidAmount, 'invalid_amount'),
        note: z.string().max(600).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      const amountIssue = body.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const role = ceresRoleOf(req.agent!);
    if (body.data.type === 'topup' && role !== 'ceo') {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const movement = await prisma.cashMovement.create({
      data: {
        accountId: 'pettyCash',
        type: body.data.type,
        amount: body.data.amount,
        note: body.data.note ?? '',
        createdById: req.agent!.id,
        createdByName: req.agent!.name,
      },
    });
    return { movement };
  });

  // GET /api/ceres/movements?from=&to=&type=
  app.get('/api/ceres/movements', { preHandler: requireCeresRole('md', 'ceo') }, async (req, reply) => {
    const parsed = z
      .object({ from: z.string().optional(), to: z.string().optional(), type: z.string().optional() })
      .safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    const where: Record<string, unknown> = { accountId: 'pettyCash' };
    if (q.type) where.type = q.type;
    const range = thaiDayRange(q.from, q.to);
    if (range) where.createdAt = range;
    const movements = await prisma.cashMovement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    return { movements };
  });

  // GET /api/ceres/board — Nee's expected-change board (P1 step 3).
  app.get('/api/ceres/board', { preHandler: requireCeresRole('md', 'ceo') }, async () => {
    const { settlement, parties, box } = await computeBoard();
    return {
      dayKey: thaiDayKey(new Date()),
      box,
      sinceSettlementId: settlement?.id ?? null,
      parties,
    };
  });

  // POST /api/ceres/close { note? } — Nee's manual daily settlement (P1 step 4).
  // The whole close — guards, board computation, settlement + lines + expense
  // stamping — runs in ONE interactive transaction, with every movement read clipped
  // to a `cutoff` instant that the settlement's createdAt is explicitly set to. A
  // CashMovement created mid-close therefore lands strictly AFTER the settlement
  // (createdAt > cutoff) and shows up in the next board's "since last settlement"
  // window instead of vanishing between the two.
  app.post('/api/ceres/close', { preHandler: requireCeresRole('md', 'ceo') }, async (req, reply) => {
    const body = z.object({ note: z.string().max(600).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const cutoff = new Date();
    const dayKey = thaiDayKey(cutoff);

    let settlement;
    try {
      settlement = await prisma.$transaction(async (tx) => {
        const already = await tx.ceresSettlement.findUnique({ where: { dayKey } });
        if (already) throw new CloseGuard('already_closed_today');

        const pendingCount = await tx.ceresExpense.count({ where: { status: 'pending' } });
        if (pendingCount > 0) throw new CloseGuard('pending_exist', pendingCount);

        const { parties, box } = await computeBoard({ tx, cutoff });
        const approvedIds = (
          await tx.ceresExpense.findMany({ where: { status: 'approved', settlementId: null }, select: { id: true } })
        ).map((e) => e.id);

        const created = await tx.ceresSettlement.create({
          data: {
            dayKey,
            closedById: req.agent!.id,
            closedByName: req.agent!.name,
            boxBefore: box.balance.toFixed(2),
            boxAfter: box.balance.toFixed(2),
            note: body.data.note ?? '',
            createdAt: cutoff, // MUST equal the computeBoard cutoff — see route comment
          },
        });
        for (const p of parties) {
          const outstanding = p.expectedChange;
          const hasActivity =
            p.advancesSince !== 0 || p.refundsSince !== 0 || p.approvedSince !== 0 || p.outstandingBefore !== 0;
          if (!hasActivity) continue;
          await tx.ceresSettlementLine.create({
            data: {
              settlementId: created.id,
              partyId: p.partyId,
              partyName: p.partyName,
              advances: p.advancesSince.toFixed(2),
              expenses: p.approvedSince.toFixed(2),
              refunds: p.refundsSince.toFixed(2),
              outstanding: outstanding.toFixed(2),
            },
          });
        }
        if (approvedIds.length > 0) {
          await tx.ceresExpense.updateMany({
            where: { id: { in: approvedIds } },
            data: { settlementId: created.id, status: 'settled' },
          });
        }
        return created;
      });
    } catch (err) {
      if (err instanceof CloseGuard) {
        return reply
          .code(409)
          .send(err.code === 'pending_exist' ? { error: err.code, pendingCount: err.pendingCount } : { error: err.code });
      }
      throw err;
    }

    const lines = await prisma.ceresSettlementLine.findMany({ where: { settlementId: settlement.id } });
    return { settlement: { ...settlement, lines } };
  });

  // GET /api/ceres/settlements?limit=
  app.get('/api/ceres/settlements', { preHandler: requireCeresRole('md', 'ceo') }, async (req, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const settlements = await prisma.ceresSettlement.findMany({
      orderBy: { createdAt: 'desc' },
      take: parsed.data.limit ?? 30,
      include: { lines: true },
    });
    return { settlements };
  });
}
