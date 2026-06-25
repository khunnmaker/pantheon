import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { sendLineReply } from '../line/send.js';
import { generateDraftForMessage } from '../llm/draft.js';
import { rewriteText } from '../llm/rewrite.js';
import { hasPrice } from '../llm/guardrails.js';
import { embedMessage } from '../memory/embeddings.js';
import { readImageContent } from '../line/contentStore.js';
import { PRODUCT_PHOTO_DIR } from './content.js';
import { saveStaffUpload, readStaffUploadMeta, UPLOAD_ID_RE } from '../line/staffUploads.js';
import { recordCrossSellOutcome } from '../catalog/crossSell.js';
import { pushToConsole } from '../ws/io.js';

const replyBody = z.object({
  finalText: z.string().min(1),
  confirmNumbers: z.boolean().optional(),
  attachProductSkus: z.array(z.string()).max(6).optional(), // catalog photos to attach
  uploadId: z.string().max(80).optional(), // attach a staff-uploaded photo/file
});

const uploadBody = z.object({
  dataB64: z.string().min(1),
  fileName: z.string().max(255).optional(),
  contentType: z.string().max(120).optional(),
});

const rewriteBody = z.object({ text: z.string().min(1).max(4000) });

export async function messageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /api/messages/:id/content — stream a stored attachment (image/video/audio/
  // file) for a message (auth required). Files download with their original name.
  app.get<{ Params: { id: string } }>('/api/messages/:id/content', async (req, reply) => {
    const message = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!message) return reply.code(404).send({ error: 'not_found' });
    const buf = await readImageContent(message.id);
    if (!buf) return reply.code(404).send({ error: 'content_unavailable' });
    reply.header('content-type', message.attachmentRef || 'application/octet-stream');
    if (message.attachmentType === 'file' && message.attachmentName) {
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(message.attachmentName)}`);
    }
    return reply.send(buf);
  });

  // POST /api/uploads — staff upload a photo/file to attach to a reply. Stored on
  // the volume + served publicly; returns an uploadId to pass to /reply.
  app.post('/api/uploads', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const parsed = uploadBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const out = await saveStaffUpload(
      parsed.data.dataB64,
      parsed.data.fileName ?? 'file',
      parsed.data.contentType ?? 'application/octet-stream',
    );
    if (!out) return reply.code(413).send({ error: 'too_large_or_empty' });
    return { uploadId: out.uploadId, kind: out.kind, fileName: parsed.data.fileName ?? 'file' };
  });

  // POST /api/messages/:id/draft — (re)generate the AI draft for a customer msg.
  app.post<{ Params: { id: string } }>('/api/messages/:id/draft', async (req, reply) => {
    try {
      const out = await generateDraftForMessage(req.params.id);
      pushToConsole('draft:new', {
        messageId: req.params.id,
        draft: out.draft,
        guardrailReason: out.guardrailReason,
      });
      return { draft: out.draft, guardrailReason: out.guardrailReason };
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // POST /api/messages/:id/reply — approve & send a reply to the customer.
  // Human-in-the-loop: this is the ONLY path that sends to LINE.
  app.post<{ Params: { id: string } }>('/api/messages/:id/reply', async (req, reply) => {
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { finalText, confirmNumbers } = parsed.data;
    const agent = req.agent!;

    const customerMsg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!customerMsg || customerMsg.role !== 'customer') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerMsg.customerId } });
    if (!customer) return reply.code(404).send({ error: 'customer_not_found' });

    // A reply that quotes a PRICE needs an explicit confirm (dates/times/phone/qty
    // no longer nag — staff review every draft before approving anyway).
    if (hasPrice(finalText) && !confirmNumbers) {
      return reply.code(409).send({ error: 'needs_confirm', reason: 'contains_price' });
    }

    const draft = await prisma.draft.findUnique({ where: { messageId: customerMsg.id } });

    // Resolve an optional attachment to send + record — a staff upload (photo/file)
    // OR a catalog product photo. Resolved BEFORE the message is created so the sent
    // attachment shows in the console (not just delivered to LINE). Images go as a
    // LINE image; files append a download link to the text (OAs can't attach files).
    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    let attach: { attachmentType: string; attachmentRef: string; attachmentName?: string } | undefined;
    let imageUrls: string[] = [];
    let sendText = finalText;
    if (parsed.data.uploadId && UPLOAD_ID_RE.test(parsed.data.uploadId)) {
      const meta = await readStaffUploadMeta(parsed.data.uploadId);
      if (meta) {
        const url = `${base}/content/upload/${parsed.data.uploadId}`;
        if (meta.kind === 'image') {
          imageUrls = [url];
          attach = { attachmentType: 'image', attachmentRef: parsed.data.uploadId };
        } else {
          sendText = `${finalText}\n\n📎 ${meta.fileName}: ${url}`;
          attach = { attachmentType: 'file', attachmentRef: parsed.data.uploadId, attachmentName: meta.fileName };
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

    // Claim this customer message atomically BEFORE sending. The unique
    // answersMessageId means a double-click / retry / concurrent request can't
    // double-send — only the first create wins; the rest get 409 already_replied.
    let agentMessage;
    try {
      agentMessage = await prisma.message.create({
        data: {
          customerId: customer.id,
          sessionId: customerMsg.sessionId,
          role: 'agent',
          text: finalText,
          agentId: agent.id,
          kbIds: draft?.usedKb ?? [],
          answersMessageId: customerMsg.id,
          ...(attach ?? {}),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({ error: 'already_replied' });
      }
      throw err;
    }

    // Send via LINE (or dry-run). On failure, release the claim so it can retry.
    let sendResult;
    try {
      sendResult = await sendLineReply(customer.lineUserId, sendText, imageUrls);
    } catch (err) {
      req.log.error({ err }, 'LINE send failed');
      await prisma.message.delete({ where: { id: agentMessage.id } }).catch(() => undefined);
      return reply.code(502).send({ error: 'line_send_failed' });
    }
    if (sendResult.channelMsgId) {
      agentMessage = await prisma.message.update({
        where: { id: agentMessage.id },
        data: { channelMsgId: sendResult.channelMsgId },
      });
    }

    // Embed the sent reply so it's retrievable in future drafts (best-effort).
    void embedMessage(agentMessage.id, finalText).catch(() => undefined);

    // Cross-sell learning — only when staff engaged the picker (attached >=1 catalog
    // photo): strengthen the cross-sells they attached, demote ones shown but skipped.
    const anchorSku = draft?.productSku ?? draft?.candidateSkus?.[0] ?? null;
    if (anchorSku && draft?.crossSellSkus?.length && parsed.data.attachProductSkus?.length) {
      void recordCrossSellOutcome(anchorSku, draft.crossSellSkus, parsed.data.attachProductSkus).catch(() => undefined);
    }

    // Learning loop: capture edits (final differs from the AI draft).
    let learnedCaptured = false;
    if (draft && finalText.trim() !== draft.draftText.trim()) {
      await prisma.learnedAnswer.create({
        data: {
          customerQuestion: customerMsg.text,
          aiDraft: draft.draftText,
          finalAnswer: finalText,
          agentId: agent.id,
          edited: true,
          status: 'pending',
        },
      });
      learnedCaptured = true;
    }

    await prisma.customer.update({ where: { id: customer.id }, data: { lastSeen: new Date() } });

    pushToConsole('conversation:update', { customerId: customer.id, message: agentMessage });

    return {
      ok: true,
      sent: sendResult.sent,
      dryRun: sendResult.dryRun,
      message: agentMessage,
      learnedCaptured,
    };
  });

  // POST /api/rewrite — polish an agent's drafted reply (grammar/wording/arrangement)
  // without changing meaning or numbers. Staff-initiated; the /reply send guard still
  // requires a numbers-confirm before anything reaches the customer.
  app.post('/api/rewrite', async (req, reply) => {
    const parsed = rewriteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const result = await rewriteText(parsed.data.text);
      return { text: result.text, note: result.note };
    } catch (err) {
      req.log.error({ err }, 'rewrite failed');
      return reply.code(502).send({ error: 'rewrite_failed' });
    }
  });
}
