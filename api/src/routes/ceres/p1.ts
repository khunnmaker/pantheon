import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../env.js';
import { requireCeresRole, ceresRole as ceresRoleOf } from '../../ceres/auth.js';
import { saveCeresReceipt, readCeresReceiptMeta, saveCeresReceiptOcr } from '../../ceres/receiptStore.js';
import {
  ceresMediaPurposeSchema,
  mediaCanBeAttachedBy,
  mediaVisibleToAgent,
  type CeresMediaPurpose,
} from '../../ceres/mediaAccess.js';
import { ceresReceiptExpiry } from '../../ceres/receiptLink.js';
import {
  lockPettyCash,
  syncAdvanceLiquidationProjection,
} from '../../ceres/requestMoney.js';
import { readReceiptImage } from '../../llm/readReceipt.js';
import { reviewExpensePostHoc } from '../../ceres/aiReview.js';
import { ceresReceiptUrl, isValidAmount, thaiDayKey, thaiDayRange, toExpenseRow, computeBoard } from './common.js';
import { GROUP_COMPANY_CODES } from '../../jupiter/companies.js';

// The 5 group companies (SSOT: jupiter/companies.ts, matches JupiterCompany). Widened from the
// old ['PROM','DENL'] so Ceres can record TONR/DENC/KPKF spend and a future Ceres→Jupiter sync
// can attribute it to the right company. Ceres emits this list to the client via bootstrap.
const ENTITIES = GROUP_COMPANY_CODES;

function reqBase(req: { headers: Record<string, unknown> }): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  return `${proto}://${req.headers.host}`;
}

// POST /close guard failures inside the transaction surface as typed throws → 409s.
class CloseGuard extends Error {
  constructor(public code: 'already_closed_today' | 'pending_exist' | 'negative_box_balance', public pendingCount = 0) {
    super(code);
  }
}

class AdvanceGuard extends Error {}

// P1 (petty cash) routes — messenger self-entry, Nee approval, expected-change
// board, manual daily close. Mounted under the requireCeresAuth scope (see
// routes/ceres/index.ts) — every route here already has req.agent set.
export function p1Routes(app: FastifyInstance) {
  // GET /api/ceres/bootstrap — role + identity + reference data for the frontend shell.
  app.get('/api/ceres/bootstrap', async (req) => {
    const agent = req.agent!;
    const role = ceresRoleOf(agent) as 'messenger' | 'gm' | 'ceo';
    const [party, categories, parties] = await Promise.all([
      prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } }),
      prisma.ceresCategory.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      role === 'gm' || role === 'ceo'
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

  const mediaUploadBody = z.object({
    dataB64: z.string().min(1),
    contentType: z.string().min(1),
    purpose: ceresMediaPurposeSchema.optional(),
  });
  const uploadMedia = async (
    req: FastifyRequest,
    reply: FastifyReply,
    forcedPurpose?: CeresMediaPurpose,
  ) => {
    const body = mediaUploadBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const purpose = forcedPurpose ?? body.data.purpose;
    if (!purpose) return reply.code(400).send({ error: 'invalid_purpose' });

    const saved = await saveCeresReceipt(body.data.dataB64, body.data.contentType);
    if (!saved) return reply.code(400).send({ error: 'invalid_image' });
    const buf = Buffer.from(body.data.dataB64, 'base64');
    // Duplicate check + OCR are independent reads off the just-saved upload — run
    // them concurrently rather than back-to-back.
    const [dup, ocrFields] = await Promise.all([
      prisma.ceresExpense.findFirst({
        where: { receiptSha: saved.sha256, status: { notIn: ['rejected', 'void'] } },
        orderBy: { createdAt: 'desc' },
      }),
      readReceiptImage(buf, body.data.contentType).catch(() => ({ amount: '', vendor: '', dateText: '' })),
    ]);
    await Promise.all([
      saveCeresReceiptOcr(saved.uploadId, ocrFields),
      prisma.ceresMedia.create({
        data: {
          id: saved.uploadId,
          purpose,
          sha256: saved.sha256,
          uploadedById: req.agent!.id,
          uploadedByName: req.agent!.name,
        },
      }),
    ]);

    return {
      uploadId: saved.uploadId,
      url: ceresReceiptUrl(reqBase(req), saved.uploadId),
      ocr: ocrFields,
      // Informational only — nothing is blocked. No ids: the messenger only needs
      // the human summary of the earlier entry that used this same photo.
      duplicate: dup ? { partyName: dup.partyName, amount: dup.amount, spentAt: dup.spentAt.toISOString() } : null,
    };
  };

  // The old endpoint remains an exact compatibility alias.
  app.post(
    '/api/ceres/receipts',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo'), bodyLimit: 15 * 1024 * 1024 },
    (req, reply) => uploadMedia(req, reply, 'legacy_receipt'),
  );

  app.post(
    '/api/ceres/media',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo'), bodyLimit: 15 * 1024 * 1024 },
    (req, reply) => uploadMedia(req, reply),
  );

  app.get<{ Params: { id: string } }>(
    '/api/ceres/media/:id/url',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const media = await mediaVisibleToAgent(req.params.id, req.agent!);
      if (!media) return reply.code(404).send({ error: 'not_found' });
      const now = Date.now();
      return {
        url: ceresReceiptUrl(reqBase(req), media.id, now),
        expiresAt: new Date(ceresReceiptExpiry(now) * 1000).toISOString(),
      };
    },
  );

  // POST /api/ceres/expenses — messenger self-entry / gm,ceo carrier-bucket entry.
  const expenseBody = z.object({
    entity: z.enum(ENTITIES),
    category: z.string().min(1),
    customerNote: z.string().max(300).optional(),
    amount: z.string().refine(isValidAmount, 'invalid_amount'),
    spentAt: z.string().datetime().optional(),
    receiptUploadId: z.string().optional(),
    ocrAmount: z.string().max(80).optional(),
    ocrVendor: z.string().max(200).optional(),
    ocrDate: z.string().max(80).optional(),
    note: z.string().max(600).optional(),
    partyId: z.string().optional(),
    advanceRequestId: z.string().min(1).optional(),
  });
  app.post('/api/ceres/expenses', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
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
      // gm/ceo must pick a party too — a party-less expense would never appear on the
      // board or in a settlement line (every sum keys by partyId), i.e. it would be
      // stamped "settled" invisibly. The seeded party list always offers a right
      // choice (carrier buckets + ทั่วไป).
      if (!b.partyId) return reply.code(400).send({ error: 'missing_party' });
      const p = await prisma.ceresParty.findUnique({ where: { id: b.partyId } });
      if (!p || !p.active) return reply.code(400).send({ error: 'invalid_party' });
      partyId = p.id;
      partyName = p.name;
    }

    let fundingLane: 'cash' | 'transfer' = 'cash';
    if (b.advanceRequestId) {
      const advance = await prisma.ceresPaymentRequest.findUnique({ where: { id: b.advanceRequestId } });
      if (!advance || advance.workflowVersion !== 2 || advance.requestType !== 'advance') {
        return reply.code(400).send({ error: 'invalid_advance' });
      }
      if (role === 'messenger') {
        if (advance.requestedById !== agent.id || advance.requesterPartyId !== partyId) {
          return reply.code(403).send({ error: 'not_yours' });
        }
      } else if (advance.requesterPartyId !== partyId) {
        return reply.code(400).send({ error: 'advance_party_mismatch' });
      }
      const events = await prisma.ceresRequestMoneyEvent.findMany({
        where: { requestId: advance.id },
        orderBy: { createdAt: 'asc' },
      });
      const reversedIds = new Set(
        events.filter((event) => event.kind === 'reversal' && event.reversesEventId).map((event) => event.reversesEventId),
      );
      const payment = events.find((event) => event.kind === 'payment' && !reversedIds.has(event.id));
      if (!payment) return reply.code(409).send({ error: 'advance_not_paid' });
      fundingLane = payment.lane === 'transfer' ? 'transfer' : 'cash';
      if (!b.receiptUploadId) return reply.code(400).send({ error: 'receipt_required' });
    }

    let receiptSha = '';
    let receiptMeta: Awaited<ReturnType<typeof readCeresReceiptMeta>> = null;
    if (b.receiptUploadId) {
      const media = await mediaCanBeAttachedBy(
        b.receiptUploadId,
        agent,
        // Liquidation receipts arrive via POST /receipts (purpose 'legacy_receipt' — that
        // pipeline carries the dup-catch + OCR); reimbursement_receipt stays accepted for
        // media uploaded through the v2 request flow.
        b.advanceRequestId ? ['reimbursement_receipt', 'legacy_receipt'] : ['legacy_receipt'],
      );
      if (!media) return reply.code(403).send({ error: 'media_not_owned' });
      receiptMeta = await readCeresReceiptMeta(b.receiptUploadId);
      receiptSha = media.sha256;
    }

    let expense;
    try {
      expense = await prisma.$transaction(async (tx) => {
        if (b.advanceRequestId) {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${b.advanceRequestId} FOR UPDATE
          `;
          const lockedEvents = await tx.ceresRequestMoneyEvent.findMany({
            where: { requestId: b.advanceRequestId },
            orderBy: { createdAt: 'asc' },
          });
          const lockedReversedIds = new Set(
            lockedEvents.filter((event) => event.kind === 'reversal' && event.reversesEventId).map((event) => event.reversesEventId),
          );
          const lockedPayment = lockedEvents.find((event) => event.kind === 'payment' && !lockedReversedIds.has(event.id));
          if (!lockedPayment) throw new AdvanceGuard('advance_not_paid');
          fundingLane = lockedPayment.lane === 'transfer' ? 'transfer' : 'cash';
        }
        const created = await tx.ceresExpense.create({
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
            ocrAmount: b.ocrAmount ?? receiptMeta?.ocrAmount ?? '',
            ocrVendor: b.ocrVendor ?? receiptMeta?.ocrVendor ?? '',
            ocrDate: b.ocrDate ?? receiptMeta?.ocrDate ?? '',
            note: b.note ?? '',
            status: 'pending',
            advanceRequestId: b.advanceRequestId ?? null,
            fundingLane,
          },
        });
        if (b.advanceRequestId) {
          await tx.ceresRequestEvent.create({
            data: {
              requestId: b.advanceRequestId,
              kind: 'liquidation_added',
              actorId: agent.id,
              actorName: agent.name,
              payload: { expenseId: created.id, amount: created.amount, fundingLane },
            },
          });
        }
        return created;
      });
    } catch (err) {
      if (err instanceof AdvanceGuard) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return { expense: toExpenseRow(expense, reqBase(req)) };
  });

  // GET /api/ceres/expenses?scope=mine|all&status=&from=&to=&partyId=
  const listQuery = z.object({
    scope: z.enum(['mine', 'all']).optional(),
    status: z.enum(['pending', 'approved', 'settled', 'rejected', 'void']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    partyId: z.string().optional(),
  });
  app.get('/api/ceres/expenses', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
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

    // Batch duplicate-receipt detection (no N+1): one findMany for every OTHER
    // non-rejected/void expense sharing one of this page's receipt hashes, then flag
    // a row when at least one match isn't the row itself (covers a returned row that
    // is itself rejected/void: it still counts as a duplicate if a live expense shares
    // its sha, but two rejected/void copies of the same photo don't flag each other).
    const shas = [...new Set(rows.map((e) => e.receiptSha).filter((s): s is string => !!s))];
    const idsBySha = new Map<string, Set<string>>();
    if (shas.length > 0) {
      const matches = await prisma.ceresExpense.findMany({
        where: { receiptSha: { in: shas }, status: { notIn: ['rejected', 'void'] } },
        select: { id: true, receiptSha: true },
      });
      for (const m of matches) {
        const set = idsBySha.get(m.receiptSha) ?? new Set<string>();
        set.add(m.id);
        idsBySha.set(m.receiptSha, set);
      }
    }
    const isDuplicate = (e: (typeof rows)[number]): boolean => {
      if (!e.receiptSha) return false;
      const ids = idsBySha.get(e.receiptSha);
      if (!ids) return false;
      return ids.has(e.id) ? ids.size > 1 : ids.size > 0;
    };

    return { expenses: rows.map((e) => toExpenseRow(e, base, isDuplicate(e))) };
  });

  // PATCH /api/ceres/expenses/:id — edit (own+pending for messenger; any non-settled for gm/ceo).
  const patchBody = z.object({
    entity: z.enum(ENTITIES).optional(),
    category: z.string().min(1).optional(),
    customerNote: z.string().max(300).optional(),
    amount: z.string().refine(isValidAmount, 'invalid_amount').optional(),
    spentAt: z.string().datetime().optional(),
    receiptUploadId: z.string().optional(),
    ocrAmount: z.string().max(80).optional(),
    ocrVendor: z.string().max(200).optional(),
    ocrDate: z.string().max(80).optional(),
    note: z.string().max(600).optional(),
    reason: z.string().max(300).optional(),
  });
  app.patch<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
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
        const uploadId = changed.receiptUploadId as string;
        const media = await mediaCanBeAttachedBy(
          uploadId,
          agent,
          existing.advanceRequestId ? ['reimbursement_receipt', 'legacy_receipt'] : ['legacy_receipt'],
        );
        if (!media) return reply.code(403).send({ error: 'media_not_owned' });
        const meta = await readCeresReceiptMeta(uploadId);
        changed.receiptSha = media.sha256;
        if (!('ocrAmount' in changed)) changed.ocrAmount = meta?.ocrAmount ?? '';
        if (!('ocrVendor' in changed)) changed.ocrVendor = meta?.ocrVendor ?? '';
        if (!('ocrDate' in changed)) changed.ocrDate = meta?.ocrDate ?? '';
      }

      // Editing a non-pending row after the fact writes a revision (never a silent
      // overwrite) and the row STAYS in its current status (CERES_BRIEF §5 integrity model).
      const needsRevision = existing.status !== 'pending';
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(changed)) {
        before[k] = (existing as Record<string, unknown>)[k];
      }

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.ceresExpense.update({ where: { id: existing.id }, data: changed });
        if (needsRevision) {
          await tx.ceresRevision.create({
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
          });
        }
        if (row.advanceRequestId && ['approved', 'settled'].includes(row.status)) {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${row.advanceRequestId} FOR UPDATE
          `;
          const advance = await tx.ceresPaymentRequest.findUnique({ where: { id: row.advanceRequestId } });
          if (advance) await syncAdvanceLiquidationProjection(tx, advance, { id: agent.id, name: agent.name });
        }
        return row;
      });
      return { expense: toExpenseRow(updated, reqBase(req)) };
    },
  );

  // DELETE /api/ceres/expenses/:id — pending only (drafts), for anyone who owns/manages it.
  app.delete<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const agent = req.agent!;
      const role = ceresRoleOf(agent);
      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
      if (existing.advanceRequestId) return reply.code(409).send({ error: 'linked_expense_locked' });

      if (role === 'messenger') {
        const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } });
        if (!own || existing.partyId !== own.id) return reply.code(403).send({ error: 'not_yours' });
      }

      await prisma.ceresExpense.delete({ where: { id: existing.id } });
      return { ok: true };
    },
  );

  // POST /api/ceres/expenses/:id/void { reason } — gm/ceo soft-delete of ANY entry
  // (approved/settled/rejected/pending). Unlike DELETE (which hard-removes a pending
  // draft), void KEEPS the row: it's excluded from every total/board/settlement but stays
  // visible struck-through with who/when/why, so a closed day's books stay auditable.
  // A voided settled entry does NOT alter its already-closed settlement snapshot (history
  // is immutable) — it just stops counting in the live views and future reports.
  app.post<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id/void',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const body = z.object({ reason: z.string().min(1).max(300) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status === 'void') return reply.code(409).send({ error: 'already_void' });
      const agent = req.agent!;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.ceresExpense.update({
          where: { id: existing.id },
          data: { status: 'void', voidedById: agent.id, voidedAt: new Date(), voidReason: body.data.reason },
        });
        await tx.ceresRevision.create({
          data: {
            subjectType: 'expense',
            subjectId: existing.id,
            changedById: agent.id,
            changedByName: agent.name,
            before: { status: existing.status },
            after: { status: 'void', voidReason: body.data.reason },
            reason: body.data.reason,
          },
        });
        if (row.advanceRequestId && ['approved', 'settled'].includes(existing.status)) {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${row.advanceRequestId} FOR UPDATE
          `;
          const advance = await tx.ceresPaymentRequest.findUnique({ where: { id: row.advanceRequestId } });
          if (advance) await syncAdvanceLiquidationProjection(tx, advance, { id: agent.id, name: agent.name });
        }
        return row;
      });
      return { expense: toExpenseRow(updated, reqBase(req)) };
    },
  );

  // POST /api/ceres/expenses/:id/approve — Nee's daily approval (P1 step 3).
  app.post<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id/approve',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const existing = await prisma.ceresExpense.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status !== 'pending') return reply.code(409).send({ error: 'not_pending' });
      const updated = await prisma.$transaction(async (tx) => {
        const approved = await tx.ceresExpense.update({
          where: { id: existing.id },
          data: { status: 'approved', approvedById: req.agent!.id, approvedAt: new Date() },
        });
        if (approved.advanceRequestId) {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${approved.advanceRequestId} FOR UPDATE
          `;
          const advance = await tx.ceresPaymentRequest.findUnique({ where: { id: approved.advanceRequestId } });
          if (advance) {
            await syncAdvanceLiquidationProjection(tx, advance, { id: req.agent!.id, name: req.agent!.name });
          }
        }
        return approved;
      });
      void reviewExpensePostHoc(updated.id).catch((err) => req.log.error({ err }, 'ceres post-hoc review failed'));
      return { expense: toExpenseRow(updated, reqBase(req)) };
    },
  );

  // POST /api/ceres/expenses/:id/reject { reason }
  app.post<{ Params: { id: string } }>(
    '/api/ceres/expenses/:id/reject',
    { preHandler: requireCeresRole('gm', 'ceo') },
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

  // POST /api/ceres/movements { type: deposit, amount, note? } — box deposit (gm+ceo).
  // 'topup' was merged into 'deposit' 2026-07-20 — the two forms were functionally identical
  // (both credited the same pettyCash box), so the CEO-only top-up form was dropped in favor of
  // this one. Old rows with type 'topup' remain in the DB and keep counting via the
  // history-compat mapping in requestMoney.ts / statements.ts — only new writes are narrowed here.
  app.post('/api/ceres/movements', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const body = z
      .object({
        type: z.literal('deposit'),
        amount: z.string().refine(isValidAmount, 'invalid_amount'),
        note: z.string().max(600).optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      const amountIssue = body.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const movement = await prisma.cashMovement.create({
      data: {
        accountId: 'pettyCash',
        type: body.data.type,
        direction: 'in',
        amount: body.data.amount,
        note: body.data.note ?? '',
        createdById: req.agent!.id,
        createdByName: req.agent!.name,
      },
    });
    return { movement };
  });

  // GET /api/ceres/movements?from=&to=&type=
  app.get('/api/ceres/movements', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
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
  app.get('/api/ceres/board', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
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
  app.post('/api/ceres/close', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const body = z.object({ note: z.string().max(600).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const cutoff = new Date();
    const dayKey = thaiDayKey(cutoff);

    let settlement;
    try {
      settlement = await prisma.$transaction(async (tx) => {
        // Cash-out and close always acquire this same serialization lock first.
        await lockPettyCash(tx);
        const already = await tx.ceresSettlement.findUnique({ where: { dayKey } });
        if (already) throw new CloseGuard('already_closed_today');

        const pendingCount = await tx.ceresExpense.count({
          where: { status: 'pending', fundingLane: { not: 'transfer' } },
        });
        if (pendingCount > 0) throw new CloseGuard('pending_exist', pendingCount);

        const { parties, box } = await computeBoard({ tx, cutoff });
        if (box.balance < 0) throw new CloseGuard('negative_box_balance');
        const approvedIds = (
          await tx.ceresExpense.findMany({
            where: { status: 'approved', settlementId: null, fundingLane: { not: 'transfer' } },
            select: { id: true },
          })
        ).map((e) => e.id);
        const snapshotted = await tx.ceresSettlementRequestLine.findMany({ select: { moneyEventId: true } });
        const cashEvents = await tx.ceresRequestMoneyEvent.findMany({
          where: {
            lane: 'cash',
            createdAt: { lte: cutoff },
            ...(snapshotted.length > 0
              ? { id: { notIn: snapshotted.map((line) => line.moneyEventId) } }
              : {}),
          },
          orderBy: { createdAt: 'asc' },
        });
        const cashRequestIds = [...new Set(cashEvents.map((event) => event.requestId))];
        const cashRequests = cashRequestIds.length > 0
          ? await tx.ceresPaymentRequest.findMany({
              where: { id: { in: cashRequestIds } },
              select: { id: true, requestedByName: true },
            })
          : [];
        const cashRequestNames = new Map(cashRequests.map((request) => [request.id, request.requestedByName]));

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
        for (const event of cashEvents) {
          await tx.ceresSettlementRequestLine.create({
            data: {
              settlementId: created.id,
              requestId: event.requestId,
              moneyEventId: event.id,
              kind: event.kind,
              partyName: cashRequestNames.get(event.requestId) ?? '',
              amount: event.amount,
              createdAt: cutoff,
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

    const [lines, requestLines] = await Promise.all([
      prisma.ceresSettlementLine.findMany({ where: { settlementId: settlement.id } }),
      prisma.ceresSettlementRequestLine.findMany({ where: { settlementId: settlement.id } }),
    ]);
    return { settlement: { ...settlement, lines, requestLines } };
  });

  // GET /api/ceres/settlements?limit=
  app.get('/api/ceres/settlements', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const settlements = await prisma.ceresSettlement.findMany({
      orderBy: { createdAt: 'desc' },
      take: parsed.data.limit ?? 30,
      include: { lines: true, requestLines: true },
    });
    return { settlements };
  });
}
