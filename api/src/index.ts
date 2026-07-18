import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sjson from 'secure-json-parse';
import { env } from './env.js';
import { prisma } from './db/prisma.js';
import { healthRoutes } from './routes/health.js';
import { contentRoutes } from './routes/content.js';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhook.js';
import { consoleRoutes } from './routes/console.js';
import { kbRoutes } from './routes/kb.js';
import { messageRoutes } from './routes/messages.js';
import { learningRoutes } from './routes/learning.js';
import { catalogRoutes } from './routes/catalog.js';
import { quickReplyRoutes } from './routes/quickReplies.js';
import { financeRoutes } from './routes/finance.js';
import { stockRoutes } from './routes/stock.js';
import { dianaRoutes } from './routes/diana.js';
import { junoRoutes } from './routes/juno.js';
import { pantheonRoutes } from './routes/pantheon.js';
import { jupiterAccountingRoutes } from './routes/jupiterAccounting.js';
import { tokenUsageRoutes } from './routes/tokenUsage.js';
import { venusRoutes } from './routes/venus.js';
import { initIo } from './ws/io.js';
import { sweepIdleSessions } from './memory/summarize.js';
import { ensureSeeded } from './db/ensureSeeded.js';
import { ensureCatalog } from './db/ensureCatalog.js';
import { ensureEnrichment } from './db/ensureEnrichment.js';
import { ensureStock } from './db/ensureStock.js';
import { ensureQuickReplies } from './db/ensureQuickReplies.js';
import { ensureCeres } from './db/ensureCeres.js';
import { ceresRoutes } from './routes/ceres/index.js';
import { startCeresDigestScheduler } from './ceres/nightlyDigest.js';
import { mercuryRoutes } from './routes/mercury/index.js';
import { oaSyncRoutes } from './routes/oaSync.js';
import { apolloRoutes } from './routes/apollo.js';
import { startApolloSchedulers } from './apollo/scheduler.js';
import { staffLineRoutes } from './routes/staffLine.js';
import { autosendRoutes } from './routes/autosend.js';

// Raw body is needed to verify the LINE webhook signature.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

async function buildServer() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'debug' : 'info' },
    // Railway terminates TLS at a proxy in front of us. Without this, req.ip is the
    // proxy's IP for every client, so the per-IP login rate limit would throttle
    // everyone collectively instead of one abuser (and req.protocol would read wrong).
    trustProxy: true,
  });

  // Capture the raw JSON body (for HMAC signature checks) while still parsing it.
  // Use secure-json-parse (Fastify's own default parser) so prototype-pollution
  // protection is preserved on every JSON route — bare JSON.parse would drop it.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: FastifyRequest, body: string | Buffer, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      req.rawBody = raw;
      try {
        const parsed = raw.length
          ? sjson.parse(raw, undefined, { protoAction: 'remove', constructorAction: 'remove' })
          : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Rate limiting: opt-in per route (login is the only limited route in M1).
  await app.register(rateLimit, { global: false });

  await app.register(cors, {
    origin: env.WEB_ORIGIN === '*' ? true : env.WEB_ORIGIN.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    credentials: true,
  });

  await app.register(healthRoutes);
  await app.register(contentRoutes);
  await app.register(authRoutes);
  await app.register(webhookRoutes);
  await app.register(consoleRoutes);
  await app.register(kbRoutes);
  await app.register(messageRoutes);
  await app.register(autosendRoutes);
  await app.register(learningRoutes);
  await app.register(catalogRoutes);
  await app.register(quickReplyRoutes);
  await app.register(financeRoutes);
  await app.register(stockRoutes);
  await app.register(dianaRoutes);
  await app.register(junoRoutes);
  await app.register(pantheonRoutes);
  await app.register(jupiterAccountingRoutes);
  await app.register(tokenUsageRoutes);
  await app.register(ceresRoutes);
  // Nightly CEO digest scheduler (fire-and-forget; self-rechaining + .unref()'d — see
  // ceres/nightlyDigest.ts). Started here, right alongside the rest of Ceres's wiring.
  startCeresDigestScheduler(app.log);
  await app.register(venusRoutes);
  await app.register(mercuryRoutes);
  await app.register(oaSyncRoutes);
  await app.register(staffLineRoutes);
  await app.register(apolloRoutes);
  startApolloSchedulers(app.log);

  return app;
}

async function main() {
  const app = await buildServer();

  // Populate an empty (fresh cloud) database with the KB + staff on boot.
  await ensureSeeded().catch((err) => app.log.error({ err }, 'ensureSeeded failed'));
  // Seed the product catalog (price/name) on first boot.
  await ensureCatalog().catch((err) => app.log.error({ err }, 'ensureCatalog failed'));
  // Derive Diana brand/category facets on first boot (once the catalog exists).
  await ensureEnrichment().catch((err) => app.log.error({ err }, 'ensureEnrichment failed'));
  // Apply the stock snapshot to the catalog (once per snapshot date).
  await ensureStock().catch((err) => app.log.error({ err }, 'ensureStock failed'));
  // Seed the starter quick-reply templates on first boot.
  await ensureQuickReplies().catch((err) => app.log.error({ err }, 'ensureQuickReplies failed'));
  // Seed Ceres's cash accounts / parties / categories on first boot.
  await ensureCeres().catch((err) => app.log.error({ err }, 'ensureCeres failed'));

  // Attach the Socket.IO server for live console push.
  initIo(app.server);

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

    // Periodically end + summarize idle sessions (long-term memory, M3 layer 1).
    const sweep = setInterval(() => {
      void sweepIdleSessions(env.SESSION_IDLE_MINUTES).catch((err) =>
        app.log.error({ err }, 'idle session sweep failed'),
      );
    }, 60_000);
    sweep.unref();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
