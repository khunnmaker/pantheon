import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { prisma } from './db/prisma.js';
import { healthRoutes } from './routes/health.js';

async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    },
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN === '*' ? true : env.WEB_ORIGIN.split(','),
    credentials: true,
  });

  await app.register(healthRoutes);

  // M1+ route groups (auth, queue, customers, kb, learned, metrics) register here.

  return app;
}

async function main() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`Minerva API listening on :${env.PORT} (${env.NODE_ENV})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
