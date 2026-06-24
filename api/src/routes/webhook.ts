import type { FastifyInstance } from 'fastify';
import { verifyLineSignature } from '../line/signature.js';
import { ingestCustomerText } from '../line/ingest.js';
import { saveImageContent } from '../line/contentStore.js';
import { generateDraftForMessage, generateImageDraft } from '../llm/draft.js';
import { prisma } from '../db/prisma.js';
import { pushToConsole } from '../ws/io.js';

// Cap events processed per webhook request (LINE batches are normally small).
const MAX_EVENTS = 50;

interface LineMessage {
  type: string;
  id?: string;
  text?: string;
  packageId?: string;
  stickerId?: string;
}
interface LineEvent {
  type: string;
  message?: LineMessage;
  source?: { type: string; userId?: string };
}
interface LineWebhookBody {
  events?: LineEvent[];
}

const KIND_LABEL: Record<string, string> = {
  image: 'รูปภาพ',
  sticker: 'สติกเกอร์',
  video: 'วิดีโอ',
  audio: 'เสียง',
  file: 'ไฟล์',
  location: 'ตำแหน่งที่ตั้ง',
};

// Non-text messages can't be answered from the KB → store a needs_human draft so
// the console flags it for a person (the AI never drafts a reply to a photo).
async function nonTextNeedsHuman(messageId: string, kind: string): Promise<void> {
  const label = KIND_LABEL[kind] ?? 'ข้อความ';
  const note = `ลูกค้าส่ง${label} — ระบบ AI ตอบจากฐานความรู้ไม่ได้ ขอให้เจ้าหน้าที่ตรวจและตอบเองค่ะ`;
  const draft = await prisma.draft.upsert({
    where: { messageId },
    update: { type: 'needs_human', draftText: '', note, usedKb: [] },
    create: { messageId, type: 'needs_human', draftText: '', usedKb: [], note, retrievedMsgIds: [] },
  });
  pushToConsole('draft:new', { messageId, draft, guardrailReason: null });
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
        if (ev.type !== 'message' || !ev.message) continue;
        const lineUserId = ev.source?.userId;
        if (!lineUserId) continue;

        // Dedup LINE's at-least-once delivery retries.
        const channelMsgId = ev.message.id;
        if (channelMsgId) {
          const dup = await prisma.message.findFirst({ where: { channelMsgId }, select: { id: true } });
          if (dup) continue;
        }

        const mtype = ev.message.type;

        if (mtype === 'text') {
          const text = ev.message.text;
          if (!text) continue;
          const result = await ingestCustomerText({ lineUserId, text, channelMsgId });
          pushToConsole('message:new', {
            customer: result.customer,
            message: result.message,
            isNewCustomer: result.isNewCustomer,
          });
          const msgId = result.message.id;
          const customerId = result.customer.id;
          void generateDraftForMessage(msgId)
            .then((d) =>
              pushToConsole('draft:new', { messageId: msgId, customerId, draft: d.draft, guardrailReason: d.guardrailReason }),
            )
            .catch((err) => req.log.error({ err }, 'draft generation failed'));
          continue;
        }

        if (mtype === 'sticker') {
          const ref = `${ev.message.packageId ?? ''}/${ev.message.stickerId ?? ''}`;
          const result = await ingestCustomerText({
            lineUserId,
            text: '[สติกเกอร์]',
            channelMsgId,
            attachmentType: 'sticker',
            attachmentRef: ref,
          });
          pushToConsole('message:new', {
            customer: result.customer,
            message: result.message,
            isNewCustomer: result.isNewCustomer,
          });
          await nonTextNeedsHuman(result.message.id, 'sticker');
          continue;
        }

        if (mtype === 'image') {
          const result = await ingestCustomerText({
            lineUserId,
            text: '[รูปภาพ]',
            channelMsgId,
            attachmentType: 'image',
          });
          let message = result.message;
          if (channelMsgId) {
            const contentType = await saveImageContent(message.id, channelMsgId);
            if (contentType) {
              message = await prisma.message.update({
                where: { id: message.id },
                data: { attachmentRef: contentType },
              });
            }
          }
          pushToConsole('message:new', {
            customer: result.customer,
            message,
            isNewCustomer: result.isNewCustomer,
          });
          // Let Claude read the photo and draft a reply (still human-approved).
          const imgMsgId = message.id;
          const imgCustomerId = result.customer.id;
          void generateImageDraft(imgMsgId)
            .then((d) =>
              pushToConsole('draft:new', { messageId: imgMsgId, customerId: imgCustomerId, draft: d.draft, guardrailReason: d.guardrailReason }),
            )
            .catch(async (err) => {
              req.log.error({ err }, 'image draft failed');
              await nonTextNeedsHuman(imgMsgId, 'image');
            });
          continue;
        }

        // video / audio / file / location / other
        const label = KIND_LABEL[mtype] ?? 'ข้อความ';
        const result = await ingestCustomerText({
          lineUserId,
          text: `[${label}]`,
          channelMsgId,
          attachmentType: mtype,
        });
        pushToConsole('message:new', {
          customer: result.customer,
          message: result.message,
          isNewCustomer: result.isNewCustomer,
        });
        await nonTextNeedsHuman(result.message.id, mtype);
      } catch (err) {
        req.log.error({ err }, 'failed to ingest LINE event');
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
