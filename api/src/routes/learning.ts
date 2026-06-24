import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export async function learningRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
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
    const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    if (rec.status === 'approved') return reply.code(409).send({ error: 'already_promoted' });

    const kb = await prisma.kbEntry.create({
      data: {
        category: 'เรียนรู้จากพนักงาน',
        questionVariants: [rec.customerQuestion],
        answer: rec.finalAnswer,
        sensitivity: 'normal',
        source: 'learned',
        status: 'active',
        ownerAgentId: req.agent?.id,
      },
    });
    await prisma.learnedAnswer.update({
      where: { id: rec.id },
      data: { status: 'approved', promotedKbId: kb.id },
    });
    return { ok: true, kb };
  });

  // POST /api/learned/:id/reject — supervisor discards a captured edit.
  app.post<{ Params: { id: string } }>('/api/learned/:id/reject', supervisorOnly, async (req, reply) => {
    const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'rejected' } });
    return { ok: true };
  });
}
