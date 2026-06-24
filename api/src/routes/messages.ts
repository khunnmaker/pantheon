import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { sendLineText } from '../line/send.js';
import { generateDraftForMessage } from '../llm/draft.js';
import { hasNumbers } from '../llm/guardrails.js';
import { pushToConsole } from '../ws/io.js';

const replyBody = z.object({
  finalText: z.string().min(1),
  confirmNumbers: z.boolean().optional(),
});

export async function messageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

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

    // Any reply containing numbers (price/qty/date) needs an explicit confirm.
    if (hasNumbers(finalText) && !confirmNumbers) {
      return reply.code(409).send({ error: 'needs_confirm', reason: 'contains_numbers' });
    }

    const draft = await prisma.draft.findUnique({ where: { messageId: customerMsg.id } });

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
      sendResult = await sendLineText(customer.lineUserId, finalText);
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
}
