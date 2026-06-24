import type { FastifyInstance } from 'fastify';
import { verifyLineSignature } from '../line/signature.js';
import { ingestCustomerText } from '../line/ingest.js';
import { pushToConsole } from '../ws/io.js';

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
    const events = body.events ?? [];

    for (const ev of events) {
      try {
        if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
        const lineUserId = ev.source?.userId;
        const text = ev.message?.text;
        if (!lineUserId || !text) continue;

        const result = await ingestCustomerText({
          lineUserId,
          text,
          channelMsgId: ev.message?.id,
        });

        // Live-push the new question to every logged-in console.
        pushToConsole('message:new', {
          customer: result.customer,
          message: result.message,
          isNewCustomer: result.isNewCustomer,
        });
      } catch (err) {
        // Don't fail the whole webhook on one bad event — log and continue so
        // LINE doesn't retry the entire batch.
        req.log.error({ err }, 'failed to ingest LINE event');
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
