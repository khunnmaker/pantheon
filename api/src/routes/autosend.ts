import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireApp, requireAuth, requireRole } from '../auth/middleware.js';
import { getAutosendConfig, setAutosendConfig } from '../autosend/config.js';
import {
  cancelAllAutosends,
  cancelAutosendForDraft,
  cancelAutosendForCustomer,
} from '../autosend/scheduler.js';

const configBody = z.object({ enabled: z.boolean(), delaySeconds: z.number().finite() });

export async function autosendRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('minerva'));

  app.get('/api/autosend/config', { preHandler: requireRole('supervisor') }, async () => getAutosendConfig());

  app.post('/api/autosend/config', { preHandler: requireRole('supervisor') }, async (req, reply) => {
    const parsed = configBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const config = await setAutosendConfig(parsed.data);
    if (!config.enabled) await cancelAllAutosends('config_disabled');
    return config;
  });

  app.post<{ Params: { id: string } }>('/api/messages/:id/autosend-cancel', async (req, reply) => {
    const draft = await prisma.draft.findFirst({
      where: { OR: [{ id: req.params.id }, { messageId: req.params.id }] },
      select: { id: true, messageId: true },
    });
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    const message = await prisma.message.findUnique({ where: { id: draft.messageId }, select: { customerId: true } });
    const canceled = await cancelAutosendForDraft(draft.id, 'staff_canceled');
    if (!canceled && message) await cancelAutosendForCustomer(message.customerId, 'staff_canceled');
    return { canceled };
  });
}
