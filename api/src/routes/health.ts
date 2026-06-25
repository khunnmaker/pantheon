import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../db/prisma.js';
import { UPLOAD_DIR } from '../line/contentStore.js';

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

  // Storage — is the image upload dir (persistent volume in prod) writable?
  app.get('/health/storage', async () => {
    let writable = false;
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      const probe = path.join(UPLOAD_DIR, '.healthcheck');
      await fs.writeFile(probe, 'ok');
      await fs.readFile(probe);
      await fs.unlink(probe).catch(() => undefined);
      writable = true;
    } catch (err) {
      app.log.error({ err }, 'storage health check failed');
    }
    return { status: writable ? 'ok' : 'error', uploadDir: UPLOAD_DIR, writable };
  });
}
