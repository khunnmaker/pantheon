import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { buildDraftPrompt } from './prompt.js';
import { callClaude, llmAvailable } from './anthropic.js';

// Pre-warm the prompt cache at boot (docs: max_tokens=0 reads the prompt and writes the
// cache without generating output — zero output tokens billed). After a deploy the first
// real draft would otherwise pay the cache WRITE premium mid-conversation; this shifts that
// one write to boot. Deliberately a single shot — NO keep-alive interval: with sustained
// business-hours traffic every draft refreshes the 5-min TTL for free, and re-warming an
// idle overnight cache would just buy warmth nobody uses.
//
// The cached prefix must be byte-identical to a real text draft's: cached[0] is the static
// rules block (question-independent), cached[1] is the KB block built from the same
// inject-all query (active entries, stable id order) that selectRelevantKb uses. If the KB
// has outgrown KB_INJECT_ALL_MAX (semantic mode; per-question KB blocks), cached[1] won't
// match real requests — but the rules block still warms via the prefix lookback.
export async function prewarmDraftCache(): Promise<void> {
  if (!llmAvailable()) return;
  try {
    const kb = await prisma.kbEntry.findMany({ where: { status: 'active' }, orderBy: { id: 'asc' } });
    const { system } = buildDraftPrompt({
      question: 'warmup',
      kb,
      recentWindow: '',
      products: [],
      suggestProducts: [],
      confirmedProducts: [],
      currentStage: null,
    });
    await callClaude('warmup', system, 0, undefined, { app: 'minerva', feature: 'prewarm' });
    // eslint-disable-next-line no-console
    console.log(`[prewarm] draft prompt cache warmed (${kb.length} KB entries${kb.length > env.KB_INJECT_ALL_MAX ? '; semantic mode — rules block only' : ''})`);
  } catch (err) {
    // Best-effort: a failed pre-warm just means the first real draft pays the cache write.
    // eslint-disable-next-line no-console
    console.warn('[prewarm] failed (first draft will warm the cache instead)', err);
  }
}
