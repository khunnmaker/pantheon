import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../env.js';

// ── EmbeddingProvider (swappable, spec §3) ───────────────────────────────
// Default: Voyage AI `voyage-3` → 1024-dim vectors (matches vector(1024)).
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';

export function embeddingsAvailable(): boolean {
  return !!env.VOYAGE_API_KEY;
}

// input_type improves retrieval: documents are stored, queries are searched.
export async function embed(
  texts: string[],
  inputType: 'document' | 'query' = 'document',
): Promise<number[][]> {
  if (!env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY not configured');
  if (texts.length === 0) return [];

  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType }),
  });
  if (!res.ok) throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => d.embedding);
}

export async function embedOne(text: string, inputType: 'document' | 'query'): Promise<number[]> {
  return (await embed([text], inputType))[0];
}

// pgvector accepts a textual literal like "[0.1,0.2,...]" cast to ::vector.
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

// ── storage (raw SQL — embedding tables are not Prisma-managed) ───────────
export async function storeMessageEmbedding(messageId: string, vec: number[]): Promise<void> {
  const lit = toVectorLiteral(vec);
  await prisma.$executeRaw`
    INSERT INTO message_embedding (message_id, embedding)
    VALUES (${messageId}, ${lit}::vector)
    ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding`;
}

// Embed + store a message; best-effort (never throws — retrieval just degrades).
export async function embedMessage(messageId: string, text: string): Promise<void> {
  if (!embeddingsAvailable()) return;
  try {
    const [vec] = await embed([text], 'document');
    await storeMessageEmbedding(messageId, vec);
  } catch (err) {
    // best-effort: a missing embedding only means this message won't be retrieved
    // eslint-disable-next-line no-console
    console.warn('[embed] message embed failed for', messageId, err);
  }
}

export interface RetrievedMessage {
  id: string;
  role: string;
  text: string;
}

// Top-K past messages for a customer most similar to the query vector (cosine).
// Excludes the recent-window messages (passed verbatim already) and the current one.
export async function retrieveSimilarMessages(
  customerId: string,
  queryVec: number[],
  k: number,
  excludeIds: string[],
  afterDate?: Date | null,
): Promise<RetrievedMessage[]> {
  const lit = toVectorLiteral(queryVec);
  const exclude = excludeIds.length ? excludeIds : ['']; // avoid empty NOT IN ()
  // Respect the "ตอบแล้ว" cutoff: never retrieve messages handled before it.
  const afterClause = afterDate ? Prisma.sql`AND m."createdAt" > ${afterDate}` : Prisma.empty;
  const rows = await prisma.$queryRaw<RetrievedMessage[]>`
    SELECT m.id, m.role, m.text
    FROM message_embedding me
    JOIN "Message" m ON m.id = me.message_id
    WHERE m."customerId" = ${customerId}
      AND m.id NOT IN (${Prisma.join(exclude)})
      ${afterClause}
    ORDER BY me.embedding <=> ${lit}::vector
    LIMIT ${k}`;
  return rows;
}

// ── KB embeddings (kb_embedding table exists from the M3 pgvector migration) ──

// Text that represents a KB entry in the vector space: the questions it answers plus
// the fact/answer, so both question-phrased and topic-phrased queries can retrieve it.
export function kbEmbeddingText(entry: { questionVariants: string[]; answer: string }): string {
  return [entry.questionVariants.join('\n'), entry.answer].filter(Boolean).join('\n');
}

// sha256 of the embedded text — stored beside the vector so staleness is detectable.
export function kbTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function storeKbEmbedding(kbId: string, vec: number[], textHash: string): Promise<void> {
  const lit = toVectorLiteral(vec);
  await prisma.$executeRaw`
    INSERT INTO kb_embedding (kb_id, embedding, text_hash)
    VALUES (${kbId}, ${lit}::vector, ${textHash})
    ON CONFLICT (kb_id) DO UPDATE SET embedding = EXCLUDED.embedding, text_hash = EXCLUDED.text_hash`;
}

// Embed + store one KB entry; best-effort (never throws — retrieval just falls back to
// the full KB if an entry is missing its embedding).
export async function embedKbEntry(kbId: string, text: string): Promise<void> {
  if (!embeddingsAvailable()) return;
  try {
    const [vec] = await embed([text], 'document');
    await storeKbEmbedding(kbId, vec, kbTextHash(text));
  } catch (err) {
    // Couldn't (re)embed — drop any existing row so we never serve a STALE vector for an
    // edited entry. Retrieval then falls back to the full KB for it, and the next boot's
    // backfill (which targets rows with no embedding) re-embeds it.
    await deleteKbEmbedding(kbId);
    // eslint-disable-next-line no-console
    console.warn('[kb] embed failed for', kbId, err);
  }
}

export async function deleteKbEmbedding(kbId: string): Promise<void> {
  try {
    await prisma.$executeRaw`DELETE FROM kb_embedding WHERE kb_id = ${kbId}`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[kb] delete embedding failed for', kbId, err);
  }
}

// Top-K active KB entry IDs most similar to the query vector (cosine distance).
export async function retrieveRelevantKbIds(queryVec: number[], k: number): Promise<string[]> {
  const lit = toVectorLiteral(queryVec);
  const rows = await prisma.$queryRaw<{ kb_id: string }[]>`
    SELECT ke.kb_id
    FROM kb_embedding ke
    JOIN "KbEntry" k ON k.id = ke.kb_id
    WHERE k.status = 'active'
    ORDER BY ke.embedding <=> ${lit}::vector
    LIMIT ${k}`;
  return rows.map((r) => r.kb_id);
}

// How many ACTIVE KB entries currently have an embedding row. Lets retrieval detect a
// not-yet-warm index (boot backfill mid-run, or a write whose re-embed failed) and fall
// back to the full KB rather than search a half-populated index.
export async function countActiveKbEmbeddings(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM kb_embedding ke
    JOIN "KbEntry" k ON k.id = ke.kb_id
    WHERE k.status = 'active'`;
  return rows[0]?.n ?? 0;
}

// The single most-similar EXISTING active KB entry to `text` (cosine), with its similarity in
// [0,1]. Used at promote time to flag a near-duplicate / possible conflict to the supervisor.
// Best-effort: returns null if embeddings are unavailable or the query fails.
export async function findSimilarKb(
  text: string,
): Promise<{ id: string; category: string; answer: string; similarity: number } | null> {
  if (!embeddingsAvailable()) return null;
  try {
    const vec = await embedOne(text, 'document');
    const lit = toVectorLiteral(vec);
    const rows = await prisma.$queryRaw<{ id: string; category: string; answer: string; similarity: number }[]>`
      SELECT k.id, k.category, k.answer, 1 - (ke.embedding <=> ${lit}::vector) AS similarity
      FROM kb_embedding ke
      JOIN "KbEntry" k ON k.id = ke.kb_id
      WHERE k.status = 'active'
      ORDER BY ke.embedding <=> ${lit}::vector
      LIMIT 1`;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
