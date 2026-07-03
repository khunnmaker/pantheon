import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { verifyToken, type AuthedAgent, type Role } from './jwt.js';
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

// Resolve a bearer token to the LIVE agent record. The JWT is treated only as a
// signed claim of identity (its `sub`/id); role and existence are re-read from
// the DB on every request, so a demotion or an account removal takes effect
// immediately rather than lingering until the 12h token expires. Returns null if
// the token is invalid OR the account no longer exists. Shared by the REST
// preHandler and the Socket.IO handshake.
export async function authedAgentFromToken(
  token: string | null,
  allowed: readonly Role[] = ['agent', 'supervisor'],
): Promise<AuthedAgent | null> {
  const claims = token ? verifyToken(token) : null;
  if (!claims) return null;
  const live = await prisma.agent.findUnique({
    where: { id: claims.id },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!live || !allowed.includes(live.role as Role)) return null;
  return { id: live.id, email: live.email, name: live.name, role: live.role as Role };
}

// preHandler: require a valid token backed by a live account; attaches request.agent.
export const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const agent = await authedAgentFromToken(bearer(req));
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
