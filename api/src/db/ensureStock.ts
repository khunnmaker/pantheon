import { prisma } from './prisma.js';
import { STOCK, STOCK_AT } from '../catalog/stockData.js';

// Apply the embedded stock snapshot to Product.stock — once per snapshot date. This
// seeder only bootstraps an empty/fresh database: it permanently defers to Vesta
// (routes/stock.ts) once a single Vesta import has ever happened. Idempotent within
// that bootstrap window: if any product already carries this snapshot's date, skip.
// Availability only — the AI states in/out qualitatively; the console shows staff the
// exact count + date.
export async function ensureStock(): Promise<void> {
  // Vesta (routes/stock.ts) owns stock now. Once ANY Vesta import exists, this
  // legacy seeder must never write again — without this gate, a redeploy after an
  // import restamps every stockAt would re-apply the stale embedded snapshot.
  if ((await prisma.stockImport.count()) > 0) return;

  const at = new Date(`${STOCK_AT}T00:00:00Z`);
  const already = await prisma.product.count({ where: { stockAt: at } });
  if (already > 0) return;

  const entries = Object.entries(STOCK);
  let applied = 0;
  // Chunk the per-SKU updates so a 1000+ snapshot doesn't serialize the whole boot.
  const CHUNK = 50;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const results = await Promise.all(
      slice.map(([sku, qty]) =>
        prisma.product.updateMany({ where: { sku }, data: { stock: qty, stockAt: at } }),
      ),
    );
    applied += results.reduce((n, r) => n + r.count, 0);
  }
  console.log(`[ensureStock] applied snapshot ${STOCK_AT} to ${applied}/${entries.length} products`);
}
