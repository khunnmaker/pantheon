import { env } from '../env.js';
import { prisma } from '../db/prisma.js';
import { generateDraftForMessage, generateImageDraft, generateStickerDraft } from './draft.js';
import { pushToConsole } from '../ws/io.js';

type Kind = 'text' | 'image' | 'sticker';

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
export async function nonTextNeedsHuman(messageId: string, kind: string): Promise<void> {
  const label = KIND_LABEL[kind] ?? 'ข้อความ';
  const note = `ลูกค้าส่ง${label} — ระบบ AI ตอบจากฐานความรู้ไม่ได้ ขอให้เจ้าหน้าที่ตรวจและตอบเองค่ะ`;
  const draft = await prisma.draft.upsert({
    where: { messageId },
    update: { type: 'needs_human', draftText: '', note, usedKb: [] },
    create: { messageId, type: 'needs_human', draftText: '', usedKb: [], note, retrievedMsgIds: [] },
  });
  pushToConsole('draft:new', { messageId, draft, guardrailReason: null });
}

// One pending draft per customer. A new message in the burst window replaces the pending one —
// the LATEST message's draft already covers every unanswered message in the burst (draft.ts
// gathers them), so the earlier calls it replaces would have been thrown away anyway.
// In-process state: a restart drops pending timers (those messages simply get no auto-draft;
// staff can ร่างใหม่). Trade-off documented: in a mixed burst the LAST message's kind wins
// (e.g. a burst ending with an image/sticker generates that kind's draft).
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; messageId: string; kind: Kind }>();

export function scheduleDraft(customerId: string, messageId: string, kind: Kind): void {
  const existing = pending.get(customerId);
  if (existing) clearTimeout(existing.timer);
  const run = () => {
    pending.delete(customerId);
    void runDraft(customerId, messageId, kind);
  };
  if (env.DRAFT_DEBOUNCE_MS <= 0) {
    run();
    return;
  }
  pending.set(customerId, { timer: setTimeout(run, env.DRAFT_DEBOUNCE_MS), messageId, kind });
}

async function runDraft(customerId: string, messageId: string, kind: Kind): Promise<void> {
  try {
    const out =
      kind === 'image' ? await generateImageDraft(messageId)
      : kind === 'sticker' ? await generateStickerDraft(messageId)
      : await generateDraftForMessage(messageId);
    pushToConsole('draft:new', { messageId, customerId, draft: out.draft, guardrailReason: out.guardrailReason });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[draft] scheduled draft failed for', messageId, err);
    if (kind === 'image' || kind === 'sticker') {
      // Preserve the pre-queue webhook behavior: a failed image/sticker draft still leaves the
      // canned needs_human placeholder so the console flags it for a person. Best-effort.
      await nonTextNeedsHuman(messageId, kind).catch(() => undefined);
    }
  }
}
