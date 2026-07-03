import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AuthedAgent } from '../auth/jwt.js';
import { authedAgentFromToken } from '../auth/middleware.js';

// Ceres has its own role vocabulary layered on top of the shared Agent table
// (see auth/jwt.ts Role): messenger and md are Ceres-only Agent roles; the CEO
// logs in with the existing Dr. M supervisor account (reused, not duplicated).
export type CeresRole = 'messenger' | 'md' | 'ceo';

export function ceresRole(agent: AuthedAgent): CeresRole | null {
  if (agent.role === 'messenger') return 'messenger';
  if (agent.role === 'md') return 'md';
  if (agent.role === 'supervisor') return 'ceo';
  return null; // 'agent' — no Ceres access
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

// preHandler: require a valid token for one of the Ceres-facing Agent roles.
export const requireCeresAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const agent = await authedAgentFromToken(bearer(req), ['messenger', 'md', 'supervisor']);
  if (!agent) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  req.agent = agent;
};

// preHandler factory: require the resolved Ceres role to be one of `roles`
// (implies requireCeresAuth ran first).
export function requireCeresRole(...roles: CeresRole[]): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.agent) return reply.code(401).send({ error: 'unauthorized' });
    const role = ceresRole(req.agent);
    if (!role || !roles.includes(role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
