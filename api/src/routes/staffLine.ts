import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { createStaffLineBindCode, staffLineBindStatus } from '../line/staffBind.js';

export async function staffLineRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth);

  app.get('/api/staff/line-bind', async (req) => staffLineBindStatus(req.agent!.id));
  app.post('/api/staff/line-bind', async (req) => createStaffLineBindCode(req.agent!.id));
}
