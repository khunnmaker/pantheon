import type { Draft } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { sendLineReply } from '../line/send.js';
import { embedMessage } from '../memory/embeddings.js';
import { recordCrossSellOutcome } from '../catalog/crossSell.js';
import { learningCaptureDecision } from '../learning/captureFilter.js';
import { recordReplyOutcome } from '../learning/recordOutcome.js';
import { pushToConsole } from '../ws/io.js';

type DraftReplyInput = {
  customer: { id: string; lineUserId: string };
  customerMessage: { id: string; customerId: string; sessionId: string | null; text: string };
  draft: Draft | null;
  finalText: string;
  sendText?: string;
  agentId: string | null;
  autoSent?: boolean;
  imageUrls?: string[];
  quoteToken?: string;
  quotedMessageId?: string;
  attachment?: { attachmentType: string; attachmentRef: string; attachmentName?: string };
  attachProductSkus?: string[];
};

export type DraftReplyResult =
  | { ok: true; message: Awaited<ReturnType<typeof prisma.message.create>>; sent: boolean; dryRun: boolean; learnedCaptured: boolean }
  | { ok: false; reason: 'already_replied' | 'line_send_failed'; error?: unknown };

// Shared authoritative delivery path for manual approval and supervised auto-send.
export async function sendDraftReply(input: DraftReplyInput): Promise<DraftReplyResult> {
  let message;
  try {
    message = await prisma.message.create({
      data: {
        customerId: input.customer.id,
        sessionId: input.customerMessage.sessionId,
        role: 'agent',
        text: input.finalText,
        agentId: input.agentId,
        kbIds: input.draft?.usedKb ?? [],
        answersMessageId: input.customerMessage.id,
        autoSent: input.autoSent === true,
        ...(input.quotedMessageId ? { quotedMessageId: input.quotedMessageId } : {}),
        ...(input.attachment ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, reason: 'already_replied' };
    }
    throw error;
  }

  let lineResult;
  try {
    lineResult = await sendLineReply(
      input.customer.lineUserId,
      input.sendText ?? input.finalText,
      input.imageUrls ?? [],
      input.quoteToken,
    );
  } catch (error) {
    await prisma.message.delete({ where: { id: message.id } }).catch(() => undefined);
    return { ok: false, reason: 'line_send_failed', error };
  }

  if (lineResult.channelMsgId || lineResult.quoteToken) {
    message = await prisma.message.update({
      where: { id: message.id },
      data: {
        ...(lineResult.channelMsgId ? { channelMsgId: lineResult.channelMsgId } : {}),
        ...(lineResult.quoteToken ? { quoteToken: lineResult.quoteToken } : {}),
      },
    });
  }

  void embedMessage(message.id, input.finalText).catch(() => undefined);
  const anchorSku = input.draft?.productSku ?? input.draft?.candidateSkus?.[0] ?? null;
  if (anchorSku && input.draft?.crossSellSkus?.length && input.attachProductSkus?.length) {
    void recordCrossSellOutcome(anchorSku, input.draft.crossSellSkus, input.attachProductSkus).catch(() => undefined);
  }

  let learnedCaptured = false;
  if (
    input.agentId && input.draft && input.finalText.trim() !== input.draft.draftText.trim()
    && learningCaptureDecision(input.draft.draftText, input.finalText).capture
  ) {
    try {
      await prisma.learnedAnswer.create({
        data: {
          customerQuestion: input.customerMessage.text,
          aiDraft: input.draft.draftText,
          finalAnswer: input.finalText,
          agentId: input.agentId,
          edited: true,
          status: 'pending',
        },
      });
      learnedCaptured = true;
    } catch {
      // Learning capture is best-effort after a successful customer send.
    }
  }

  void recordReplyOutcome({
    customerMessageId: input.customerMessage.id,
    customerQuestion: input.customerMessage.text,
    draft: input.draft,
    finalText: input.finalText,
    agentId: input.agentId,
    forceAccepted: input.autoSent === true,
  });
  await prisma.customer.update({ where: { id: input.customer.id }, data: { lastSeen: new Date() } });
  pushToConsole('conversation:update', { customerId: input.customer.id, message });
  return { ok: true, message, sent: lineResult.sent, dryRun: lineResult.dryRun, learnedCaptured };
}
