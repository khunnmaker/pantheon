import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { verifyToken, type AuthedAgent, type Role } from './jwt.js';

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

// preHandler: require a valid JWT; attaches request.agent.
export const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const token = bearer(req);
  const agent = token ? verifyToken(token) : null;
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
