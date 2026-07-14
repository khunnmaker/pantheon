import type { FastifyInstance } from 'fastify';
import { verifyLineSignature } from '../line/signature.js';
import { ingestCustomerText } from '../line/ingest.js';
import { saveLineContent } from '../line/contentStore.js';
import { scheduleDraft, nonTextNeedsHuman, KIND_LABEL } from '../llm/draftQueue.js';
import { prisma } from '../db/prisma.js';
import { pushToConsole } from '../ws/io.js';
import { sendLineText } from '../line/send.js';

// Cap events processed per webhook request (LINE batches are normally small).
const MAX_EVENTS = 50;

interface LineMessage {
  type: string;
  id?: string;
  text?: string;
  packageId?: string;
  stickerId?: string;
  keywords?: string[]; // LINE-supplied words describing a sticker (e.g. "Thank you")
  fileName?: string; // for "file" messages
  fileSize?: number;
  mention?: { mentionees?: { isSelf?: boolean }[] }; // LINE @mention payload (text messages)
  quoteToken?: string; // token to quote THIS message later (text/sticker only)
  quotedMessageId?: string; // LINE channelMsgId of the message this one quote-replies to
}
interface LineEvent {
  type: string;
  message?: LineMessage;
  source?: { type: string; userId?: string; groupId?: string; roomId?: string };
}
interface LineWebhookBody {
  events?: LineEvent[];
}

// When a customer quote-replies one of OUR past messages, LINE gives the quoted message's
// channelMsgId. Resolve it to OUR internal Message.id (null if we don't have that message).
async function resolveQuotedMessageId(quotedChannelMsgId?: string): Promise<string | undefined> {
  if (!quotedChannelMsgId) return undefined;
  const quoted = await prisma.message.findFirst({
    where: { channelMsgId: quotedChannelMsgId },
    select: { id: true },
  });
  return quoted?.id ?? undefined;
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

        // Apollo LINE binding is deliberately intercepted before dedup/customer ingestion.
        // ONLY the exact one-time command, sent 1-on-1 by a user, is consumed; everything
        // else — including a code-shaped message in a group — follows the existing customer
        // pipeline byte-for-byte unchanged below.
        const apolloBind = ev.message.type === 'text'
          ? /^APOLLO-([A-Z0-9]{8})$/.exec(ev.message.text ?? '')
          : null;
        const staffLineUserId = ev.source?.type === 'user' ? ev.source.userId : undefined;
        if (apolloBind && staffLineUserId) {
          const agent = await prisma.agent.findUnique({ where: { lineBindCode: apolloBind[1] }, select: { id: true, name: true } });
          const already = await prisma.agent.findUnique({ where: { lineUserId: staffLineUserId }, select: { id: true } });
          if (!agent) {
            await sendLineText(staffLineUserId, 'รหัสผูก Apollo ไม่ถูกต้องหรือหมดอายุแล้ว');
          } else if (already && already.id !== agent.id) {
            await sendLineText(staffLineUserId, 'LINE นี้ผูกกับบัญชี Apollo อื่นแล้ว กรุณาติดต่อหัวหน้า');
          } else {
            await prisma.agent.update({ where: { id: agent.id }, data: { lineUserId: staffLineUserId, lineBindCode: null } });
            await sendLineText(staffLineUserId, `ผูก LINE กับ Apollo สำเร็จแล้ว (${agent.name})`);
          }
          continue;
        }
        // Conversation target = the GROUP/ROOM when the message came from one, else the 1-on-1
        // user. So a reply to a group message is pushed back to the GROUP (LINE routes by
        // groupId), not DM'd to the individual sender. LINE ids are globally unique (U…/C…/R…),
        // so keying the Customer by this target never collides a group with a user.
        const lineUserId = ev.source?.groupId ?? ev.source?.roomId ?? ev.source?.userId;
        if (!lineUserId) continue;
        // Group/room chatter is mostly staff talking to each other, not a customer asking the
        // OA something — auto-drafting every one of those messages was burning a full draft
        // call for free. Skip the auto-draft for group/room messages UNLESS the customer
        // explicitly @mentions the bot; staff can always ร่างใหม่ on a group message that does
        // need the AI. Ingest + message:new push + dedup are unaffected — only the draft is gated.
        const isGroup = !!(ev.source?.groupId || ev.source?.roomId);

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
          const quotedMessageId = await resolveQuotedMessageId(ev.message.quotedMessageId);
          const result = await ingestCustomerText({
            lineUserId,
            text,
            channelMsgId,
            quoteToken: ev.message.quoteToken ?? undefined,
            quotedMessageId,
          });
          pushToConsole('message:new', {
            customer: result.customer,
            message: result.message,
            isNewCustomer: result.isNewCustomer,
          });
          const msgId = result.message.id;
          const customerId = result.customer.id;
          const mentioned = ev.message.mention?.mentionees?.some((m) => m.isSelf === true) ?? false;
          if (!isGroup || mentioned) {
            scheduleDraft(customerId, msgId, 'text');
          }
          continue;
        }

        if (mtype === 'sticker') {
          const ref = `${ev.message.packageId ?? ''}/${ev.message.stickerId ?? ''}`;
          // LINE describes the sticker with keyword(s) (+ optional text on message stickers).
          const meaning = [ev.message.text, ...(ev.message.keywords ?? [])].filter(Boolean).join(', ');
          const quotedMessageId = await resolveQuotedMessageId(ev.message.quotedMessageId);
          const result = await ingestCustomerText({
            lineUserId,
            text: meaning ? `[สติกเกอร์] ${meaning}` : '[สติกเกอร์]',
            channelMsgId,
            attachmentType: 'sticker',
            attachmentRef: ref,
            quoteToken: ev.message.quoteToken ?? undefined,
            quotedMessageId,
          });
          pushToConsole('message:new', {
            customer: result.customer,
            message: result.message,
            isNewCustomer: result.isNewCustomer,
          });
          // With keyword(s) the AI can draft a fitting reply — debounced like text/image, so a
          // sticker+text burst still produces ONE draft; with none, defer to a human.
          if (!isGroup) {
            if (meaning) {
              scheduleDraft(result.customer.id, result.message.id, 'sticker');
            } else {
              await nonTextNeedsHuman(result.message.id, 'sticker');
            }
          }
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
            const contentType = await saveLineContent(message.id, channelMsgId);
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
          // Let Claude read the photo and draft a reply (still human-approved) — debounced so a
          // burst that includes an image only fires one draft (see draftQueue.ts).
          const imgMsgId = message.id;
          const imgCustomerId = result.customer.id;
          if (!isGroup) {
            scheduleDraft(imgCustomerId, imgMsgId, 'image');
          }
          continue;
        }

        // video / audio / file / location / other
        const label = KIND_LABEL[mtype] ?? 'ข้อความ';
        const fileName = ev.message.fileName;
        const result = await ingestCustomerText({
          lineUserId,
          text: fileName ? `[${label}] ${fileName}` : `[${label}]`,
          channelMsgId,
          attachmentType: mtype,
        });
        let message = result.message;
        // Download video/audio/file binaries so staff can view/download them in
        // the console (location has no content; others are markers only).
        if (channelMsgId && (mtype === 'video' || mtype === 'audio' || mtype === 'file')) {
          const contentType = await saveLineContent(message.id, channelMsgId);
          if (contentType) {
            message = await prisma.message.update({
              where: { id: message.id },
              data: { attachmentRef: contentType, ...(fileName ? { attachmentName: fileName } : {}) },
            });
          }
        }
        pushToConsole('message:new', {
          customer: result.customer,
          message,
          isNewCustomer: result.isNewCustomer,
        });
        if (!isGroup) {
          await nonTextNeedsHuman(message.id, mtype);
        }
      } catch (err) {
        req.log.error({ err }, 'failed to ingest LINE event');
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
