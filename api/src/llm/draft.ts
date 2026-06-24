import type { Draft } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { buildDraftPrompt } from './prompt.js';
import { parseDraft, SAFE_DEFAULT, type DraftResult } from './parser.js';
import { applyGuardrails, type SensitiveIntent } from './guardrails.js';
import { callClaude, llmAvailable } from './anthropic.js';
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

  // Retrieval (M3 layer 2): embed this message for future recall, then pull the
  // top-K most relevant OLDER messages (excluding the recent window already shown).
  let retrievedMessages: string | undefined;
  let retrievedIds: string[] = [];
  if (embeddingsAvailable()) {
    await embedMessage(message.id, message.text);
    try {
      const qvec = await embedOne(message.text, 'query');
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

  let result: DraftResult;
  try {
    if (!llmAvailable()) {
      result = { ...SAFE_DEFAULT, note: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY — ขอให้เจ้าหน้าที่ตอบ' };
    } else {
      const { system, user } = buildDraftPrompt({
        question: message.text,
        kb,
        recentWindow,
        summary,
        retrievedMessages,
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
      retrievedMsgIds: retrievedIds,
    },
  });

  return { draft, result: guarded.result, guardrailReason: guarded.reason };
}
