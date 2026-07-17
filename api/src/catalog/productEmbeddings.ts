import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { embed, embeddingsAvailable } from '../memory/embeddings.js';

type ProductDocInput = {
  nameEn?: string | null;
  nameTh?: string | null;
  note?: string | null;
  keywords?: string[] | null;
  catalogGroup?: string | null;
  catalogSubgroup?: string | null;
};

type EnrichmentDocInput = {
  brand?: string | null;
  category?: string | null;
  categoryEn?: string | null;
  descriptionTh?: string | null;
  descriptionEn?: string | null;
  specs?: string[] | null;
};

function compact(values: Array<string | null | undefined>): string {
  return values.map((v) => v?.trim()).filter(Boolean).join(' / ');
}

// Stable, compact field order is part of the content-hash contract.
export function buildProductDoc(product: ProductDocInput, enrichment?: EnrichmentDocInput | null): string {
  return [
    product.nameEn?.trim(),
    product.nameTh?.trim(),
    product.note?.trim(),
    compact(product.keywords ?? []),
    compact([product.catalogGroup, product.catalogSubgroup]),
    enrichment?.brand?.trim(),
    compact([enrichment?.category, enrichment?.categoryEn]),
    compact([enrichment?.descriptionTh, enrichment?.descriptionEn, ...(enrichment?.specs ?? [])]),
  ].filter(Boolean).join(' | ');
}

export function productDocHash(doc: string): string {
  return createHash('sha256').update(doc).digest('hex');
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

let lastBackfillAttempt = 0;
let backfillRunning: Promise<void> | null = null;
let unavailableLogged = false;
const BACKFILL_DEBOUNCE_MS = 60_000;

// Boot-time best effort. The debounce also makes it safe to kick this from a future
// self-heal path without overlapping Voyage batches.
export function backfillProductEmbeddings(): Promise<void> {
  if (!embeddingsAvailable()) {
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.log('[product-embed] Voyage unavailable; semantic catalog search disabled');
    }
    return Promise.resolve();
  }
  const now = Date.now();
  if (backfillRunning) return backfillRunning;
  if (now - lastBackfillAttempt < BACKFILL_DEBOUNCE_MS) return Promise.resolve();
  lastBackfillAttempt = now;
  backfillRunning = runBackfill().finally(() => { backfillRunning = null; });
  return backfillRunning;
}

async function runBackfill(): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<Array<ProductDocInput & EnrichmentDocInput & {
      sku: string;
      contentHash: string | null;
    }>>`
      SELECT p.sku, p."nameEn", p."nameTh", p.note, p.keywords,
             p."catalogGroup", p."catalogSubgroup",
             e.brand, e.category, e."categoryEn", e."descriptionTh", e."descriptionEn", e.specs,
             pe."contentHash"
      FROM "Product" p
      LEFT JOIN "ProductEnrichment" e ON e.sku = p.sku
      LEFT JOIN "ProductEmbedding" pe ON pe.sku = p.sku
      WHERE p.status = 'active'`;
    const stale = rows.map((row) => {
      const doc = buildProductDoc(row, row);
      return { ...row, doc, hash: productDocHash(doc) };
    }).filter((row) => row.contentHash !== row.hash);

    const CHUNK = 64;
    let done = 0;
    for (let i = 0; i < stale.length; i += CHUNK) {
      const batch = stale.slice(i, i + CHUNK);
      try {
        const vectors = await embed(
          batch.map((row) => row.doc),
          'document',
          undefined,
          { app: 'diana', feature: 'product-embed' },
        );
        const results = await Promise.allSettled(batch.map((row, j) => {
          if (!vectors[j]) return Promise.reject(new Error('no vector'));
          const literal = vectorLiteral(vectors[j]);
          return prisma.$executeRaw`
            INSERT INTO "ProductEmbedding" (sku, embedding, "contentHash")
            VALUES (${row.sku}, ${literal}::vector, ${row.hash})
            ON CONFLICT (sku) DO UPDATE SET embedding = EXCLUDED.embedding,
              "contentHash" = EXCLUDED."contentHash", "updatedAt" = now()`;
        }));
        done += results.filter((result) => result.status === 'fulfilled').length;
      } catch (err) {
        console.warn('[product-embed] embedding chunk failed; will retry later', err);
      }
    }
    if (stale.length) console.log(`[product-embed] backfilled ${done}/${stale.length} products`);
  } catch (err) {
    console.warn('[product-embed] backfill failed; semantic search remains optional', err);
  }
}

export type SemanticHit = { sku: string; distance: number };
export const PRODUCT_DISTANCE_CUTOFF = 0.45;

export async function semanticProductSkus(query: string, limit: number, signal?: AbortSignal): Promise<SemanticHit[]> {
  const take = Math.max(0, Math.min(Math.floor(limit), 1000));
  if (!take) return [];
  const [vector] = await embed([query], 'query', signal, { app: 'diana', feature: 'search-embed' });
  if (!vector) return [];
  const literal = vectorLiteral(vector);
  // 0.45 is deliberately conservative for voyage-3 cosine distance: it retains close
  // multilingual clinical concepts while rejecting weak topical/product coincidences.
  return prisma.$queryRaw<SemanticHit[]>`
    SELECT pe.sku, pe.embedding <=> ${literal}::vector AS distance
    FROM "ProductEmbedding" pe
    JOIN "Product" p ON p.sku = pe.sku
    WHERE p.status = 'active'
      AND (pe.embedding <=> ${literal}::vector) <= ${PRODUCT_DISTANCE_CUTOFF}
    ORDER BY distance ASC
    LIMIT ${take}`;
}

export function looksLikeSku(query: string): boolean {
  const raw = query.trim();
  const skuFlat = raw.replace(/[^0-9a-z]/gi, '').toLowerCase();
  return skuFlat.length >= 2 && /\d/.test(skuFlat) && !/\s/.test(raw);
}

type SemanticDeps = {
  available?: () => boolean;
  search?: (query: string, limit: number, signal?: AbortSignal) => Promise<SemanticHit[]>;
  timeoutMs?: number;
};

// Purely injectable boundary used by Diana and the no-network/no-DB regression script.
export async function safeSemanticProductSkus(query: string, limit: number, deps: SemanticDeps = {}): Promise<SemanticHit[]> {
  const raw = query.trim();
  if (raw.length < 2 || looksLikeSku(raw) || !(deps.available ?? embeddingsAvailable)()) return [];
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? 2_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('semantic search timed out'));
      }, timeoutMs);
    });
    return await Promise.race([
      (deps.search ?? semanticProductSkus)(raw.slice(0, 200), limit, controller.signal),
      timeout,
    ]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function mergeProductSkus(keywordSkus: string[], semanticSkus: string[], limit: number): string[] {
  const merged = [...keywordSkus];
  const seen = new Set(keywordSkus);
  for (const sku of semanticSkus) {
    if (!seen.has(sku) && merged.length < limit) {
      seen.add(sku);
      merged.push(sku);
    }
  }
  return merged;
}
