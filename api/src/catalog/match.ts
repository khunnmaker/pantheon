import { prisma } from '../db/prisma.js';

export interface ProductMatch {
  sku: string;
  nameEn: string;
  nameTh: string;
  price: number;
  promo: string;
  note: string;
  photoSku: string | null;
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

// Find catalog products matching a customer's question. Token-overlap ranked.
// Tokens are alnum/Thai only (no SQL LIKE wildcards) so `contains` is injection-safe.
export async function findProducts(query: string, limit = 5): Promise<ProductMatch[]> {
  const tokens = tokenize(query).filter((t) => !STOP.has(t));
  if (!tokens.length) return [];

  const candidates = await prisma.product.findMany({
    where: {
      status: 'active',
      OR: tokens.flatMap((t) => [
        { nameEn: { contains: t, mode: 'insensitive' as const } },
        { nameTh: { contains: t } },
        { keywords: { has: t } },
      ]),
    },
    take: 60,
  });

  const score = (p: (typeof candidates)[number]) => {
    const hay = `${p.nameEn} ${p.nameTh} ${p.keywords.join(' ')}`.toLowerCase();
    let s = 0;
    for (const t of tokens) if (hay.includes(t)) s++;
    return s;
  };

  return candidates
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(b.p.price > 0) - Number(a.p.price > 0))
    .slice(0, limit)
    .map(({ p }) => ({
      sku: p.sku,
      nameEn: p.nameEn,
      nameTh: p.nameTh,
      price: p.price,
      promo: p.promo,
      note: p.note,
      photoSku: p.photoSku,
    }));
}
