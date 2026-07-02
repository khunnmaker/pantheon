import type { KbEntry } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { embed, embeddingsAvailable, retrieveRelevantKbIds, countActiveKbEmbeddings } from './embeddings.js';
import { backfillKbEmbeddings } from '../db/ensureSeeded.js';

// At/below this many active entries the whole KB fits comfortably in the prompt, so we inject
// all of it — cheaper and zero risk of dropping a relevant entry. Above it we switch to
// semantic retrieval so the prompt stays bounded as the KB grows (every promotion adds one).
const INJECT_ALL_MAX = 30;
// Top-K per individual question (results are unioned across a burst's questions).
const PER_QUERY_K = 12;
// Cap how many of a burst's questions drive retrieval — matches the draft pipeline's 15-message
// unanswered-burst cap so a long burst's earlier questions still contribute to retrieval.
// Queries are embedded in one batched Voyage call and the per-vector pgvector lookups are
// cheap, so this can track the burst cap rather than being an independent, tighter limit.
const MAX_QUERIES = 15;

// Debounced self-heal trigger (no timers — just a last-attempt timestamp) so a warm-miss during
// a live draft kicks the backfill without hammering it on every request while it's running.
let lastBackfillAttempt = 0;
const BACKFILL_DEBOUNCE_MS = 60_000;
function maybeBackfill(): void {
  const now = Date.now();
  if (now - lastBackfillAttempt < BACKFILL_DEBOUNCE_MS) return;
  lastBackfillAttempt = now;
  void backfillKbEmbeddings();
}

// Choose the KB entries to put in a draft prompt for the customer's question(s). Safe by
// construction — it returns the FULL active KB (the original behavior) whenever:
//   • embeddings are unavailable, the KB is small, or there are no questions
//   • the embedding index is not fully warm (boot backfill mid-run, or a write whose
//     re-embed failed) — so a not-yet-indexed entry is never silently dropped
//   • retrieval returns nothing, or anything throws
// Otherwise it returns the per-question top-K union PLUS every non-'normal' (policy/price/
// clinical) entry, which is ALWAYS kept so safety/policy knowledge can't be dropped by ranking.
export async function selectRelevantKb(queries: string[]): Promise<KbEntry[]> {
  const allActive = await prisma.kbEntry.findMany({ where: { status: 'active' } });
  const qs = queries.map((q) => q.trim()).filter(Boolean).slice(-MAX_QUERIES);
  if (!embeddingsAvailable() || allActive.length <= INJECT_ALL_MAX || qs.length === 0) {
    return allActive;
  }
  try {
    // Don't search a half-populated index — inject the whole KB until every active entry is
    // embedded (the backfill is idempotent and converges; a failed re-embed drops its row).
    const embedded = await countActiveKbEmbeddings();
    if (embedded < allActive.length) {
      // eslint-disable-next-line no-console
      console.warn(`[kb] embedding index not warm (${embedded}/${allActive.length}); using full KB`);
      // Self-heal: kick the backfill (debounced) so one failed embed doesn't disarm semantic
      // retrieval until the next deploy — the index repairs on a live draft instead.
      maybeBackfill();
      return allActive;
    }
    // Per-question retrieval, unioned: one off-topic line in a burst can't push another
    // question's relevant fact below a single shared cutoff.
    const vecs = await embed(qs, 'query');
    const idLists = await Promise.all(vecs.map((v) => retrieveRelevantKbIds(v, PER_QUERY_K)));
    const idSet = new Set(idLists.flat());
    if (idSet.size === 0) return allActive;
    const selected = allActive.filter((k) => idSet.has(k.id) || k.sensitivity !== 'normal');
    return selected.length ? selected : allActive;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[kb] semantic retrieval failed, using full KB', err);
    return allActive; // any retrieval failure → fall back to the full KB
  }
}
