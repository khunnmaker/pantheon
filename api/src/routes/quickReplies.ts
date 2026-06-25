import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';

const createSchema = z.object({
  label: z.string().min(1).max(40),
  body: z.string().min(1).max(2000),
  sortOrder: z.number().int().optional(),
});

// Staff quick-reply templates: list + add/edit/delete. Any authenticated staff can
// manage them (an internal tool, not customer-facing).
export async function quickReplyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/quick-replies', async () => {
    const items = await prisma.quickReply.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items };
  });

  app.post('/api/quick-replies', async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    const item = await prisma.quickReply.create({
      data: { label: p.data.label.trim(), body: p.data.body, sortOrder: p.data.sortOrder ?? 999 },
    });
    return { item };
  });

  app.put<{ Params: { id: string } }>('/api/quick-replies/:id', async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    const item = await prisma.quickReply
      .update({ where: { id: req.params.id }, data: p.data })
      .catch(() => null);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/quick-replies/:id', async (req) => {
    await prisma.quickReply.delete({ where: { id: req.params.id } }).catch(() => undefined);
    return { ok: true };
  });
}
