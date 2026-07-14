import { env } from '../env.js';
import { prisma } from '../db/prisma.js';
import { generateDraftForMessage } from './draft.js';
import { pushToConsole } from '../ws/io.js';

export type Kind = 'text' | 'image' | 'sticker';

type PendingDraft = {
  timer: ReturnType<typeof setTimeout>;
  messageId: string;
  kind: Kind;
  fireAt: number;
};

// Thai labels for non-text message kinds (also used by the webhook's ingest text markers).
export const KIND_LABEL: Record<string, string> = {
  image: 'รูปภาพ',
  sticker: 'สติกเกอร์',
  video: 'วิดีโอ',
  audio: 'เสียง',
  file: 'ไฟล์',
  location: 'ตำแหน่งที่ตั้ง',
};

// Non-text messages can't be answered from the KB → store a needs_human draft so
// the console flags it for a person (the AI never drafts a reply to a photo).
async function createNonTextNeedsHuman(messageId: string, kind: string) {
  const label = KIND_LABEL[kind] ?? 'ข้อความ';
  const note = `ลูกค้าส่ง${label} — ระบบ AI ตอบจากฐานความรู้ไม่ได้ ขอให้เจ้าหน้าที่ตรวจและตอบเองค่ะ`;
  return prisma.draft.upsert({
    where: { messageId },
    update: { type: 'needs_human', draftText: '', note, usedKb: [] },
    create: { messageId, type: 'needs_human', draftText: '', usedKb: [], note, retrievedMsgIds: [] },
  });
}

export async function nonTextNeedsHuman(messageId: string, kind: string): Promise<void> {
  const draft = await createNonTextNeedsHuman(messageId, kind);
  pushToConsole('draft:new', { messageId, draft, guardrailReason: null });
}

// One pending draft per customer. A new message in the burst window replaces the pending one —
// the LATEST message's draft already covers every unanswered message in the burst (draft.ts
// gathers them), so the earlier calls it replaces would have been thrown away anyway.
// In-process state: a restart drops pending timers (those messages simply get no auto-draft;
// staff can ร่างใหม่). The latest message chooses the Draft row, while draft.ts gathers the
// entire unanswered burst and decides whether it needs text, sticker, or vision handling.
const pending = new Map<string, PendingDraft>();
const generating = new Set<string>();
const clearEpochs = new Map<string, number>();

export function getPending(customerId: string): Omit<PendingDraft, 'timer'> | null {
  const entry = pending.get(customerId);
  return entry ? { messageId: entry.messageId, kind: entry.kind, fireAt: entry.fireAt } : null;
}

export function isGenerating(customerId: string): boolean {
  return generating.has(customerId);
}

export function bumpClearEpoch(customerId: string): void {
  clearEpochs.set(customerId, (clearEpochs.get(customerId) ?? 0) + 1);
}

export function cancelPending(customerId: string): boolean {
  const entry = pending.get(customerId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(customerId);
  return true;
}

export function flushPending(customerId: string): boolean {
  const entry = pending.get(customerId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(customerId);
  void runDraft(customerId, entry.messageId, entry.kind);
  return true;
}

export function scheduleDraft(customerId: string, messageId: string, kind: Kind): void {
  const existing = pending.get(customerId);
  if (existing) clearTimeout(existing.timer);
  const fireAt = Date.now() + Math.max(0, env.DRAFT_DEBOUNCE_MS);
  pushToConsole('draft:queued', { customerId, messageId, fireAt });
  const run = () => {
    pending.delete(customerId);
    void runDraft(customerId, messageId, kind);
  };
  if (env.DRAFT_DEBOUNCE_MS <= 0) {
    run();
    return;
  }
  pending.set(customerId, { timer: setTimeout(run, env.DRAFT_DEBOUNCE_MS), messageId, kind, fireAt });
}

export async function runDraft(customerId: string, messageId: string, kind: Kind): Promise<void> {
  if (generating.has(customerId)) return;
  generating.add(customerId);
  const clearEpoch = clearEpochs.get(customerId) ?? 0;
  try {
    const out = await generateDraftForMessage(messageId);
    if ((clearEpochs.get(customerId) ?? 0) !== clearEpoch) {
      await prisma.draft.deleteMany({ where: { messageId } });
      return;
    }
    pushToConsole('draft:new', { messageId, customerId, draft: out.draft, guardrailReason: out.guardrailReason });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[draft] scheduled draft failed for', messageId, err);
    pushToConsole('draft:failed', { customerId, messageId });
    if (kind === 'image' || kind === 'sticker') {
      // Preserve the pre-queue webhook behavior: a failed image/sticker draft still leaves the
      // canned needs_human placeholder so the console flags it for a person. Best-effort.
      const draft = await createNonTextNeedsHuman(messageId, kind).catch(() => null);
      if (!draft) return;
      if ((clearEpochs.get(customerId) ?? 0) !== clearEpoch) {
        await prisma.draft.deleteMany({ where: { messageId } });
        return;
      }
      pushToConsole('draft:new', { messageId, customerId, draft, guardrailReason: null });
    }
  } finally {
    generating.delete(customerId);
  }
}
