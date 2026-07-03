import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { signToken, type Role } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/login — { email, password } -> { token, agent }
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
      };
      return { token: signToken(identity), agent: identity };
    },
  );

  // GET /api/auth/me — current identity from the JWT
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    return { agent: req.agent };
  });
}
