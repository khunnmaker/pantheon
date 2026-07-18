import { createHash } from 'node:crypto';
import type { Draft } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { pushToConsole } from '../ws/io.js';
import { sendDraftReply } from '../reply/sendDraftReply.js';
import { getAutosendConfig, incrementAutosendCanceled } from './config.js';
import { containsAnyDigit, SLIP_ACK_LANE } from './lane.js';

type Schedule = {
  timer: ReturnType<typeof setTimeout>;
  draftId: string;
  messageId: string;
  customerId: string;
  sendAt: number;
  expectedUpdatedAt: number;
  expectedTextHash: string;
};

const active = new Map<string, Schedule>();

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function getActiveAutosend(customerId: string): { customerId: string; draftId: string; sendAt: number } | null {
  const entry = [...active.values()].find((item) => item.customerId === customerId);
  return entry ? { customerId, draftId: entry.draftId, sendAt: entry.sendAt } : null;
}

async function finishCanceled(entry: Schedule, reason: string): Promise<void> {
  if (active.get(entry.draftId) !== entry) return;
  active.delete(entry.draftId);
  clearTimeout(entry.timer);
  pushToConsole('autosend:canceled', { customerId: entry.customerId, draftId: entry.draftId, reason });
  await incrementAutosendCanceled().catch(() => undefined);
}

export async function cancelAutosendForDraft(draftId: string, reason = 'staff_canceled'): Promise<boolean> {
  const entry = active.get(draftId);
  if (!entry) return false;
  await finishCanceled(entry, reason);
  return true;
}

export async function cancelAutosendForCustomer(customerId: string, reason: string): Promise<boolean> {
  const entries = [...active.values()].filter((item) => item.customerId === customerId);
  await Promise.all(entries.map((entry) => finishCanceled(entry, reason)));
  return entries.length > 0;
}

export async function cancelAllAutosends(reason = 'config_disabled'): Promise<number> {
  const entries = [...active.values()];
  await Promise.all(entries.map((entry) => finishCanceled(entry, reason)));
  return entries.length;
}

export async function maybeScheduleAutosend(customerId: string, draft: Draft): Promise<boolean> {
  if (draft.lane !== SLIP_ACK_LANE || draft.type !== 'draft' || containsAnyDigit(draft.draftText)) return false;
  const config = await getAutosendConfig();
  if (!config.enabled) return false;

  await cancelAutosendForCustomer(customerId, 'draft_replaced');
  const sendAt = Date.now() + config.delaySeconds * 1000;
  const run = () => void fireAutosend(draft.id);
  const entry: Schedule = {
    timer: setTimeout(run, config.delaySeconds * 1000),
    draftId: draft.id,
    messageId: draft.messageId,
    customerId,
    sendAt,
    expectedUpdatedAt: draft.updatedAt.getTime(),
    expectedTextHash: hashText(draft.draftText),
  };
  entry.timer.unref?.();
  active.set(draft.id, entry);
  pushToConsole('autosend:scheduled', { customerId, draftId: draft.id, sendAt });
  return true;
}

export async function fireAutosend(draftId: string): Promise<void> {
  const entry = active.get(draftId);
  if (!entry) return;

  const [config, draft, customerMessage, customer] = await Promise.all([
    getAutosendConfig(),
    prisma.draft.findUnique({ where: { id: draftId } }),
    prisma.message.findUnique({ where: { id: entry.messageId } }),
    prisma.customer.findUnique({ where: { id: entry.customerId }, select: { id: true, lineUserId: true } }),
  ]);
  if (!config.enabled) return finishCanceled(entry, 'config_disabled');
  if (
    !draft || draft.messageId !== entry.messageId || draft.lane !== SLIP_ACK_LANE || draft.type !== 'draft'
    || draft.updatedAt.getTime() !== entry.expectedUpdatedAt || hashText(draft.draftText) !== entry.expectedTextHash
    || containsAnyDigit(draft.draftText)
  ) return finishCanceled(entry, 'draft_changed');
  if (!customer || !customerMessage || customerMessage.role !== 'customer' || customerMessage.customerId !== entry.customerId) {
    return finishCanceled(entry, 'message_missing');
  }

  const [answer, laterCustomerMessage, staffMessage] = await Promise.all([
    prisma.message.findFirst({ where: { answersMessageId: entry.messageId }, select: { id: true } }),
    prisma.message.findFirst({
      where: { customerId: entry.customerId, role: 'customer', createdAt: { gt: customerMessage.createdAt } },
      select: { id: true },
    }),
    prisma.message.findFirst({
      where: { customerId: entry.customerId, role: 'agent', createdAt: { gte: customerMessage.createdAt } },
      select: { id: true },
    }),
  ]);
  if (answer || laterCustomerMessage || staffMessage || active.get(draftId) !== entry) {
    return finishCanceled(entry, 'conversation_changed');
  }

  // Remove before delivery so this timer cannot fire twice. A failed delivery deliberately leaves
  // the unchanged draft for staff and is not retried automatically.
  active.delete(draftId);
  const result = await sendDraftReply({
    customer,
    customerMessage,
    draft,
    finalText: draft.draftText,
    agentId: null,
    autoSent: true,
  });
  pushToConsole('autosend:canceled', {
    customerId: entry.customerId,
    draftId,
    reason: result.ok ? 'sent' : result.reason,
  });
}
