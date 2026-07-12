import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { signToken, APP_NAMES, type Role, type AppName } from '../auth/jwt.js';
import { authedAgentFromToken } from '../auth/middleware.js';
import { buildLoginCards } from '../auth/loginCards.js';
import { sessionSetCookie, sessionClearCookie, readSessionToken } from '../auth/cookies.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// APP_NAMES is imported from auth/jwt.ts — the single source of truth for both the type and
// this runtime membership check, so a new god is added in exactly one place.

// Per-ACCOUNT login lockout (on top of the per-IP rate limit). The per-IP limit doesn't stop a
// distributed / IP-rotating guesser grinding ONE known staff email, so after MAX_FAILS failures
// for an email we lock THAT account for LOCK_MS. In-memory (the api runs a single instance) and
// best-effort — a restart clears it, an acceptable weakening for a ~15-person internal team. A
// locked account returns a generic 429 that never reveals whether the email exists.
const LOGIN_FAILS = new Map<string, { fails: number; lockedUntil: number }>();
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;
function loginLocked(email: string): boolean {
  const e = LOGIN_FAILS.get(email);
  return !!e && e.lockedUntil > Date.now();
}
function noteLoginFail(email: string): void {
  const e = LOGIN_FAILS.get(email) ?? { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= MAX_FAILS) {
    e.lockedUntil = Date.now() + LOCK_MS;
    e.fails = 0;
  }
  LOGIN_FAILS.set(email, e);
}

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

      // Per-account lockout — a targeted email that has failed too many times is frozen briefly,
      // regardless of source IP. Generic 429 (does not confirm the email exists).
      if (loginLocked(email)) return reply.code(429).send({ error: 'too_many_attempts' });

      const agent = await prisma.agent.findUnique({ where: { email } });
      // Always run a bcrypt compare — against the real hash, or a dummy hash when
      // the email is unknown — so timing is uniform and emails can't be enumerated.
      const ok = await verifyPassword(password, agent?.passwordHash ?? DUMMY_HASH);
      if (!agent || !ok) {
        noteLoginFail(email);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      LOGIN_FAILS.delete(email); // successful login clears the counter

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

  // PUBLIC GET /api/auth/logins?app=minerva|vesta|juno|ceres — the name-card list for that
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
