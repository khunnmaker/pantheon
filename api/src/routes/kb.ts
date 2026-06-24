import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

const sensitivity = z.enum(['normal', 'price_stock', 'clinical', 'no_auto']);

const createBody = z.object({
  category: z.string().min(1),
  questionVariants: z.array(z.string().min(1)).min(1),
  answer: z.string().min(1),
  sku: z.string().optional(),
  sensitivity: sensitivity.default('normal'),
});
const updateBody = createBody.partial().extend({
  status: z.enum(['active', 'pending', 'archived']).optional(),
});

export async function kbRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const supervisorOnly = { preHandler: [requireRole('supervisor')] };

  // GET /api/kb — list (active first). Any authenticated agent.
  app.get('/api/kb', async (req) => {
    const includeArchived = (req.query as { all?: string })?.all === '1';
    const kb = await prisma.kbEntry.findMany({
      where: includeArchived ? undefined : { status: { not: 'archived' } },
      orderBy: [{ status: 'asc' }, { category: 'asc' }],
    });
    return { kb };
  });

  // POST /api/kb — create (supervisor only)
  app.post('/api/kb', supervisorOnly, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const kb = await prisma.kbEntry.create({
      data: { ...parsed.data, source: 'manual', status: 'active', ownerAgentId: req.agent?.id },
    });
    return reply.code(201).send({ kb });
  });

  // PUT /api/kb/:id — update (supervisor only)
  app.put<{ Params: { id: string } }>('/api/kb/:id', supervisorOnly, async (req, reply) => {
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const existing = await prisma.kbEntry.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const kb = await prisma.kbEntry.update({ where: { id: req.params.id }, data: parsed.data });
    return { kb };
  });

  // DELETE /api/kb/:id — soft-delete by archiving (supervisor only)
  app.delete<{ Params: { id: string } }>('/api/kb/:id', supervisorOnly, async (req, reply) => {
    const existing = await prisma.kbEntry.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await prisma.kbEntry.update({ where: { id: req.params.id }, data: { status: 'archived' } });
    return { ok: true };
  });
}
