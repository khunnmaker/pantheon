import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp, requireRole } from '../auth/middleware.js';
import { EFFECTIVE_ACCEPT_THRESHOLD, acceptRate, effectiveAcceptRate } from '../learning/metrics.js';
import { getAutosendCanceled } from '../autosend/config.js';
import { distillKnowledge } from '../llm/distill.js';
import { embedKbEntry, kbEmbeddingText, findSimilarKb, countActiveKbEmbeddings } from '../memory/embeddings.js';
import { hasPriceContent } from '../learning/policy.js';

// Cosine similarity at/above which a newly-promoted fact is flagged (non-blocking) as a likely
// near-duplicate or conflict with an existing KB entry, for the supervisor to reconcile. Tunable.
const KB_SIMILAR_FLAG = 0.82;

const flagBodySchema = z.object({ note: z.string().max(2000).optional() }).strict();
const resolveBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('promote'),
    kbText: z.string().max(20_000).refine((text) => text.trim().length > 0),
  }).strict(),
  z.object({ action: z.literal('reject') }).strict(),
]);

async function writeLearnedKb(opts: {
  learnedId: string;
  customerQuestion: string;
  answer: string;
  questionVariants: string[];
  ownerAgentId?: string;
}) {
  const questionVariants = Array.from(
    new Set([opts.customerQuestion, ...opts.questionVariants].map((value) => value.trim()).filter(Boolean)),
  );
  const candidateText = kbEmbeddingText({ questionVariants, answer: opts.answer });

  // Only trust semantic dedup when every active KB entry has an embedding. This remains
  // advisory: conflicts are shown to the supervisor, never silently merged.
  const [embedded, activeCount] = await Promise.all([
    countActiveKbEmbeddings(),
    prisma.kbEntry.count({ where: { status: 'active' } }),
  ]);
  const dedupUnavailable = embedded < activeCount;
  const similar = dedupUnavailable ? null : await findSimilarKb(candidateText);

  const kb = await prisma.$transaction(async (tx) => {
    const created = await tx.kbEntry.create({
      data: {
        category: 'เรียนรู้จากพนักงาน',
        questionVariants,
        answer: opts.answer,
        sensitivity: 'normal',
        source: 'learned',
        status: 'active',
        lastVerifiedAt: new Date(),
        ownerAgentId: opts.ownerAgentId,
      },
    });
    await tx.learnedAnswer.update({
      where: { id: opts.learnedId },
      data: { status: 'approved', promotedKbId: created.id },
    });
    return created;
  });

  void embedKbEntry(kb.id, candidateText);
  const similarTo =
    similar && similar.similarity >= KB_SIMILAR_FLAG
      ? {
          id: similar.id,
          category: similar.category,
          answerPreview: similar.answer.slice(0, 140),
          similarityPct: Math.round(similar.similarity * 100),
        }
      : undefined;
  return { kb, similarTo, dedupUnavailable: dedupUnavailable || undefined };
}

export async function learningRoutes(app: FastifyInstance) {
  // Console (Minerva) scope — learning capture/promotion is part of the sales console.
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('minerva'));
  const supervisorOnly = { preHandler: [requireRole('supervisor')] };

  // GET /api/learned?status=pending — captured edits (any agent can view).
  app.get('/api/learned', async (req) => {
    const status = (req.query as { status?: string })?.status;
    const learned = await prisma.learnedAnswer.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return { learned };
  });

  // POST /api/learned/:id/promote — supervisor turns an edited answer into KB.
  app.post<{ Params: { id: string } }>('/api/learned/:id/promote', supervisorOnly, async (req, reply) => {
    // Claim atomically BEFORE the slow LLM/embedding work: only one request can move
    // pending → promoting, so a double-click can't distill twice or create duplicate entries.
    const claimed = await prisma.learnedAnswer.updateMany({
      where: { id: req.params.id, status: 'pending' },
      data: { status: 'promoting' },
    });
    if (claimed.count === 0) {
      const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
      if (!rec) return reply.code(404).send({ error: 'not_found' });
      if (rec.status === 'flagged') return reply.code(409).send({ error: 'flagged_requires_resolution' });
      return reply.code(409).send({ error: rec.status === 'approved' ? 'already_promoted' : 'in_progress' });
    }
    const rec = (await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } }))!;

    // Distill the staff's approved reply into reusable knowledge (facts only — no tone, no
    // greeting/closing, no customer-specific details) BEFORE it enters the KB. The draft
    // pipeline rephrases KB facts in Minerva's own voice. [[kb-learn-knowledge-not-tone]]
    const distilled = await distillKnowledge(rec.customerQuestion, rec.finalAnswer);
    if (!distilled) {
      // Distillation unavailable (LLM down/unparseable) — release the claim; the supervisor retries.
      await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'pending' } }).catch(() => undefined);
      return reply.code(503).send({ error: 'distill_unavailable' });
    }
    if (hasPriceContent(distilled.fact)) {
      // Catalog pricing is the source of truth. A failed distillation stays pending so a
      // supervisor can retry or flag it; no monetary text is ever silently written to KB.
      await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'pending' } });
      return { ok: true, kb: null, skipped: true, reason: 'price_content' };
    }
    if (!distilled.generalizable || !distilled.fact) {
      // Too customer-specific to be general knowledge — don't pollute the KB. Resolve the
      // queued item so it doesn't linger, and tell the supervisor why nothing was added.
      await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'rejected' } });
      return { ok: true, kb: null, skipped: true, reason: 'not_generalizable' };
    }
    try {
      const result = await writeLearnedKb({
        learnedId: rec.id,
        customerQuestion: rec.customerQuestion,
        answer: distilled.fact,
        questionVariants: distilled.questionVariants,
        ownerAgentId: req.agent?.id,
      });
      return { ok: true, ...result };
    } catch (err) {
      req.log.error({ err }, 'promote transaction failed');
      await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'pending' } }).catch(() => undefined);
      return reply.code(500).send({ error: 'promote_failed' });
    }
  });

  // POST /api/learned/:id/flag — move a pending contradiction into the owner-review lane.
  app.post<{ Params: { id: string } }>('/api/learned/:id/flag', supervisorOnly, async (req, reply) => {
    const parsed = flagBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const flagged = await prisma.learnedAnswer.updateMany({
      where: { id: req.params.id, status: 'pending' },
      data: { status: 'flagged', flagNote: parsed.data.note?.trim() || null },
    });
    if (flagged.count === 0) {
      const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
      if (!rec) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'invalid_status', status: rec.status });
    }
    return { ok: true };
  });

  // POST /api/learned/:id/resolve — owner-approved resolution for a flagged conflict.
  app.post<{ Params: { id: string } }>('/api/learned/:id/resolve', supervisorOnly, async (req, reply) => {
    const parsed = resolveBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    if (parsed.data.action === 'reject') {
      const rejected = await prisma.learnedAnswer.updateMany({
        where: { id: req.params.id, status: 'flagged' },
        data: { status: 'rejected' },
      });
      if (rejected.count > 0) return { ok: true, kb: null };
      const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
      if (!rec) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'invalid_status', status: rec.status });
    }

    // Validate the exact owner-approved wording before claiming the row. A price violation is
    // a correctable request error, and the item must remain visibly flagged.
    if (hasPriceContent(parsed.data.kbText)) return reply.code(400).send({ error: 'price_content' });
    const claimed = await prisma.learnedAnswer.updateMany({
      where: { id: req.params.id, status: 'flagged' },
      data: { status: 'resolving' },
    });
    if (claimed.count === 0) {
      const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
      if (!rec) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'invalid_status', status: rec.status });
    }
    const rec = (await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } }))!;
    try {
      const result = await writeLearnedKb({
        learnedId: rec.id,
        customerQuestion: rec.customerQuestion,
        answer: parsed.data.kbText,
        questionVariants: [],
        ownerAgentId: req.agent?.id,
      });
      return { ok: true, ...result };
    } catch (err) {
      req.log.error({ err }, 'flagged resolution transaction failed');
      await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'flagged' } }).catch(() => undefined);
      return reply.code(500).send({ error: 'resolve_failed' });
    }
  });

  // POST /api/learned/:id/reject — supervisor discards a captured edit.
  app.post<{ Params: { id: string } }>('/api/learned/:id/reject', supervisorOnly, async (req, reply) => {
    const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    if (rec.status === 'flagged') return reply.code(409).send({ error: 'flagged_requires_resolution' });
    await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'rejected' } });
    return { ok: true };
  });

  // GET /api/learned/metrics — AI-accuracy data (supervisor only): per-category accept-verbatim
  // / edit / escalation counts + rate, plus a weekly trend, from the Stage-1 ReplyOutcome table.
  app.get('/api/learned/metrics', supervisorOnly, async () => {
    const cats = await prisma.$queryRaw<
      { category: string; accepted: number; edited: number; escalated: number; total: number; effectiveAccepted: number }[]
    >`
      SELECT coalesce(category, 'general') AS category,
        count(*) FILTER (WHERE outcome = 'accepted_verbatim')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'edited')::int AS edited,
        count(*) FILTER (WHERE outcome = 'accepted_verbatim' OR (outcome = 'edited' AND similarity >= ${EFFECTIVE_ACCEPT_THRESHOLD}))::int AS "effectiveAccepted",
        count(*) FILTER (WHERE outcome = 'escalated')::int AS escalated,
        count(*)::int AS total
      FROM "ReplyOutcome"
      GROUP BY 1 ORDER BY total DESC`;
    // sentAt is stored as UTC wall-time; the business runs on Asia/Bangkok (UTC+7), so shift
    // before truncating to a week — otherwise a Monday-morning Bangkok send can land in the
    // prior UTC week and get bucketed under the wrong week.
    const weekly = await prisma.$queryRaw<
      { week: string; accepted: number; edited: number; escalated: number; total: number; effectiveAccepted: number }[]
    >`
      SELECT to_char(date_trunc('week', "sentAt" + interval '7 hours'), 'YYYY-MM-DD') AS week,
        count(*) FILTER (WHERE outcome = 'accepted_verbatim')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'edited')::int AS edited,
        count(*) FILTER (WHERE outcome = 'accepted_verbatim' OR (outcome = 'edited' AND similarity >= ${EFFECTIVE_ACCEPT_THRESHOLD}))::int AS "effectiveAccepted",
        count(*) FILTER (WHERE outcome = 'escalated')::int AS escalated,
        count(*)::int AS total
      FROM "ReplyOutcome"
      WHERE "sentAt" > now() - interval '84 days'
      GROUP BY 1 ORDER BY 1`;
    const sum = (k: 'accepted' | 'edited' | 'escalated' | 'total' | 'effectiveAccepted') => cats.reduce((a, c) => a + c[k], 0);
    const overall = {
      accepted: sum('accepted'), edited: sum('edited'), escalated: sum('escalated'),
      total: sum('total'), effectiveAccepted: sum('effectiveAccepted'),
    };
    const [autoSent, lastAutoSent, canceled] = await Promise.all([
      prisma.message.count({ where: { autoSent: true } }),
      prisma.message.findFirst({ where: { autoSent: true }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      getAutosendCanceled(),
    ]);
    const withRates = <T extends { accepted: number; edited: number; effectiveAccepted: number }>(bucket: T) => ({
      ...bucket,
      acceptRate: acceptRate(bucket),
      effectiveAcceptRate: effectiveAcceptRate(bucket),
    });
    return {
      overall: withRates(overall),
      byCategory: cats.map(withRates),
      byWeek: weekly.map(withRates),
      autosend: { sent: autoSent, canceled, lastSentAt: lastAutoSent?.createdAt ?? null },
    };
  });
}
