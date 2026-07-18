import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { detectSensitiveIntent } from '../llm/guardrails.js';
import { textSimilarity } from '../llm/textSimilarity.js';

// Normalized character-level edit distance (Levenshtein) → 0..1, where 0 = identical.
// Replies are short, so the O(m·n) loop is cheap and only runs on the (rarer) edited sends.
function editRatio(a: string, b: string): number {
  a = a.trim();
  b = b.trim();
  if (a === b) return 0;
  if (!a.length || !b.length) return 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] / Math.max(m, n);
}

function editBucket(r: number): string {
  if (r <= 0) return 'none';
  if (r < 0.1) return 'cosmetic';
  if (r < 0.3) return 'minor';
  if (r < 0.7) return 'major';
  return 'rewrite';
}

interface DraftLike {
  draftText: string;
  type: string; // draft | needs_human | out_of_scope
  usedKb: string[];
  productSku: string | null;
  candidateSkus: string[];
}

// Record the outcome of an AI-drafted reply for learning/accuracy metrics. This is the
// positive-signal capture the loop was missing: it logs EVERY drafted send (not just edits),
// so per-category accept/edit/escalation rates become measurable — the foundation for any
// future autonomy decision. Best-effort: never throws, never blocks a send.
export async function recordReplyOutcome(opts: {
  customerMessageId: string;
  customerQuestion: string;
  draft: DraftLike | null;
  finalText: string;
  agentId: string | null;
  forceAccepted?: boolean;
}): Promise<void> {
  try {
    const { draft, finalText, customerQuestion } = opts;
    if (!draft) return; // only AI-drafted replies count toward AI-accuracy metrics

    let outcome: 'accepted_verbatim' | 'edited' | 'escalated';
    let ratio = 0;
    let similarity: number | null = null;
    if (opts.forceAccepted) {
      outcome = 'accepted_verbatim';
    } else if (draft.type !== 'draft') {
      outcome = 'escalated'; // AI deferred (needs_human / out_of_scope); a human composed the reply
    } else if (finalText.trim() === draft.draftText.trim()) {
      outcome = 'accepted_verbatim'; // the AI was right — sent as-is
    } else {
      outcome = 'edited';
      ratio = editRatio(draft.draftText, finalText);
      similarity = textSimilarity(draft.draftText, finalText);
    }

    const sensitive = detectSensitiveIntent(customerQuestion); // price_stock | payment | clinical | null
    const category =
      sensitive ??
      (draft.productSku || draft.candidateSkus.length ? 'product' : draft.usedKb.length ? 'kb' : 'general');

    await prisma.$executeRaw`
      INSERT INTO "ReplyOutcome" (id, "customerMessageId", "draftType", category, outcome, "editScore", "editBucket", similarity, "agentId", "sentAt")
      VALUES (${randomUUID()}, ${opts.customerMessageId}, ${draft.type}, ${category}, ${outcome}, ${ratio}, ${editBucket(ratio)}, ${similarity}, ${opts.agentId}, now())`;
  } catch {
    /* metrics are best-effort — a logging failure must never affect a customer reply */
  }
}
