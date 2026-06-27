import type { Product } from '@prisma/client';
import { prisma } from '../db/prisma.js';

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
  const learned = await prisma.productKeyword.findMany({ where: { keyword: { in: tokens } } });
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

// Manual product search for the console — matches by NAME (token overlap) OR SKU
// (substring). Used when the AI's auto-match isn't what the team wants. SKU matches
// rank first; returns more results than findProducts.
export async function searchProducts(query: string, limit = 12): Promise<ProductMatch[]> {
  const raw = (query || '').trim();
  if (!raw) return [];
  const tokens = questionKeywords(raw);
  const skuLike = raw.replace(/\s+/g, '');
  // A pure digits/dashes query is a SKU lookup → match SKU only (skip name-token noise).
  const isSkuQuery = /^[\d-]+$/.test(skuLike);

  const candidates = await prisma.product.findMany({
    where: {
      status: 'active',
      OR: [
        { sku: { contains: skuLike, mode: 'insensitive' as const } },
        ...(isSkuQuery
          ? []
          : tokens.flatMap((t) => [
              { nameEn: { contains: t, mode: 'insensitive' as const } },
              { nameTh: { contains: t } },
              { keywords: { has: t } },
            ])),
      ],
    },
    take: 80,
  });

  const skuLc = skuLike.toLowerCase();
  const score = (p: Product) => {
    let s = 0;
    if (skuLc && p.sku.toLowerCase().includes(skuLc)) s += 5;
    const hay = `${p.nameEn} ${p.nameTh} ${p.keywords.join(' ')}`.toLowerCase();
    for (const t of tokens) if (hay.includes(t)) s++;
    return s;
  };

  return candidates
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(!!b.p.photoSku) - Number(!!a.p.photoSku))
    .slice(0, limit)
    .map(({ p }) => toProductMatch(p));
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
