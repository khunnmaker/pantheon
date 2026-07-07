import type { Product } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { isLow } from '../stock/helpers.js';

export interface ProductMatch {
  sku: string;
  nameEn: string;
  nameTh: string;
  price: number;
  promo: string;
  note: string;
  photoSku: string | null;
  stock: number | null; // remaining qty from the snapshot (null = unknown)
  stockAt: Date | null;
  reorderPoint?: number | null; // Vulcan low-stock threshold (staff-only)
  low?: boolean; // stock <= reorderPoint (staff-only; never surfaced to customers)
  alias?: string | null; // short human code (e.g. "TR34"); attached by searchProducts
}

// Tokenize a customer query into searchable terms (alnum + Thai, length >= 2).
function tokenize(q: string): string[] {
  const toks = new Set<string>();
  for (const t of (q || '').toLowerCase().split(/[^a-z0-9฀-๿]+/i)) {
    if (t && t.length >= 2) toks.add(t);
  }
  return [...toks];
}

// Generic words that shouldn't drive a product match on their own.
const STOP = new Set([
  'ราคา', 'เท่าไหร่', 'เท่าไร', 'กี่', 'บาท', 'ขอ', 'สอบถาม', 'มีไหม', 'คะ', 'ค่ะ', 'ครับ',
  'ไหม', 'อยาก', 'ได้', 'ตัว', 'อัน', 'นี้', 'นั้น', 'และ', 'หรือ', 'ของ', 'สินค้า', 'ตัวนี้',
  'price', 'cost', 'how', 'much', 'the', 'have', 'for', 'you', 'and', 'this',
]);

function toProductMatch(p: Product): ProductMatch {
  return {
    sku: p.sku,
    nameEn: p.nameEn,
    nameTh: p.nameTh,
    price: p.price,
    promo: p.promo,
    note: p.note,
    photoSku: p.photoSku,
    stock: p.stock,
    stockAt: p.stockAt,
    reorderPoint: p.reorderPoint,
    low: isLow(p.stock, p.reorderPoint),
  };
}

// Significant tokens of a customer question (alnum/Thai, length>=2, minus stop words).
function questionKeywords(text: string): string[] {
  return tokenize(text).filter((t) => !STOP.has(t));
}

// Find catalog products matching a customer's question. Token-overlap ranked, with a
// boost from team-taught keyword→product links (recordProductKeywords). Tokens are
// alnum/Thai only (no SQL LIKE wildcards) so `contains` is injection-safe.
export async function findProducts(query: string, limit = 5): Promise<ProductMatch[]> {
  const tokens = questionKeywords(query);
  if (!tokens.length) return [];

  // Learned associations: products staff manually picked for similar-keyword questions.
  // Trust GATE (anti-poisoning): only links reinforced at least TRUST_MIN_SCORE times count,
  // so a single wrong pick can never surface a product; and only links reinforced within
  // FRESH_DAYS count, so a stale/one-off association decays out instead of poisoning forever.
  const TRUST_MIN_SCORE = 2;
  const FRESH_DAYS = 180;
  const freshCutoff = new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000);
  const learned = await prisma.productKeyword.findMany({
    where: { keyword: { in: tokens }, score: { gte: TRUST_MIN_SCORE }, updatedAt: { gt: freshCutoff } },
  });
  const learnedScore = new Map<string, number>();
  for (const l of learned) learnedScore.set(l.sku, (learnedScore.get(l.sku) ?? 0) + l.score);

  const candidates = await prisma.product.findMany({
    where: {
      status: 'active',
      OR: [
        ...tokens.flatMap((t) => [
          { nameEn: { contains: t, mode: 'insensitive' as const } },
          { nameTh: { contains: t } },
          { keywords: { has: t } },
        ]),
        ...(learnedScore.size ? [{ sku: { in: [...learnedScore.keys()] } }] : []),
      ],
    },
    take: 60,
  });

  const score = (p: Product) => {
    const hay = `${p.nameEn} ${p.nameTh} ${p.keywords.join(' ')}`.toLowerCase();
    let s = 0;
    for (const t of tokens) if (hay.includes(t)) s++;
    s += Math.min(learnedScore.get(p.sku) ?? 0, 4); // learned boost, capped so it can't dominate
    return s;
  };

  return candidates
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0 && (x.p.nameEn || x.p.nameTh)) // skip nameless products (generic-keyword noise)
    .sort((a, b) => b.s - a.s || Number(b.p.price > 0) - Number(a.p.price > 0))
    .slice(0, limit)
    .map(({ p }) => toProductMatch(p));
}

// Manual product search for the console — matches by NAME (token overlap) OR SKU.
// SKU matching is DASH-INSENSITIVE: "071009", "07-10-09", and "0710" all match the
// stored "07-10-09" (codes are entered/shown bare for easy typing; the stored key keeps
// its dashes). SKU matches rank first; returns more results than findProducts.
// statuses: which Product.status values are searchable. Default ['active'] (console + AI never
// see stock-only rows); Vulcan passes ['active','stock_only'] so its own search finds the
// Express-imported stubs it manages.
export async function searchProducts(query: string, limit = 12, statuses: string[] = ['active']): Promise<ProductMatch[]> {
  const raw = (query || '').trim();
  if (!raw) return [];
  const tokens = questionKeywords(raw);
  const compact = raw.replace(/\s+/g, '');
  // The query's SKU text with separators removed, for dash-insensitive matching.
  const skuFlat = raw.replace(/[^0-9a-z]/gi, '').toLowerCase();
  // A pure digits/dashes query is a SKU lookup → match SKU only (skip name-token noise).
  const isSkuQuery = /^[\d-]+$/.test(compact);

  // SKU candidates: compare against the dash-stripped stored code. Prisma can't transform
  // a column inside `contains`, so the SKU lookup is raw SQL.
  let skuHits: string[] = [];
  if (skuFlat.length >= 2) {
    const rows = await prisma.$queryRaw<{ sku: string }[]>`
      SELECT sku FROM "Product"
      WHERE status IN (${Prisma.join(statuses)}) AND replace(lower(sku), '-', '') LIKE ${`%${skuFlat}%`}
      LIMIT 80`;
    skuHits = rows.map((r) => r.sku);
  }

  // Alias candidates: typing a short code like "TR34" (exact) or "TR" (browse the family)
  // resolves via ProductAlias. Only run when the query carries a letter (aliases are alpha-
  // prefixed), so a pure-digit SKU query stays SKU-only.
  const aliasQuery = compact.toUpperCase();
  const aliasBySku = new Map<string, string>();
  if (aliasQuery.length >= 2 && /[A-Z]/.test(aliasQuery)) {
    const aliasRows = await prisma.productAlias.findMany({
      where: { alias: { startsWith: aliasQuery } },
      select: { sku: true, alias: true },
      take: 80,
    });
    for (const r of aliasRows) aliasBySku.set(r.sku, r.alias);
  }

  const or = [
    ...(skuHits.length ? [{ sku: { in: skuHits } }] : []),
    ...(aliasBySku.size ? [{ sku: { in: [...aliasBySku.keys()] } }] : []),
    ...(isSkuQuery
      ? []
      : tokens.flatMap((t) => [
          { nameEn: { contains: t, mode: 'insensitive' as const } },
          { nameTh: { contains: t } },
          { keywords: { has: t } },
        ])),
  ];
  if (or.length === 0) return []; // no SKU/alias hit and no usable tokens

  const candidates = await prisma.product.findMany({
    where: { status: { in: statuses }, OR: or },
    take: 80,
  });

  const score = (p: Product) => {
    let s = 0;
    if (skuFlat && p.sku.replace(/-/g, '').toLowerCase().includes(skuFlat)) s += 5;
    const al = aliasBySku.get(p.sku);
    if (al) s += al === aliasQuery ? 12 : 6; // exact alias beats a partial SKU/prefix hit
    const hay = `${p.nameEn} ${p.nameTh} ${p.keywords.join(' ')}`.toLowerCase();
    for (const t of tokens) if (hay.includes(t)) s++;
    return s;
  };

  const ranked = candidates
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(!!b.p.photoSku) - Number(!!a.p.photoSku))
    .slice(0, limit)
    .map(({ p }) => toProductMatch(p));

  // Attach aliases for the final result SKUs (one query) so callers can display them.
  if (ranked.length) {
    const aliases = await prisma.productAlias.findMany({
      where: { sku: { in: ranked.map((r) => r.sku) } },
      select: { sku: true, alias: true },
    });
    const byId = new Map(aliases.map((a) => [a.sku, a.alias]));
    for (const r of ranked) r.alias = byId.get(r.sku) ?? null;
  }
  return ranked;
}

// Learning: strengthen a customer question's keywords against a product the team chose
// as the MAIN answer, so findProducts surfaces it for similar questions next time.
export async function recordProductKeywords(sku: string, questionText: string): Promise<void> {
  const keywords = [...new Set(questionKeywords(questionText))].slice(0, 8);
  for (const keyword of keywords) {
    await prisma.productKeyword.upsert({
      where: { sku_keyword: { sku, keyword } },
      update: { score: { increment: 1 } },
      create: { sku, keyword, score: 1 },
    });
  }
}
