import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { CATALOG_PRODUCTS } from '../catalog/catalogData.js';

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Quick health/visibility of the imported catalog.
  app.get('/api/catalog/stats', async () => {
    const [total, priced, withPhoto] = await Promise.all([
      prisma.product.count(),
      prisma.product.count({ where: { price: { gt: 0 } } }),
      prisma.product.count({ where: { photoSku: { not: null } } }),
    ]);
    return { total, priced, withPhoto };
  });

  // Supervisor-only: wipe + re-import the bundled catalog (after data fixes /
  // re-extraction). Lets us refresh prices without clobbering on every boot.
  app.post('/api/catalog/reimport', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    await prisma.product.deleteMany({});
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
    return { ok: true, imported: res.count };
  });
}
