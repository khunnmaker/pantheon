import 'dotenv/config';
import { prisma } from '../db/prisma.js';
import { deriveBrand, deriveCategory } from '../db/ensureEnrichment.js';

// Re-derive brand + category for the public catalog on demand, using the shared
// rules in db/ensureEnrichment.ts. Unlike the boot-time seeder (which only runs on
// an empty table), this re-runs anytime and SKIPS staff-edited rows (source='manual'),
// then prints a breakdown.
//
//   Run:  npx tsx src/scripts/deriveEnrichment.ts

async function main() {
  const products = await prisma.product.findMany({ select: { sku: true, nameEn: true, nameTh: true, keywords: true } });
  const manual = new Set(
    (await prisma.productEnrichment.findMany({ where: { source: 'manual' }, select: { sku: true } })).map((e) => e.sku),
  );

  let withBrand = 0;
  let withCat = 0;
  let written = 0;
  let skipped = 0;
  const catCounts = new Map<string, number>();

  for (const p of products) {
    if (manual.has(p.sku)) { skipped++; continue; }
    const text = `${p.nameTh} ${p.nameEn} ${p.keywords.join(' ')}`;
    const brand = deriveBrand(text);
    const cat = deriveCategory(text);
    if (brand) withBrand++;
    if (cat.th) { withCat++; catCounts.set(cat.th, (catCounts.get(cat.th) ?? 0) + 1); }

    await prisma.productEnrichment.upsert({
      where: { sku: p.sku },
      update: { brand, category: cat.th, categoryEn: cat.en, source: 'derived' },
      create: { sku: p.sku, brand, category: cat.th, categoryEn: cat.en, source: 'derived' },
    });
    written++;
  }

  // eslint-disable-next-line no-console
  console.log(`[enrich] ${written} written, ${skipped} manual skipped | brand: ${withBrand}, category: ${withCat} of ${products.length}`);
  // eslint-disable-next-line no-console
  console.log('[enrich] category breakdown:');
  for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    // eslint-disable-next-line no-console
    console.log(`  ${n.toString().padStart(4)}  ${c}`);
  }
  await prisma.$disconnect();
}

void main();
