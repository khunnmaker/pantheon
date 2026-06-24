import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';

const RECENT_MESSAGES = 50;

export async function consoleRoutes(app: FastifyInstance) {
  // Everything here requires a logged-in agent.
  app.addHook('preHandler', requireAuth);

  // GET /api/queue — customers whose latest message is still awaiting a reply.
  // (Drafts attach here in M2; for now lastMessage carries the pending question.)
  app.get('/api/queue', async () => {
    const customers = await prisma.customer.findMany({
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { lastSeen: 'desc' },
    });

    const queue = customers
      .filter((c) => c.messages[0]?.role === 'customer')
      .map((c) => ({
        customer: {
          id: c.id,
          lineUserId: c.lineUserId,
          displayName: c.displayName,
          lastSeen: c.lastSeen,
        },
        lastMessage: c.messages[0],
      }));

    return { queue };
  });

  // GET /api/customers — lightweight list for the console selector.
  app.get('/api/customers', async () => {
    const customers = await prisma.customer.findMany({
      orderBy: { lastSeen: 'desc' },
      select: { id: true, lineUserId: true, displayName: true, firstSeen: true, lastSeen: true },
    });
    return { customers };
  });

  // GET /api/customers/:id — profile + recent messages + simple stats.
  app.get<{ Params: { id: string } }>('/api/customers/:id', async (req, reply) => {
    const { id } = req.params;
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });

    const [recent, customerCount, agentCount] = await Promise.all([
      prisma.message.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: RECENT_MESSAGES,
      }),
      prisma.message.count({ where: { customerId: id, role: 'customer' } }),
      prisma.message.count({ where: { customerId: id, role: 'agent' } }),
    ]);

    return {
      customer,
      messages: recent.reverse(), // oldest-first for display
      stats: {
        questions: customerCount,
        replies: agentCount,
        lastSeen: customer.lastSeen,
      },
    };
  });
}
