import { prisma } from './prisma.js';
import { CATALOG_PRODUCTS } from '../catalog/catalogData.js';

// Seed the Product catalog on boot when the table is empty (fresh cloud deploy),
// mirroring ensureSeeded. Never clobbers an existing catalog — refresh after data
// fixes goes through POST /api/catalog/reimport (supervisor-only).
export async function ensureCatalog(): Promise<void> {
  try {
    if ((await prisma.product.count()) > 0) return;
    const data = CATALOG_PRODUCTS.map((p) => ({
      sku: p.sku,
      nameEn: p.nameEn,
      nameTh: p.nameTh,
      price: p.price,
      promo: p.promo,
      note: p.note,
      page: p.page ?? null,
      photoSku: p.photoSku ?? null,
      keywords: p.keywords,
    }));
    const res = await prisma.product.createMany({ data, skipDuplicates: true });
    // eslint-disable-next-line no-console
    console.log(`[catalog] imported ${res.count} products`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog] ensureCatalog failed', err);
  }
}
