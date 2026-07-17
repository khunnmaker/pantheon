import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import {
  signToken,
  signSessionToken,
  verifyToken,
  sessionTierForRole,
  SESSION_MAX_AGE_SECONDS,
  SESSION_SCOPE,
  APP_NAMES,
  type Role,
  type AppName,
  type SessionTier,
} from '../auth/jwt.js';
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
        authVersion: agent.authVersion,
      };
      const token = signToken(identity);
      // Also drop the suite SSO cookie (parent-domain, httpOnly) so opening any OTHER
      // *.prominentdental.com app recognises this login without re-entering credentials. The
      // cookie only ever authenticates GET /api/auth/me (below) — never a state change — and
      // carries a role-tiered session-SCOPED token ("remember this computer"), not the 12h bearer.
      const sessionTier = sessionTierForRole(identity.role);
      reply.header(
        'set-cookie',
        sessionSetCookie(signSessionToken(identity, sessionTier), SESSION_MAX_AGE_SECONDS[sessionTier]),
      );
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
    const sessionToken = readSessionToken(req);
    const sessionClaims = sessionToken ? verifyToken(sessionToken, { scope: SESSION_SCOPE }) : null;
    // A bearer verifies as a normal (unscoped) token; the cookie path passes SESSION_SCOPE so
    // the device-session token verifies HERE and nowhere else. A pre-rollout cookie (which
    // carried an unscoped 12h bearer) still passes — unscoped tokens verify on any path — so
    // nobody is force-logged-out by this deploy; those cookies simply age out within 12h.
    const agent = bearer
      ? await authedAgentFromToken(bearer)
      : await authedAgentFromToken(sessionToken, undefined, { scope: SESSION_SCOPE });
    if (!agent) return reply.code(401).send({ error: 'unauthorized' });
    // Rolling renewal: every successful bootstrap re-issues the device-session cookie, so a
    // computer in active use stays remembered indefinitely; the original 7d/30d idle tier
    // determines when it lapses.
    // Pre-tier cookies were all 30d, so a missing claim preserves that legacy lifetime. New
    // cookies always carry the tier and therefore never upgrade an employee during renewal.
    const sessionTier: SessionTier = sessionClaims?.id === agent.id
      ? sessionClaims.sessionTier ?? 'manager'
      : sessionTierForRole(agent.role);
    reply.header(
      'set-cookie',
      sessionSetCookie(signSessionToken(agent, sessionTier), SESSION_MAX_AGE_SECONDS[sessionTier]),
    );
    return { agent, token: signToken(agent) };
  });

  // POST /api/auth/logout — identify the Agent from bearer OR cookie, revoke all of that
  // Agent's suite tokens, and clear the shared SSO cookie. With neither credential it remains
  // an idempotent cookie clear. Apps also clear their own local token client-side.
  app.post('/api/auth/logout', async (req, reply) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const agent = (bearer ? await authedAgentFromToken(bearer) : null)
      ?? await authedAgentFromToken(readSessionToken(req), undefined, { scope: SESSION_SCOPE });
    if (agent) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { authVersion: { increment: 1 } },
      });
    }
    reply.header('set-cookie', sessionClearCookie());
    return { ok: true };
  });

  // PUBLIC GET /api/auth/logins?app=minerva|vesta|juno|ceres — the name-card list for that
  // app's login screen (supervisor, then GM, AGM, then other employees granted that app).
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
