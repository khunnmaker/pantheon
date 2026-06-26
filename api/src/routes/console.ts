import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { endSession } from '../memory/summarize.js';
import { sendLineText, sendLineImages } from '../line/send.js';
import { readStaffUploadMeta, UPLOAD_ID_RE } from '../line/staffUploads.js';
import { pushToConsole } from '../ws/io.js';

const RECENT_MESSAGES = 50;

type ProductCard = { sku: string; nameEn: string; nameTh: string; price: number; photoSku: string | null; stock: number | null; stockAt: Date | null };

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
          category: c.category,
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
      select: { id: true, lineUserId: true, displayName: true, nickname: true, category: true, firstSeen: true, lastSeen: true },
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
      select: { id: true, lineUserId: true, displayName: true, nickname: true, category: true, firstSeen: true, lastSeen: true },
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

    // Pending = the most recent CUSTOMER message not yet answered by a reply (a
    // standalone quick-reply does NOT answer it) — so the composer stays open even
    // after the team sends one or more quick-replies.
    const latestCustomer = [...ordered].reverse().find((m) => m.role === 'customer');
    let pendingMessageId: string | null = null;
    let pendingDraft = null;
    if (latestCustomer) {
      const answered = await prisma.message.findFirst({
        where: { answersMessageId: latestCustomer.id },
        select: { id: true },
      });
      if (!answered) {
        pendingMessageId = latestCustomer.id;
        pendingDraft = await prisma.draft.findUnique({ where: { messageId: latestCustomer.id } });
      }
    }

    const memory = await prisma.customerMemory.findUnique({ where: { customerId: id } });

    // Catalog product the AI confidently drafted about (auto-selected photo).
    let pendingProduct: ProductCard | null = null;
    if (pendingDraft?.productSku) {
      const p = await prisma.product.findUnique({ where: { sku: pendingDraft.productSku } });
      if (p) {
        pendingProduct = { sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, price: p.price, photoSku: p.photoSku, stock: p.stock, stockAt: p.stockAt };
      }
    }

    // Candidate product photos for the team to choose from (match order preserved).
    let productCandidates: ProductCard[] = [];
    if (pendingDraft?.candidateSkus?.length) {
      const prods = await prisma.product.findMany({ where: { sku: { in: pendingDraft.candidateSkus } } });
      const bySku = new Map(prods.map((p) => [p.sku, p]));
      const seenPhoto = new Set<string>();
      productCandidates = pendingDraft.candidateSkus
        .map((sku) => bySku.get(sku))
        .filter((p): p is NonNullable<typeof p> => !!p && !!p.photoSku)
        // variants share a photo — show each distinct image once.
        .filter((p) => {
          if (seenPhoto.has(p.photoSku as string)) return false;
          seenPhoto.add(p.photoSku as string);
          return true;
        })
        .map((p) => ({ sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, price: p.price, photoSku: p.photoSku, stock: p.stock, stockAt: p.stockAt }));
    }

    // AI cross-sell candidates — complementary products; skip any photo already
    // shown as a direct match so the two rows don't repeat.
    let crossSellCandidates: ProductCard[] = [];
    if (pendingDraft?.crossSellSkus?.length) {
      const prods = await prisma.product.findMany({ where: { sku: { in: pendingDraft.crossSellSkus } } });
      const bySku = new Map(prods.map((p) => [p.sku, p]));
      const seenPhoto = new Set(productCandidates.map((c) => c.photoSku as string));
      crossSellCandidates = pendingDraft.crossSellSkus
        .map((sku) => bySku.get(sku))
        .filter((p): p is NonNullable<typeof p> => !!p && !!p.photoSku)
        .filter((p) => {
          if (seenPhoto.has(p.photoSku as string)) return false;
          seenPhoto.add(p.photoSku as string);
          return true;
        })
        .map((p) => ({ sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, price: p.price, photoSku: p.photoSku, stock: p.stock, stockAt: p.stockAt }));
    }

    return {
      customer,
      messages: ordered,
      pendingDraft,
      pendingProduct,
      productCandidates,
      crossSellCandidates,
      pendingMessageId,
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

  // POST /api/customers/:id/category — set (or clear) the staff-assigned area/type
  // category. Free string (≤20 chars) so the team can add zones without a deploy.
  app.post<{ Params: { id: string } }>('/api/customers/:id/category', async (req, reply) => {
    const parsed = z.object({ category: z.string().max(20) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const category = parsed.data.category.trim() || null;
    const customer = await prisma.customer
      .update({ where: { id: req.params.id }, data: { category } })
      .catch(() => null);
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    pushToConsole('conversation:update', { customerId: req.params.id });
    return { ok: true, category };
  });

  // POST /api/customers/:id/quick-reply — send a saved quick-reply template to the
  // customer as a STANDALONE message (answersMessageId stays null, so it does NOT
  // consume the pending question — the team keeps composing their main reply).
  app.post<{ Params: { id: string } }>('/api/customers/:id/quick-reply', async (req, reply) => {
    const parsed = z.object({ quickReplyId: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    const qr = await prisma.quickReply.findUnique({ where: { id: parsed.data.quickReplyId } });
    if (!qr) return reply.code(404).send({ error: 'quick_reply_not_found' });

    let sendResult;
    try {
      sendResult = await sendLineText(customer.lineUserId, qr.body);
    } catch (err) {
      req.log.error({ err }, 'quick-reply send failed');
      return reply.code(502).send({ error: 'line_send_failed' });
    }
    const message = await prisma.message.create({
      data: {
        customerId: customer.id,
        role: 'agent',
        text: qr.body,
        agentId: req.agent!.id,
        kbIds: [],
        ...(sendResult.channelMsgId ? { channelMsgId: sendResult.channelMsgId } : {}),
      },
    });
    await prisma.customer.update({ where: { id: customer.id }, data: { lastSeen: new Date() } });
    pushToConsole('conversation:update', { customerId: customer.id, message });
    return { ok: true, message, dryRun: sendResult.dryRun };
  });

  // POST /api/customers/:id/message — send a free-form message to the customer
  // (e.g. a correction/addition after the question was already answered). Standalone
  // (answersMessageId null); same price-confirm as a normal reply.
  app.post<{ Params: { id: string } }>('/api/customers/:id/message', async (req, reply) => {
    const parsed = z.object({ text: z.string().min(1).max(4000), confirmNumbers: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { text } = parsed.data;
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    let sendResult;
    try {
      sendResult = await sendLineText(customer.lineUserId, text);
    } catch (err) {
      req.log.error({ err }, 'free message send failed');
      return reply.code(502).send({ error: 'line_send_failed' });
    }
    const message = await prisma.message.create({
      data: {
        customerId: customer.id,
        role: 'agent',
        text,
        agentId: req.agent!.id,
        kbIds: [],
        ...(sendResult.channelMsgId ? { channelMsgId: sendResult.channelMsgId } : {}),
      },
    });
    await prisma.customer.update({ where: { id: customer.id }, data: { lastSeen: new Date() } });
    pushToConsole('conversation:update', { customerId: customer.id, message });
    return { ok: true, message, dryRun: sendResult.dryRun };
  });

  // POST /api/customers/:id/photo — send a staff photo to the customer IMMEDIATELY
  // (camera capture). Standalone image message — no text bubble, answersMessageId null.
  app.post<{ Params: { id: string } }>('/api/customers/:id/photo', async (req, reply) => {
    const uploadId = (req.body as { uploadId?: unknown })?.uploadId;
    if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) {
      return reply.code(400).send({ error: 'invalid_upload' });
    }
    const meta = await readStaffUploadMeta(uploadId);
    if (!meta || meta.kind !== 'image') return reply.code(400).send({ error: 'not_an_image' });
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    const url = `${base}/content/upload/${uploadId}`;
    let sendResult;
    try {
      sendResult = await sendLineImages(customer.lineUserId, [url]);
    } catch (err) {
      req.log.error({ err }, 'photo send failed');
      return reply.code(502).send({ error: 'line_send_failed' });
    }
    const message = await prisma.message.create({
      data: {
        customerId: customer.id,
        role: 'agent',
        text: '',
        agentId: req.agent!.id,
        kbIds: [],
        attachmentType: 'image',
        attachmentRef: uploadId,
        ...(sendResult.channelMsgId ? { channelMsgId: sendResult.channelMsgId } : {}),
      },
    });
    await prisma.customer.update({ where: { id: customer.id }, data: { lastSeen: new Date() } });
    pushToConsole('conversation:update', { customerId: customer.id, message });
    return { ok: true, message, dryRun: sendResult.dryRun };
  });
}
