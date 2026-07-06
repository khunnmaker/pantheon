import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { signToken, type Role, type AppName } from '../auth/jwt.js';
import { authedAgentFromToken } from '../auth/middleware.js';
import { buildLoginCards } from '../auth/loginCards.js';
import { sessionSetCookie, sessionClearCookie, readSessionToken } from '../auth/cookies.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const APP_NAMES = ['minerva', 'vulcan', 'juno', 'ceres', 'mercury'] as const;

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
      const token = signToken(identity);
      // Also drop the suite SSO cookie (parent-domain, httpOnly) so opening any OTHER
      // *.prominentdental.com app recognises this login without re-entering credentials. The
      // cookie only ever authenticates GET /api/auth/me (below) — never a state change.
      reply.header('set-cookie', sessionSetCookie(token));
      return { token, agent: identity };
    },
  );

  // GET /api/auth/me — "who am I?" bootstrap. Accepts the bearer token (Authorization header)
  // OR the shared SSO cookie, and returns the identity PLUS a fresh bearer token. This is the
  // whole SSO mechanism: an app opened with no local token calls /me, the browser attaches the
  // parent-domain cookie, and the app gets a token to use (via the header) from then on. It is
  // the ONLY endpoint that reads the cookie, and it is a GET whose body is CORS-protected — so
  // the cookie can never drive a state change and there is no CSRF surface to defend.
  app.get('/api/auth/me', async (req, reply) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const agent = await authedAgentFromToken(bearer || readSessionToken(req));
    if (!agent) return reply.code(401).send({ error: 'unauthorized' });
    return { agent, token: signToken(agent) };
  });

  // POST /api/auth/logout — clear the shared SSO cookie (idempotent; needs no token, since
  // clearing your own session is not a CSRF concern). Apps also clear their own local token
  // client-side; this call makes SSO logout propagate to every *.prominentdental.com app.
  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', sessionClearCookie());
    return { ok: true };
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
