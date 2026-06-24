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
  } catch {
    /* best-effort: a missing embedding only means this message won't be retrieved */
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
): Promise<RetrievedMessage[]> {
  const lit = toVectorLiteral(queryVec);
  const exclude = excludeIds.length ? excludeIds : ['']; // avoid empty NOT IN ()
  const rows = await prisma.$queryRaw<RetrievedMessage[]>`
    SELECT m.id, m.role, m.text
    FROM message_embedding me
    JOIN "Message" m ON m.id = me.message_id
    WHERE m."customerId" = ${customerId}
      AND m.id NOT IN (${Prisma.join(exclude)})
    ORDER BY me.embedding <=> ${lit}::vector
    LIMIT ${k}`;
  return rows;
}
