// Offline proof of the Mercury Phase-3 buy→stock loop (cloud side) — NO database, NO network.
// Run: npx tsx src/scripts/verify-mercury-receive.ts
//
// It monkeypatches the shared prisma singleton with a tiny in-memory fake, then proves:
//   (a) ORDINARY receive → adjustStock bumps Product.stock by the received qty AND writes ONE
//       StockAdjustment audit row with the Mercury goods-receipt reason.
//   (b) Vesta's OWN /adjust path (setStock with an absolute toQty) produces the IDENTICAL write +
//       audit shape — the refactor didn't change Vesta's behavior.
//   (c) The two writers share ONE code path: both go through the same product.update(stock,stockAt)
//       + stockAdjustment.create({sku,fromQty,toQty,reason,byAgentId}) transaction.
//
// The SECRET-side receipt (realSku bump from local-Mercury) is proven in mercury-local's
// verify-loop.ts (this file covers the shared api write path + ordinary receive).
import { prisma } from '../db/prisma.js';
import { setStock, adjustStock } from '../stock/adjust.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── In-memory fake for the exact prisma surface adjust.ts touches. Records the write + audit. ──
interface FakeProduct { sku: string; stock: number | null; stockAt: Date | null }
interface AuditRow { sku: string; fromQty: number | null; toQty: number | null; reason: string; byAgentId: string | null }

function installFake(initial: FakeProduct[]) {
  const products = new Map(initial.map((p) => [p.sku, { ...p }]));
  const audits: AuditRow[] = [];

  // Capture the ops a $transaction([...]) builds, then "commit" them in order.
  const p = prisma as unknown as Record<string, unknown>;
  p.product = {
    findUnique: async ({ where }: { where: { sku: string } }) => {
      const row = products.get(where.sku);
      return row ? { ...row } : null;
    },
    update: ({ where, data }: { where: { sku: string }; data: { stock: number | null; stockAt: Date } }) => ({
      __op: 'product.update' as const,
      run: () => {
        const row = products.get(where.sku)!;
        row.stock = data.stock;
        row.stockAt = data.stockAt;
        return { ...row, nameEn: '', nameTh: '', price: 0, photoSku: null, reorderPoint: null };
      },
    }),
  };
  p.stockAdjustment = {
    create: ({ data }: { data: AuditRow }) => ({
      __op: 'stockAdjustment.create' as const,
      run: () => {
        audits.push({ ...data });
        return { id: 'audit-' + audits.length, at: new Date(), ...data };
      },
    }),
  };
  p.$transaction = async (ops: { run: () => unknown }[]) => ops.map((o) => o.run());

  return { products, audits };
}

async function main(): Promise<void> {
  console.log('mercury cloud receive — offline proof (in-memory fake prisma, no DB)\n');

  // ── (a) ORDINARY receive: adjustStock(+qty) bumps stock + writes one audit row ──────────────
  console.log('(a) ORDINARY goods-receipt via adjustStock (the cloud receive endpoint path):');
  {
    const { products, audits } = installFake([{ sku: '07-10-09', stock: 3, stockAt: null }]);
    const res = await adjustStock({
      sku: '07-10-09',
      delta: 5,
      reason: 'Mercury goods-receipt: request req_123',
      agentId: 'agent_supervisor',
    });
    check('adjust ok', res.ok === true);
    check('stock bumped 3 → 8 (delta +5)', products.get('07-10-09')?.stock === 8, `now ${products.get('07-10-09')?.stock}`);
    check('stockAt stamped', products.get('07-10-09')?.stockAt instanceof Date);
    check('exactly ONE audit row written', audits.length === 1, `${audits.length} rows`);
    check('audit fromQty=3 toQty=8', audits[0]?.fromQty === 3 && audits[0]?.toQty === 8);
    check('audit reason = Mercury goods-receipt', audits[0]?.reason === 'Mercury goods-receipt: request req_123');
    check('audit byAgentId carried', audits[0]?.byAgentId === 'agent_supervisor');
  }

  // Unknown stock (null) → receiving N yields N (starts from 0).
  console.log('\n    ORDINARY receive into UNKNOWN stock (null → starts at 0):');
  {
    const { products, audits } = installFake([{ sku: '01-02-03', stock: null, stockAt: null }]);
    const res = await adjustStock({ sku: '01-02-03', delta: 4, reason: 'Mercury goods-receipt: request r2' });
    check('adjust ok', res.ok === true);
    check('null + 4 → 4', products.get('01-02-03')?.stock === 4, `now ${products.get('01-02-03')?.stock}`);
    check('one audit row, fromQty=null toQty=4', audits.length === 1 && audits[0]?.fromQty === null && audits[0]?.toQty === 4);
  }

  // Unknown SKU is rejected (never creates a catalog row).
  console.log('\n    ORDINARY receive of an UNKNOWN SKU is rejected:');
  {
    installFake([{ sku: '07-10-09', stock: 3, stockAt: null }]);
    const res = await adjustStock({ sku: '99-99-99', delta: 5, reason: 'x' });
    check('unknown_sku error', res.ok === false && res.error === 'unknown_sku');
  }

  // ── (b) Vesta's OWN /adjust path (setStock absolute toQty) — identical write + audit shape ──
  console.log("\n(b) Vesta's own /adjust path via setStock (absolute toQty) — identical shape:");
  {
    const { products, audits } = installFake([{ sku: '07-10-09', stock: 10, stockAt: null }]);
    const res = await setStock({ sku: '07-10-09', toQty: 7, reason: 'manual count', agentId: 'agent_dr_m' });
    check('setStock ok', res.ok === true);
    check('stock set to absolute 7', products.get('07-10-09')?.stock === 7);
    check('stockAt stamped', products.get('07-10-09')?.stockAt instanceof Date);
    check('exactly ONE audit row (same shape)', audits.length === 1);
    check('audit fromQty=10 toQty=7 reason carried', audits[0]?.fromQty === 10 && audits[0]?.toQty === 7 && audits[0]?.reason === 'manual count');
    check('audit byAgentId carried', audits[0]?.byAgentId === 'agent_dr_m');
  }

  // No-op (stock already at target) skips the write + audit (both callers).
  console.log('\n    No-op (already at target) writes NO audit row:');
  {
    const { audits } = installFake([{ sku: '07-10-09', stock: 5, stockAt: null }]);
    const res = await setStock({ sku: '07-10-09', toQty: 5, reason: 'x' });
    check('unchanged flagged', res.ok === true && (res as { unchanged?: boolean }).unchanged === true);
    check('no audit row on no-op', audits.length === 0);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — no DB, no network used.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-mercury-receive crashed:', e);
  process.exit(1);
});
