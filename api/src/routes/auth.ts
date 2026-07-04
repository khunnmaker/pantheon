import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { signToken, type Role, type AppName } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';
import { buildLoginCards } from '../auth/loginCards.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const APP_NAMES = ['minerva', 'vulcan', 'juno', 'ceres'] as const;

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/login — { email, password } -> { token, agent }. Any role may log in here;
  // per-app access is enforced later by requireApp/requireRole on each app's own routes.
  // Rate-limited (per IP) to blunt online password guessing / credential stuffing.
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const { email, password } = parsed.data;

      const agent = await prisma.agent.findUnique({ where: { email } });
      // Always run a bcrypt compare — against the real hash, or a dummy hash when
      // the email is unknown — so timing is uniform and emails can't be enumerated.
      const ok = await verifyPassword(password, agent?.passwordHash ?? DUMMY_HASH);
      if (!agent || !ok) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const identity = {
        id: agent.id,
        email: agent.email,
        name: agent.name,
        role: agent.role as Role,
        apps: agent.apps,
      };
      return { token: signToken(identity), agent: identity };
    },
  );

  // GET /api/auth/me — current identity from the JWT. requireAuth-only (any live account) —
  // Jupiter's bootstrap uses this regardless of which app it's fronting.
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    return { agent: req.agent };
  });

  // PUBLIC GET /api/auth/logins?app=minerva|vulcan|juno|ceres — the name-card list for that
  // app's login screen (supervisor, then md for ceres, then employees granted that app).
  // Names + emails only — no roles/ids beyond `kind`.
  app.get('/api/auth/logins', async (req, reply) => {
    const app_ = (req.query as { app?: string })?.app;
    if (!app_ || !(APP_NAMES as readonly string[]).includes(app_)) {
      return reply.code(400).send({ error: 'invalid_app' });
    }
    const logins = await buildLoginCards(app_ as AppName);
    return logins;
  });
}
