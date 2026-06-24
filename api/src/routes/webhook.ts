import type { FastifyInstance } from 'fastify';
import { verifyLineSignature } from '../line/signature.js';
import { ingestCustomerText } from '../line/ingest.js';
import { generateDraftForMessage } from '../llm/draft.js';
import { prisma } from '../db/prisma.js';
import { pushToConsole } from '../ws/io.js';

// Cap events processed per webhook request (LINE batches are normally small).
const MAX_EVENTS = 50;

// Minimal shape of the LINE webhook events we handle (text messages).
interface LineTextEvent {
  type: string;
  message?: { type: string; id?: string; text?: string };
  source?: { type: string; userId?: string };
}
interface LineWebhookBody {
  events?: LineTextEvent[];
}

export async function webhookRoutes(app: FastifyInstance) {
  // POST /webhook/line — no JWT; authenticated by LINE signature instead.
  app.post('/webhook/line', async (req, reply) => {
    const signature = req.headers['x-line-signature'] as string | undefined;
    const raw = req.rawBody ?? '';

    if (!verifyLineSignature(raw, signature)) {
      req.log.warn('rejected webhook: invalid X-Line-Signature');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const body = (req.body ?? {}) as LineWebhookBody;
    const allEvents = body.events ?? [];
    if (allEvents.length > MAX_EVENTS) {
      req.log.warn(`webhook batch of ${allEvents.length} events capped to ${MAX_EVENTS}`);
    }
    const events = allEvents.slice(0, MAX_EVENTS);

    for (const ev of events) {
      try {
        if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
        const lineUserId = ev.source?.userId;
        const text = ev.message?.text;
        if (!lineUserId || !text) continue;

        // Dedup LINE's at-least-once delivery retries: if we already stored this
        // message id, skip — don't re-ingest or re-spend a Claude draft call.
        const channelMsgId = ev.message?.id;
        if (channelMsgId) {
          const dup = await prisma.message.findFirst({ where: { channelMsgId }, select: { id: true } });
          if (dup) continue;
        }

        const result = await ingestCustomerText({
          lineUserId,
          text,
          channelMsgId,
        });

        // Live-push the new question to every logged-in console.
        pushToConsole('message:new', {
          customer: result.customer,
          message: result.message,
          isNewCustomer: result.isNewCustomer,
        });

        // Generate the AI draft asynchronously so the webhook responds fast to
        // LINE; push it to the console when ready. Never auto-sends.
        const msgId = result.message.id;
        const customerId = result.customer.id;
        void generateDraftForMessage(msgId)
          .then((d) =>
            pushToConsole('draft:new', {
              messageId: msgId,
              customerId,
              draft: d.draft,
              guardrailReason: d.guardrailReason,
            }),
          )
          .catch((err) => req.log.error({ err }, 'draft generation failed'));
      } catch (err) {
        // Don't fail the whole webhook on one bad event — log and continue so
        // LINE doesn't retry the entire batch.
        req.log.error({ err }, 'failed to ingest LINE event');
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
