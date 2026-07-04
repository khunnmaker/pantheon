import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { verifyToken, ALL_ROLES, hasAppAccess, type AuthedAgent, type Role, type AppName } from './jwt.js';
import { prisma } from '../db/prisma.js';

// Make request.agent available everywhere, typed.
declare module 'fastify' {
  interface FastifyRequest {
    agent?: AuthedAgent;
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

// Live (unified-auth) roles a request is allowed to be resolved as — any account by default.
const LIVE_ROLES: readonly Role[] = ['supervisor', 'md', 'employee'];

// Resolve a bearer token to the LIVE agent record. The JWT is treated only as a
// signed claim of identity (its `sub`/id); role, apps, and existence are re-read from
// the DB on every request, so a demotion or an account removal takes effect
// immediately rather than lingering until the 12h token expires. Returns null if
// the token is invalid OR the account no longer exists. Shared by the REST
// preHandler and the Socket.IO handshake.
//
// `allowed` filters against the LIVE row's role (any live account by default) — the token
// may still carry a legacy 'agent'/'messenger' claim (see jwt.ts TOKEN_ROLES), but that can
// no longer occur on a live row once boot has healed the DB, so a live role outside `allowed`
// (or outside the three current roles, belt-and-braces) just resolves to null.
export async function authedAgentFromToken(
  token: string | null,
  allowed: readonly Role[] = LIVE_ROLES,
): Promise<AuthedAgent | null> {
  const claims = token ? verifyToken(token) : null;
  if (!claims) return null;
  const live = await prisma.agent.findUnique({
    where: { id: claims.id },
    select: { id: true, email: true, name: true, role: true, apps: true },
  });
  if (!live || !LIVE_ROLES.includes(live.role as Role) || !allowed.includes(live.role as Role)) return null;
  return { id: live.id, email: live.email, name: live.name, role: live.role as Role, apps: live.apps };
}

// preHandler: require a valid token backed by a live account (any of the three roles); attaches request.agent.
export const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const agent = await authedAgentFromToken(bearer(req));
  if (!agent) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  req.agent = agent;
};

// preHandler: like requireAuth but explicitly admits EVERY live authenticated role
// (supervisor, md, employee — see ALL_ROLES in auth/jwt.ts). Functionally the same as
// requireAuth today (whose default `allowed` is already all live roles), but named for
// intent: use for endpoints that are open to every account and then gate per-app INSIDE
// the handler with hasAppAccess (e.g. the Jupiter portal badges route). Deriving from
// ALL_ROLES avoids silently omitting a future role.
export const requireAnyAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const agent = await authedAgentFromToken(bearer(req), ALL_ROLES);
  if (!agent) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  req.agent = agent;
};

// preHandler factory: require a specific role (implies requireAuth ran first).
export function requireRole(role: Role): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.agent) return reply.code(401).send({ error: 'unauthorized' });
    if (req.agent.role !== role) {
      return reply.code(403).send({ error: 'forbidden', need: role });
    }
  };
}

// preHandler factory: require access to a specific app (implies requireAuth ran first).
// supervisor always passes; md passes only for 'ceres'; employee passes per their Agent.apps.
export function requireApp(app: AppName): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.agent) return reply.code(401).send({ error: 'unauthorized' });
    if (!hasAppAccess(req.agent, app)) {
      return reply.code(403).send({ error: 'forbidden', need: app });
    }
  };
}
