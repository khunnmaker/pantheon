import type { Draft } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { buildDraftPrompt, buildImagePrompt, buildStickerPrompt } from './prompt.js';
import { findProducts } from '../catalog/match.js';
import { parseDraft, SAFE_DEFAULT, type DraftResult } from './parser.js';
import { applyGuardrails, type SensitiveIntent } from './guardrails.js';
import { callClaude, callClaudeWithImage, llmAvailable } from './anthropic.js';
import { readImageContent } from '../line/contentStore.js';
import { embeddingsAvailable, embedMessage, embedOne, retrieveSimilarMessages } from '../memory/embeddings.js';

const histLine = (role: string, text: string) =>
  `${role === 'customer' ? 'ลูกค้า' : 'ร้าน'}: ${text}`;

export interface DraftOutcome {
  draft: Draft;
  result: DraftResult;
  guardrailReason: SensitiveIntent;
}

// Generate (or regenerate) the AI draft for a customer message:
// build context (KB + recent window — retrieval is M3) → Claude → parse →
// guardrails → store Draft. Safe-defaults to needs_human on any error.
export async function generateDraftForMessage(messageId: string): Promise<DraftOutcome> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.role !== 'customer') {
    throw new Error('draftable customer message not found');
  }

  // Non-text messages have dedicated draft paths (sticker = LINE keywords, image = vision).
  if (message.attachmentType === 'sticker') return generateStickerDraft(messageId);
  if (message.attachmentType === 'image') return generateImageDraft(messageId);

  const kb = await prisma.kbEntry.findMany({ where: { status: 'active' } });

  const recentRows = await prisma.message.findMany({
    where: { customerId: message.customerId },
    orderBy: { createdAt: 'desc' },
    take: env.RECENT_WINDOW,
  });
  const recentWindow = recentRows
    .reverse()
    .map((m) => histLine(m.role, m.text))
    .join('\n');

  // Long-term memory (M3 layer 1) — updated on session end.
  const memory = await prisma.customerMemory.findUnique({
    where: { customerId: message.customerId },
  });
  const summary = memory?.summary || undefined;

  // Answer ALL unanswered customer messages since the last agent reply — not just
  // the latest — so a single draft covers a customer's whole burst of questions.
  const lastAgent = await prisma.message.findFirst({
    where: { customerId: message.customerId, role: 'agent' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const unanswered = await prisma.message.findMany({
    where: {
      customerId: message.customerId,
      role: 'customer',
      ...(lastAgent ? { createdAt: { gt: lastAgent.createdAt } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 15,
  });
  const questionText =
    unanswered.length > 1
      ? unanswered.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
      : message.text;

  // Retrieval (M3 layer 2): embed this message for future recall, then pull the
  // top-K most relevant OLDER messages (excluding the recent window already shown).
  let retrievedMessages: string | undefined;
  let retrievedIds: string[] = [];
  if (embeddingsAvailable()) {
    await embedMessage(message.id, message.text);
    try {
      const qvec = await embedOne(questionText, 'query');
      const excludeIds = [message.id, ...recentRows.map((m) => m.id)];
      const hits = await retrieveSimilarMessages(message.customerId, qvec, env.RETRIEVE_K, excludeIds);
      if (hits.length) {
        retrievedMessages = hits.map((h) => histLine(h.role, h.text)).join('\n');
        retrievedIds = hits.map((h) => h.id);
      }
    } catch {
      /* retrieval is best-effort; degrade to summary + recent window */
    }
  }

  // M4: find catalog products matching the question; their prices are trusted
  // grounding so the AI may quote them (still numbers-confirmed at send time).
  const products = await findProducts(questionText);
  const groundedPriceText = products
    .filter((p) => p.price > 0)
    .map((p) => `${p.price}บาท`)
    .join(' ');

  let result: DraftResult;
  try {
    if (!llmAvailable()) {
      result = { ...SAFE_DEFAULT, note: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY — ขอให้เจ้าหน้าที่ตอบ' };
    } else {
      const { system, user } = buildDraftPrompt({
        question: questionText,
        kb,
        recentWindow,
        summary,
        retrievedMessages,
        products,
      });
      const raw = await callClaude(user, system);
      result = parseDraft(raw);
    }
  } catch {
    result = SAFE_DEFAULT;
  }

  // Guardrails: force needs_human for price/stock/clinical regardless of model.
  const citedKb = kb.filter((k) =>
    result.used_kb.map((s) => s.toLowerCase()).includes(k.id.toLowerCase()),
  );
  const guarded = applyGuardrails(result, questionText, citedKb, groundedPriceText);

  // Attach the catalog product (for its photo on send) only when the answer is
  // sendable and the model cited a real matched SKU.
  const matchedSku = (result.used_products ?? []).find((sku) =>
    products.some((p) => p.sku === sku),
  );
  const productSku = guarded.result.type === 'draft' ? matchedSku ?? null : null;

  const draft = await prisma.draft.upsert({
    where: { messageId },
    update: {
      type: guarded.result.type,
      draftText: guarded.result.draft,
      usedKb: guarded.result.used_kb,
      note: guarded.result.note,
      productSku,
    },
    create: {
      messageId,
      type: guarded.result.type,
      draftText: guarded.result.draft,
      usedKb: guarded.result.used_kb,
      note: guarded.result.note,
      retrievedMsgIds: retrievedIds,
      productSku,
    },
  });

  return { draft, result: guarded.result, guardrailReason: guarded.reason };
}

const IMAGE_FALLBACK: DraftResult = {
  type: 'needs_human',
  draft: '',
  used_kb: [],
  note: 'ลูกค้าส่งรูปภาพ — ขอให้เจ้าหน้าที่ตรวจและตอบเองค่ะ',
};

// Vision draft for an image message: send the stored image + context to Claude,
// parse, run the same guardrails, store the Draft. Safe-defaults to needs_human.
export async function generateImageDraft(messageId: string): Promise<DraftOutcome> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.role !== 'customer' || message.attachmentType !== 'image') {
    throw new Error('image message not found');
  }

  const kb = await prisma.kbEntry.findMany({ where: { status: 'active' } });
  const recentRows = await prisma.message.findMany({
    where: { customerId: message.customerId },
    orderBy: { createdAt: 'desc' },
    take: env.RECENT_WINDOW,
  });
  const recentWindow = recentRows.reverse().map((m) => histLine(m.role, m.text)).join('\n');
  const memory = await prisma.customerMemory.findUnique({ where: { customerId: message.customerId } });
  const summary = memory?.summary || undefined;

  let result: DraftResult;
  try {
    const buf = await readImageContent(message.id);
    if (!llmAvailable() || !buf) {
      result = IMAGE_FALLBACK;
    } else {
      const { system, user } = buildImagePrompt({ kb, recentWindow, summary });
      const raw = await callClaudeWithImage(user, system, {
        base64: buf.toString('base64'),
        mediaType: message.attachmentRef || 'image/jpeg',
      });
      result = parseDraft(raw);
    }
  } catch {
    result = IMAGE_FALLBACK;
  }

  // Same guardrails — scans the AI's draft text for price/clinical claims.
  const citedKb = kb.filter((k) =>
    result.used_kb.map((s) => s.toLowerCase()).includes(k.id.toLowerCase()),
  );
  const guarded = applyGuardrails(result, message.text, citedKb);

  const draft = await prisma.draft.upsert({
    where: { messageId },
    update: {
      type: guarded.result.type,
      draftText: guarded.result.draft,
      usedKb: guarded.result.used_kb,
      note: guarded.result.note,
    },
    create: {
      messageId,
      type: guarded.result.type,
      draftText: guarded.result.draft,
      usedKb: guarded.result.used_kb,
      note: guarded.result.note,
      retrievedMsgIds: [],
    },
  });

  return { draft, result: guarded.result, guardrailReason: guarded.reason };
}

const STICKER_FALLBACK: DraftResult = {
  type: 'needs_human',
  draft: '',
  used_kb: [],
  note: 'ลูกค้าส่งสติกเกอร์ — ขอให้เจ้าหน้าที่ดูและตอบเองค่ะ',
};

// Draft a reply to a STICKER using LINE's keyword(s) (kept on the message text)
// for its meaning + recent context. Safe-defaults to needs_human.
export async function generateStickerDraft(messageId: string): Promise<DraftOutcome> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.role !== 'customer' || message.attachmentType !== 'sticker') {
    throw new Error('sticker message not found');
  }
  const meaning = message.text.replace(/^\[สติกเกอร์\]\s*/, '').trim();

  const recentRows = await prisma.message.findMany({
    where: { customerId: message.customerId },
    orderBy: { createdAt: 'desc' },
    take: env.RECENT_WINDOW,
  });
  const recentWindow = recentRows.reverse().map((m) => histLine(m.role, m.text)).join('\n');
  const memory = await prisma.customerMemory.findUnique({ where: { customerId: message.customerId } });
  const summary = memory?.summary || undefined;

  let result: DraftResult;
  try {
    if (!llmAvailable() || !meaning) {
      result = STICKER_FALLBACK;
    } else {
      const { system, user } = buildStickerPrompt({ meaning, recentWindow, summary });
      const raw = await callClaude(user, system);
      result = parseDraft(raw);
    }
  } catch {
    result = STICKER_FALLBACK;
  }

  const guarded = applyGuardrails(result, meaning, []);

  const draft = await prisma.draft.upsert({
    where: { messageId },
    update: {
      type: guarded.result.type,
      draftText: guarded.result.draft,
      usedKb: guarded.result.used_kb,
      note: guarded.result.note,
    },
    create: {
      messageId,
      type: guarded.result.type,
      draftText: guarded.result.draft,
      usedKb: guarded.result.used_kb,
      note: guarded.result.note,
      retrievedMsgIds: [],
    },
  });

  return { draft, result: guarded.result, guardrailReason: guarded.reason };
}
