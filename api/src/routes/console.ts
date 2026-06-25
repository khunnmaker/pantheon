import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { endSession } from '../memory/summarize.js';
import { pushToConsole } from '../ws/io.js';

const RECENT_MESSAGES = 50;

export async function consoleRoutes(app: FastifyInstance) {
  // Everything here requires a logged-in agent.
  app.addHook('preHandler', requireAuth);

  // GET /api/queue — customers whose latest message is still awaiting a reply.
  // (Drafts attach here in M2; for now lastMessage carries the pending question.)
  app.get('/api/queue', async () => {
    const customers = await prisma.customer.findMany({
      where: { active: true },
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
          nickname: c.nickname,
          lastSeen: c.lastSeen,
        },
        lastMessage: c.messages[0],
      }));

    return { queue };
  });

  // GET /api/customers — lightweight list for the console selector.
  app.get('/api/customers', async () => {
    const customers = await prisma.customer.findMany({
      where: { active: true },
      orderBy: { lastSeen: 'desc' },
      select: { id: true, lineUserId: true, displayName: true, nickname: true, firstSeen: true, lastSeen: true },
    });
    return { customers };
  });

  // GET /api/customers/search?q= — find ANY customer (including ended chats) by
  // nickname / LINE display name / LINE id. Powers the queue search box. The
  // nickname is tied to the LINE id, so it persists across จบแชท.
  app.get('/api/customers/search', async (req) => {
    const q = ((req.query as { q?: string })?.q ?? '').trim();
    if (!q) return { customers: [] };
    const customers = await prisma.customer.findMany({
      where: {
        OR: [
          { nickname: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
          { lineUserId: { contains: q } },
        ],
      },
      orderBy: { lastSeen: 'desc' },
      take: 30,
      select: { id: true, lineUserId: true, displayName: true, nickname: true, firstSeen: true, lastSeen: true },
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

    const ordered = recent.reverse(); // oldest-first for display

    // Pending draft = the draft for the latest message IF that message is an
    // unanswered customer question (last in the conversation).
    const last = ordered[ordered.length - 1];
    const pendingDraft =
      last && last.role === 'customer'
        ? await prisma.draft.findUnique({ where: { messageId: last.id } })
        : null;

    const memory = await prisma.customerMemory.findUnique({ where: { customerId: id } });

    return {
      customer,
      messages: ordered,
      pendingDraft,
      pendingMessageId: last && last.role === 'customer' ? last.id : null,
      memory: memory ? { summary: memory.summary, updatedAt: memory.updatedAt } : null,
      stats: {
        questions: customerCount,
        replies: agentCount,
        lastSeen: customer.lastSeen,
      },
    };
  });

  // POST /api/customers/:id/end-session — end the chat and refresh long-term memory.
  app.post<{ Params: { id: string } }>('/api/customers/:id/end-session', async (req, reply) => {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    const summary = await endSession(req.params.id);
    // Hide the ended chat from every console's queue (a new message reactivates it).
    await prisma.customer.update({ where: { id: req.params.id }, data: { active: false } });
    pushToConsole('conversation:update', { customerId: req.params.id, ended: true });
    return { ok: true, summary };
  });

  // POST /api/customers/:id/nickname — set (or clear) the staff-assigned nickname.
  app.post<{ Params: { id: string } }>('/api/customers/:id/nickname', async (req, reply) => {
    const parsed = z.object({ nickname: z.string().max(80) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const nickname = parsed.data.nickname.trim() || null;
    const customer = await prisma.customer
      .update({ where: { id: req.params.id }, data: { nickname } })
      .catch(() => null);
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    pushToConsole('conversation:update', { customerId: req.params.id });
    return { ok: true, nickname };
  });
}
