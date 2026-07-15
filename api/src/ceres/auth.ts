import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { hasAppAccess, type AuthedAgent } from '../auth/jwt.js';
import { authedAgentFromToken } from '../auth/middleware.js';

// Ceres has its own persona vocabulary layered on top of the unified tiers
// (see auth/jwt.ts Role): an AGM/EMPLOYEE with the 'ceres' app grant acts as
// "messenger" (the self-entry persona — couriers, sales, housekeeper alike);
// A gm tier is Ceres management; agm/employee accounts with a grant use the messenger persona;
// the CEO is the Dr. M supervisor account.
export type CeresRole = 'messenger' | 'gm' | 'ceo';

export function ceresRole(agent: AuthedAgent): CeresRole | null {
  if (agent.role === 'supervisor') return 'ceo';
  if (agent.role === 'gm') return 'gm';
  if ((agent.role === 'agm' || agent.role === 'employee') && hasAppAccess(agent, 'ceres')) return 'messenger';
  return null; // employee without the ceres grant — no Ceres access
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

// preHandler: require a valid account that resolves to a Ceres persona (an
// agm/employee need the 'ceres' grant; gm/supervisor are implicit).
export const requireCeresAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const agent = await authedAgentFromToken(bearer(req), ['supervisor', 'gm', 'agm', 'employee']);
  if (!agent || ceresRole(agent) === null) {
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
