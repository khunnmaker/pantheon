import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';

// Health check (spec M0 acceptance). Reports api liveness and db connectivity.
export async function healthRoutes(app: FastifyInstance) {
  // Liveness — process is up.
  app.get('/health', async () => ({
    status: 'ok',
    service: 'minerva-api',
    time: new Date().toISOString(),
  }));

  // Readiness — can we reach the database?
  app.get('/health/db', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'db health check failed');
      return reply.code(503).send({ status: 'error', db: 'down' });
    }
  });
}
