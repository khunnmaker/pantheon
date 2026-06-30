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
import { embedMessage } from '../memory/embeddings.js';
import { readImageContent } from '../line/contentStore.js';
import { PRODUCT_PHOTO_DIR } from './content.js';
import { saveStaffUpload, readStaffUploadMeta, UPLOAD_ID_RE } from '../line/staffUploads.js';
import { recordCrossSellOutcome } from '../catalog/crossSell.js';
import { recordReplyOutcome } from '../learning/recordOutcome.js';
import { recordProductKeywords } from '../catalog/match.js';
import { readSlip } from '../llm/readSlip.js';
import { sendToFinance } from '../finance/sendToFinance.js';
import { buildSlipUrl } from '../finance/slipLink.js';
import { normalizeSlipDate, normalizeAmount } from '../finance/normalize.js';
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

  // POST /api/messages/:id/draft — (re)generate the AI draft. Optional suggestSkus:
  // cross-sell products the staff picked → the new draft mentions/offers them.
  app.post<{ Params: { id: string } }>('/api/messages/:id/draft', async (req, reply) => {
    const sp = z.array(z.string()).max(8).safeParse((req.body as { suggestSkus?: unknown })?.suggestSkus);
    const mp = z.array(z.string()).max(8).safeParse((req.body as { mainSkus?: unknown })?.mainSkus);
    const at = z.string().max(2000).safeParse((req.body as { agentText?: unknown })?.agentText);
    const suggestSkus = sp.success && sp.data.length ? sp.data : undefined;
    const mainSkus = mp.success && mp.data.length ? mp.data : undefined;
    const agentText = at.success && at.data.trim() ? at.data : undefined;
    const opts = suggestSkus || mainSkus || agentText ? { suggestSkus, mainSkus, agentText } : undefined;
    try {
      const out = await generateDraftForMessage(req.params.id, opts);
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

  // POST /api/messages/:id/add-product — manually add a searched product to the draft's
  // picker as a main candidate (role 'main') or a cross-sell (role 'cross'), and STRENGTHEN
  // the learning link so the AI suggests it for similar questions next time:
  //   main  → keyword↔product (recordProductKeywords → boosts findProducts)
  //   cross → main↔cross link (recordCrossSellOutcome → boosts buildCrossSell)
  app.post<{ Params: { id: string } }>('/api/messages/:id/add-product', async (req, reply) => {
    const parsed = z.object({ sku: z.string().min(1).max(40), role: z.enum(['main', 'cross']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { sku, role } = parsed.data;
    const customerMsg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!customerMsg || customerMsg.role !== 'customer') return reply.code(404).send({ error: 'not_found' });
    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) return reply.code(404).send({ error: 'product_not_found' });
    const draft = await prisma.draft.findUnique({ where: { messageId: customerMsg.id } });
    if (!draft) return reply.code(404).send({ error: 'no_draft' });

    if (role === 'main') {
      const next = draft.candidateSkus.includes(sku) ? draft.candidateSkus : [...draft.candidateSkus, sku];
      await prisma.draft.update({ where: { messageId: customerMsg.id }, data: { candidateSkus: next } });
      await recordProductKeywords(sku, customerMsg.text).catch(() => undefined);
    } else {
      const next = draft.crossSellSkus.includes(sku) ? draft.crossSellSkus : [...draft.crossSellSkus, sku];
      await prisma.draft.update({ where: { messageId: customerMsg.id }, data: { crossSellSkus: next } });
      const anchorSku = draft.productSku ?? draft.candidateSkus[0] ?? null;
      if (anchorSku) await recordCrossSellOutcome(anchorSku, [sku], [sku]).catch(() => undefined);
    }
    return { ok: true, sku, role };
  });

  // POST /api/messages/:id/read-slip — OCR a customer's payment-slip image into
  // {amount, bank, transferAt, ref} to pre-fill the "แจ้งการเงิน" card (best-effort;
  // empty fields when the LLM is unavailable). Also returns the customer's names.
  app.post<{ Params: { id: string } }>('/api/messages/:id/read-slip', async (req, reply) => {
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!msg || msg.attachmentType !== 'image') return reply.code(404).send({ error: 'not_an_image' });
    const customer = await prisma.customer.findUnique({ where: { id: msg.customerId } });
    const fields = await readSlip(msg.id, msg.attachmentRef || 'image/jpeg');
    // Store the OCR amount server-side (tamper-proof) for the corrected-amount audit.
    if (fields.amount) await prisma.message.update({ where: { id: msg.id }, data: { slipAmount: fields.amount } }).catch(() => undefined);
    return {
      amount: fields.amount, bank: fields.bank, transferAt: fields.transferAt, ref: fields.ref,
      nickname: customer?.nickname ?? customer?.displayName ?? '',
      realName: fields.senderName, // from the SLIP (sender), not the random LINE name
    };
  });

  // POST /api/messages/:id/to-finance — forward the (staff-confirmed) slip details to
  // the finance Google Sheet, with a tokenized link to the slip, and mark it sent.
  app.post<{ Params: { id: string } }>('/api/messages/:id/to-finance', async (req, reply) => {
    const parsed = z.object({
      amount: z.string().max(40).optional(),
      bank: z.string().max(120).optional(),
      transferAt: z.string().max(60).optional(),
      ref: z.string().max(80).optional(),
      nickname: z.string().max(80).optional(),
      realName: z.string().max(120).optional(), // staff-confirmed sender name from the slip
      taxInvoice: z.string().max(600).optional(), // ใบกำกับภาษี: name / address / tax-ID (free text)
      note: z.string().max(600).optional(), // หมายเหตุ
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!msg || msg.attachmentType !== 'image') return reply.code(404).send({ error: 'not_an_image' });
    const customer = await prisma.customer.findUnique({ where: { id: msg.customerId } });
    if (!customer) return reply.code(404).send({ error: 'customer_not_found' });

    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    const nickname = parsed.data.nickname ?? customer.nickname ?? customer.displayName ?? '';
    const realName = parsed.data.realName ?? '';
    const amount = normalizeAmount(parsed.data.amount ?? '');
    const slipUrl = buildSlipUrl(base, msg.id);
    const sales = req.agent?.name ?? '';
    const result = await sendToFinance({
      nickname,
      realName,
      amount,
      bank: parsed.data.bank ?? '',
      transferAt: normalizeSlipDate(parsed.data.transferAt ?? ''),
      ref: parsed.data.ref ?? '',
      taxInvoice: parsed.data.taxInvoice ?? '',
      note: parsed.data.note ?? '',
      slipUrl,
      sales,
    });
    if (!result.ok) return reply.code(502).send({ error: 'finance_send_failed', detail: result.error });

    // Anti-tamper audit: the OCR amount is server-stored (sales can't influence it). If the
    // staff submitted a DIFFERENT amount, log it to Minerva's DB (NOT a sheet sales can edit)
    // — surfaced only to supervisors for verification.
    const ocrAmount = msg.slipAmount ?? '';
    const corrected = !!ocrAmount && ocrAmount !== amount;
    if (corrected) {
      const diff = (parseFloat(amount || '0') - parseFloat(ocrAmount || '0')).toFixed(2);
      await prisma.financeAudit.create({
        data: {
          messageId: msg.id, customerId: customer.id,
          nickname, senderName: realName, ocrAmount, amount, diff,
          salesName: sales, salesAgentId: req.agent?.id ?? null,
        },
      }).catch(() => undefined);
    }

    const updated = await prisma.message.update({ where: { id: msg.id }, data: { financeSentAt: new Date() } });
    return { ok: true, financeSentAt: updated.financeSentAt, corrected };
  });

  // POST /api/messages/:id/reply — approve & send a reply to the customer.
  // Human-in-the-loop: this is the ONLY path that sends to LINE.
  app.post<{ Params: { id: string } }>('/api/messages/:id/reply', async (req, reply) => {
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { finalText } = parsed.data;
    const agent = req.agent!;

    const customerMsg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!customerMsg || customerMsg.role !== 'customer') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerMsg.customerId } });
    if (!customer) return reply.code(404).send({ error: 'customer_not_found' });

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

    // Stage-1 learning instrumentation: record EVERY drafted send's outcome (accepted_verbatim
    // / edited / escalated) so per-category AI-accuracy becomes measurable. Best-effort.
    void recordReplyOutcome({ customerMessageId: customerMsg.id, customerQuestion: customerMsg.text, draft: draft ?? null, finalText, agentId: agent.id });

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
