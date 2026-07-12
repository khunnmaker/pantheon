import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp } from '../auth/middleware.js';
import { endSession } from '../memory/summarize.js';
import { sendLineText, sendLineImages, sendLineReply } from '../line/send.js';
import { readStaffUploadMeta, UPLOAD_ID_RE } from '../line/staffUploads.js';
import { maybeRefreshCustomerPicture } from '../line/picture.js';
import { PRODUCT_PHOTO_DIR } from './content.js';
import { isStage } from '../stages.js';
import { pushToConsole } from '../ws/io.js';
import { isLow } from '../stock/helpers.js';
import { hasPrice } from '../llm/guardrails.js';

const RECENT_MESSAGES = 50;

type ProductCard = {
  sku: string; nameEn: string; nameTh: string; price: number; photoSku: string | null;
  stock: number | null; stockAt: Date | null;
  // Vesta low-stock surfacing for staff (NOT shown to customers): the threshold and a
  // computed flag so the console can style a near-empty SKU.
  reorderPoint: number | null; low: boolean;
};

function toProductCard(p: {
  sku: string; nameEn: string; nameTh: string; price: number; photoSku: string | null;
  stock: number | null; stockAt: Date | null; reorderPoint: number | null;
}): ProductCard {
  return {
    sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, price: p.price, photoSku: p.photoSku,
    stock: p.stock, stockAt: p.stockAt, reorderPoint: p.reorderPoint,
    low: isLow(p.stock, p.reorderPoint),
  };
}

export async function consoleRoutes(app: FastifyInstance) {
  // Everything here requires a logged-in agent with Minerva (sales console) access.
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('minerva'));

  // GET /api/queue — customers whose latest message is still awaiting a reply.
  // (Drafts attach here in M2; for now lastMessage carries the pending question.)
  app.get('/api/queue', async () => {
    const customers = await prisma.customer.findMany({
      where: { active: true },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { lastSeen: 'desc' },
    });

    const queue = customers
      // Waiting = latest message is the customer's AND it's after any "ตอบแล้ว" cutoff
      // (so a chat marked answered leaves the queue but still shows in the customer list).
      .filter(
        (c) =>
          c.messages[0]?.role === 'customer' &&
          (!c.answeredThroughAt || c.messages[0].createdAt > c.answeredThroughAt),
      )
      .map((c) => ({
        customer: {
          id: c.id,
          lineUserId: c.lineUserId,
          displayName: c.displayName,
          nickname: c.nickname,
          code: c.code,
          category: c.category,
          stage: c.stage,
          suggestedStage: c.suggestedStage,
          pictureUrl: c.pictureUrl,
          lastSeen: c.lastSeen,
        },
        lastMessage: c.messages[0],
      }));

    return { queue };
  });

  // GET /api/customers — lightweight list for the console selector. Also returns the
  // current agent's pinned customer ids (private per-agent — never trust a client agentId)
  // so the console can render the "ปักหมุด" section; the `customers` shape is unchanged.
  app.get('/api/customers', async (req) => {
    const customers = await prisma.customer.findMany({
      where: { active: true },
      orderBy: { lastSeen: 'desc' },
      select: { id: true, lineUserId: true, displayName: true, nickname: true, code: true, category: true, stage: true, suggestedStage: true, pictureUrl: true, firstSeen: true, lastSeen: true },
    });
    const pinnedIds = (
      await prisma.pin.findMany({ where: { agentId: req.agent!.id }, select: { customerId: true } })
    ).map((p) => p.customerId);
    return { customers, pinnedIds };
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
          { code: { contains: q, mode: 'insensitive' } },
          { nickname: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
          { lineUserId: { contains: q } },
        ],
      },
      orderBy: { lastSeen: 'desc' },
      take: 30,
      select: { id: true, lineUserId: true, displayName: true, nickname: true, code: true, category: true, stage: true, suggestedStage: true, pictureUrl: true, firstSeen: true, lastSeen: true },
    });
    return { customers };
  });

  // POST /api/customers/:id/pin — pin this customer chat for the current agent (private).
  // Idempotent: a duplicate (P2002 on the agentId+customerId unique) is treated as success.
  app.post<{ Params: { id: string } }>('/api/customers/:id/pin', async (req) => {
    try {
      await prisma.pin.create({ data: { agentId: req.agent!.id, customerId: req.params.id } });
    } catch (err) {
      // Already pinned (unique constraint) → still ok; rethrow anything else.
      if (!(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002')) throw err;
    }
    return { ok: true, pinned: true };
  });

  // DELETE /api/customers/:id/pin — unpin (manual unpin only). deleteMany so a missing pin is a no-op.
  app.delete<{ Params: { id: string } }>('/api/customers/:id/pin', async (req) => {
    await prisma.pin.deleteMany({ where: { agentId: req.agent!.id, customerId: req.params.id } });
    return { ok: true, pinned: false };
  });

  // GET /api/customers/:id — profile + recent messages + simple stats.
  app.get<{ Params: { id: string } }>('/api/customers/:id', async (req, reply) => {
    const { id } = req.params;
    const found = await prisma.customer.findUnique({ where: { id } });
    if (!found) return reply.code(404).send({ error: 'not_found' });
    let customer = found;

    // Refresh the cached LINE picture on chat-open: fills it in the first time (backfill for
    // pre-existing customers) AND re-fetches a stale one so a customer who changed their photo is
    // picked up — throttled to once per PICTURE_REFRESH_DAYS. Best-effort; a LINE/DB error never
    // fails the request and never wipes a good cached url. Reflect the effective url in the reply.
    const refreshedPicture = await maybeRefreshCustomerPicture(customer).catch(() => customer.pictureUrl);
    if (refreshedPicture !== customer.pictureUrl) {
      customer = { ...customer, pictureUrl: refreshedPicture };
    }

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
    // A chat marked "ตอบแล้ว" has no pending question until the customer writes again
    // (a message created after the cutoff).
    const pastCutoff =
      !customer.answeredThroughAt || (!!latestCustomer && latestCustomer.createdAt > customer.answeredThroughAt);
    if (latestCustomer && pastCutoff) {
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

    // OA read-sync: the latest LINE OA Manager "Read"/"อ่านแล้ว" status the Chrome extension has
    // mapped to this customer (null when none synced/matched yet). See routes/oaSync.ts.
    const oaSync = await prisma.oaReadSync.findFirst({ where: { customerId: id } });
    const oaRead = oaSync
      ? { readLabel: oaSync.readLabel, readSeenAt: oaSync.readSeenAt, oaChatId: oaSync.oaChatId }
      : null;

    // Catalog product the AI confidently drafted about (auto-selected photo).
    let pendingProduct: ProductCard | null = null;
    if (pendingDraft?.productSku) {
      const p = await prisma.product.findUnique({ where: { sku: pendingDraft.productSku } });
      if (p) {
        pendingProduct = toProductCard(p);
      }
    }

    // Candidates for the team to choose from (match order preserved). Products WITHOUT a
    // photo are kept too (shown as a "ไม่มีรูป" tile) so they can still be selected for
    // ร่างใหม่ / cross-sell. Dedup by SKU — distinct SKUs are distinct products even when they
    // share one catalog photo (e.g. two needle sizes), so each gets its own selectable tile.
    // The send path already dedupes the delivered image by photoSku, so a shared photo is only
    // sent once even if two same-photo SKUs are picked together.
    let productCandidates: ProductCard[] = [];
    if (pendingDraft?.candidateSkus?.length) {
      const prods = await prisma.product.findMany({ where: { sku: { in: pendingDraft.candidateSkus } } });
      const bySku = new Map(prods.map((p) => [p.sku, p]));
      const seen = new Set<string>();
      productCandidates = pendingDraft.candidateSkus
        .map((sku) => bySku.get(sku))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .filter((p) => {
          if (seen.has(p.sku)) return false;
          seen.add(p.sku);
          return true;
        })
        .map(toProductCard);
    }

    // AI cross-sell candidates — complementary products; skip any SKU already shown as a direct
    // match so the two rows don't repeat the same product (no-photo products kept too).
    let crossSellCandidates: ProductCard[] = [];
    if (pendingDraft?.crossSellSkus?.length) {
      const prods = await prisma.product.findMany({ where: { sku: { in: pendingDraft.crossSellSkus } } });
      const bySku = new Map(prods.map((p) => [p.sku, p]));
      const seen = new Set<string>(productCandidates.map((c) => c.sku));
      crossSellCandidates = pendingDraft.crossSellSkus
        .map((sku) => bySku.get(sku))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .filter((p) => {
          if (seen.has(p.sku)) return false;
          seen.add(p.sku);
          return true;
        })
        .map(toProductCard);
    }

    // Resolve sender names for outgoing messages (who answered) — Message.agentId has no Prisma
    // relation, and old ids may reference pruned accounts, so look up what exists and leave the
    // rest null (the console simply shows no name for those).
    const agentIds = [...new Set(ordered.map((m) => m.agentId).filter((v): v is string => !!v))];
    const agents = agentIds.length
      ? await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
      : [];
    const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
    // Never expose the raw quoteToken to the client — surface only a `quotable` flag (a customer
    // text/sticker bubble the staff can tap to LINE-quote). quotedMessageId stays so the frontend
    // can render the quoted snippet by joining within the loaded messages.
    const messages = ordered.map(({ quoteToken, ...m }) => ({
      ...m,
      agentName: m.agentId ? (agentNameById.get(m.agentId) ?? null) : null,
      quotable: !!quoteToken, // customer inbound OR our own sent text/sticker (self-reply)
    }));

    return {
      customer,
      messages,
      pendingDraft,
      pendingProduct,
      productCandidates,
      crossSellCandidates,
      pendingMessageId,
      memory: memory ? { summary: memory.summary, updatedAt: memory.updatedAt } : null,
      oaRead,
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
    const stamp = new Date();
    // "ตอบแล้ว": stamp the cutoff so the AI drafts only from later messages. The chat STAYS
    // visible in the customer list — it just drops out of the "waiting" queue (no orange dot),
    // because /api/queue excludes customers whose latest message is before the cutoff.
    await prisma.customer.update({
      where: { id: req.params.id },
      data: { answeredThroughAt: stamp },
    });
    // Drop pending AI drafts for the handled (pre-cutoff) messages so no orphaned answer
    // can resurface — makes "the answer doesn't show here" structural, not gate-dependent.
    const handled = await prisma.message.findMany({
      where: { customerId: req.params.id, createdAt: { lte: stamp } },
      select: { id: true },
    });
    if (handled.length) {
      await prisma.draft.deleteMany({ where: { messageId: { in: handled.map((m) => m.id) } } });
    }
    pushToConsole('conversation:update', { customerId: req.params.id });
    return { ok: true, summary };
  });

  // POST /api/customers/:id/nickname — set (or clear) the staff-assigned name + Express code.
  app.post<{ Params: { id: string } }>('/api/customers/:id/nickname', async (req, reply) => {
    const parsed = z.object({ nickname: z.string().max(80), code: z.string().max(24).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const data: { nickname: string | null; code?: string | null } = { nickname: parsed.data.nickname.trim() || null };
    if (parsed.data.code !== undefined) data.code = parsed.data.code.trim() || null;
    const customer = await prisma.customer
      .update({ where: { id: req.params.id }, data })
      .catch(() => null);
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    pushToConsole('conversation:update', { customerId: req.params.id });
    return { ok: true, nickname: customer.nickname, code: customer.code };
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

  // POST /api/customers/:id/stage — set/clear the sales-pipeline stage. Accepting a value
  // also clears the AI's pending suggestion. Empty string clears the stage.
  app.post<{ Params: { id: string } }>('/api/customers/:id/stage', async (req, reply) => {
    const raw = (req.body as { stage?: unknown })?.stage;
    const stage = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (stage !== null && !isStage(stage)) return reply.code(400).send({ error: 'invalid_stage' });
    const customer = await prisma.customer
      .update({ where: { id: req.params.id }, data: { stage, suggestedStage: null } })
      .catch(() => null);
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    pushToConsole('conversation:update', { customerId: req.params.id });
    return { ok: true, stage };
  });

  // POST /api/customers/:id/quick-reply — send a saved quick-reply template to the
  // customer as a STANDALONE message (answersMessageId stays null, so it does NOT
  // consume the pending question — the team keeps composing their main reply).
  app.post<{ Params: { id: string } }>('/api/customers/:id/quick-reply', async (req, reply) => {
    const parsed = z.object({
      quickReplyId: z.string(),
      confirmNumbers: z.boolean().optional(),
      replyToMessageId: z.string().max(60).optional(), // our Message.id to LINE-quote
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    const qr = await prisma.quickReply.findUnique({ where: { id: parsed.data.quickReplyId } });
    if (!qr) return reply.code(404).send({ error: 'quick_reply_not_found' });

    // Optional LINE quote-reply (same rule as /message and /reply): honour only a same-customer
    // message carrying a quoteToken; else send the template normally.
    let quoteToken: string | undefined;
    let quotedMessageId: string | undefined;
    if (parsed.data.replyToMessageId) {
      const quoted = await prisma.message.findUnique({ where: { id: parsed.data.replyToMessageId } });
      if (quoted && quoted.customerId === customer.id && quoted.quoteToken) {
        quoteToken = quoted.quoteToken;
        quotedMessageId = quoted.id;
      }
    }

    // Same server-enforced price-confirm as /reply and /message: a priced template must be
    // explicitly confirmed (428) — a stale price in a template is one click from the customer.
    if (!parsed.data.confirmNumbers && hasPrice(qr.body)) {
      return reply.code(428).send({ error: 'needs_confirm' });
    }

    let sendResult;
    try {
      sendResult = await sendLineText(customer.lineUserId, qr.body, quoteToken);
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
        ...(quotedMessageId ? { quotedMessageId } : {}),
        ...(sendResult.channelMsgId ? { channelMsgId: sendResult.channelMsgId } : {}),
        ...(sendResult.quoteToken ? { quoteToken: sendResult.quoteToken } : {}),
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
    const parsed = z.object({
      text: z.string().max(4000).optional(),
      uploadId: z.string().max(80).optional(), // optional staff photo/file attachment
      attachProductSkus: z.array(z.string()).max(20).optional(), // catalog photos to attach (only when no upload)
      confirmNumbers: z.boolean().optional(),
      replyToMessageId: z.string().max(60).optional(), // our Message.id to LINE-quote in this message
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const text = (parsed.data.text ?? '').trim();
    const { uploadId } = parsed.data;
    if (!text && !uploadId && !parsed.data.attachProductSkus?.length) return reply.code(400).send({ error: 'empty' });
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });

    // Optional LINE quote-reply — only if replyToMessageId belongs to THIS customer and has a
    // quoteToken (inbound text/sticker). The quote rides the TEXT part, so a photo-only send can't
    // carry it; send normally (no error) when unmet. quotedMessageId records what we replied to.
    let quoteToken: string | undefined;
    let quotedMessageId: string | undefined;
    if (parsed.data.replyToMessageId) {
      const quoted = await prisma.message.findUnique({ where: { id: parsed.data.replyToMessageId } });
      if (quoted && quoted.customerId === customer.id && quoted.quoteToken) {
        quoteToken = quoted.quoteToken;
        quotedMessageId = quoted.id;
      }
    }

    // Resolve an optional attachment: a staff upload (image → LINE image, file → download
    // link) wins; when no upload resolved, fall back to catalog product photos — same
    // precedence and resolution as POST /api/messages/:id/reply.
    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    let attach: { attachmentType: string; attachmentRef: string; attachmentName?: string } | undefined;
    let imageUrls: string[] = [];
    let sendText = text;
    if (uploadId && UPLOAD_ID_RE.test(uploadId)) {
      const meta = await readStaffUploadMeta(uploadId);
      if (meta) {
        const url = `${base}/content/upload/${uploadId}`;
        if (meta.kind === 'image') {
          imageUrls = [url];
          attach = { attachmentType: 'image', attachmentRef: uploadId };
        } else {
          sendText = text ? `${text}\n\n📎 ${meta.fileName}: ${url}` : `📎 ${meta.fileName}: ${url}`;
          attach = { attachmentType: 'file', attachmentRef: uploadId, attachmentName: meta.fileName };
        }
      }
    } else if (parsed.data.attachProductSkus?.length) {
      const prods = await prisma.product.findMany({ where: { sku: { in: parsed.data.attachProductSkus } } });
      const bySku = new Map(prods.map((p) => [p.sku, p]));
      const photoSkus: string[] = [];
      for (const sku of parsed.data.attachProductSkus) {
        const photoSku = bySku.get(sku)?.photoSku;
        if (photoSku && !photoSkus.includes(photoSku)) {
          const file = path.join(PRODUCT_PHOTO_DIR, `${photoSku}.png`);
          if (await fs.access(file).then(() => true).catch(() => false)) photoSkus.push(photoSku);
        }
      }
      if (photoSkus.length) {
        imageUrls = photoSkus.map((ps) => `${base}/content/product/${ps}`);
        attach = { attachmentType: 'product', attachmentRef: photoSkus.join(',') };
      }
    }

    // Nothing resolved to send (e.g. an unresolvable uploadId with no text) — don't push an empty bubble.
    if (!imageUrls.length && !sendText) return reply.code(400).send({ error: 'empty' });

    // Same server-enforced price-confirm as /reply: a free-form message that quotes a price must
    // be confirmed (428) before it sends, so a typed price can't reach a customer unchecked — gated
    // on the FINAL composed sendText (including an appended attachment filename) so a price hiding
    // in the filename isn't missed. Everything above this point is read-only, no side effects yet.
    if (!parsed.data.confirmNumbers && hasPrice(sendText)) {
      return reply.code(428).send({ error: 'needs_confirm' });
    }

    let sendResult;
    try {
      if (imageUrls.length && !sendText) sendResult = await sendLineImages(customer.lineUserId, imageUrls);
      else if (imageUrls.length) sendResult = await sendLineReply(customer.lineUserId, sendText, imageUrls, quoteToken);
      else sendResult = await sendLineText(customer.lineUserId, sendText, quoteToken);
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
        // Only record the quote when a TEXT bubble actually carried it (a photo-only send can't).
        ...(quotedMessageId && sendText ? { quotedMessageId } : {}),
        ...(attach ?? {}),
        ...(sendResult.channelMsgId ? { channelMsgId: sendResult.channelMsgId } : {}),
        ...(sendResult.quoteToken ? { quoteToken: sendResult.quoteToken } : {}),
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
