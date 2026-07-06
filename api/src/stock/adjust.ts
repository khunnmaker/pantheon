// The ONE stock-write path. Vulcan owns Product.stock; every write (Vulcan's manual /adjust
// AND Mercury's goods-receipt) goes through here so there is a single transaction shape and a
// single audit-row shape (StockAdjustment). Do NOT hand-roll a second stock write anywhere —
// import from this module instead. See VULCAN_BRIEF.md + MERCURY_BRIEF.md §7.
import { prisma } from '../db/prisma.js';
import { toStockRow, type StockRow } from './helpers.js';

// A SKU we accept for a stock write (same charset Vulcan's route validates with).
export const SKU_RE = /^[A-Za-z0-9_-]+$/;

export type AdjustError = 'bad_sku' | 'unknown_sku' | 'bad_qty';

export interface AdjustOk {
  ok: true;
  product: StockRow;
  unchanged?: boolean;
}
export interface AdjustFail {
  ok: false;
  error: AdjustError;
}
export type AdjustResult = AdjustOk | AdjustFail;

// Core write: set a SKU's stock to an ABSOLUTE value (toQty=null clears to unknown) + stampedAt,
// and log ONE StockAdjustment audit row — in a single $transaction. This is EXACTLY the write
// Vulcan's POST /api/stock/adjust used before it was factored out; both callers share it verbatim.
// Never creates a catalog row — an unknown SKU is rejected. A no-op (stock already == toQty) skips
// the write and the audit row (returns unchanged:true).
export async function setStock(opts: {
  sku: string;
  toQty: number | null;
  reason: string;
  agentId?: string | null;
}): Promise<AdjustResult> {
  const sku = opts.sku.trim();
  if (!sku || !SKU_RE.test(sku)) return { ok: false, error: 'bad_sku' };
  if (opts.toQty !== null && (!Number.isInteger(opts.toQty) || opts.toQty < 0)) {
    return { ok: false, error: 'bad_qty' };
  }

  const product = await prisma.product.findUnique({ where: { sku } });
  if (!product) return { ok: false, error: 'unknown_sku' };
  if (product.stock === opts.toQty) {
    return { ok: true, product: toStockRow(product), unchanged: true };
  }

  const [updated] = await prisma.$transaction([
    prisma.product.update({
      where: { sku },
      data: { stock: opts.toQty, stockAt: new Date() },
    }),
    prisma.stockAdjustment.create({
      data: {
        sku,
        fromQty: product.stock,
        toQty: opts.toQty,
        reason: opts.reason,
        byAgentId: opts.agentId ?? null,
      },
    }),
  ]);
  return { ok: true, product: toStockRow(updated) };
}

// RELATIVE write: bump a SKU's stock by a signed delta (goods-receipt = positive). Reads the
// current stock, computes the new absolute value, and delegates to setStock so the write + audit
// shape is identical to Vulcan's. A SKU with unknown stock (null) starts from 0 for the receipt
// (receiving N units into an unknown balance yields N). The resulting quantity may not go below 0.
export async function adjustStock(opts: {
  sku: string;
  delta: number;
  reason: string;
  agentId?: string | null;
}): Promise<AdjustResult> {
  const sku = opts.sku.trim();
  if (!sku || !SKU_RE.test(sku)) return { ok: false, error: 'bad_sku' };
  if (!Number.isInteger(opts.delta)) return { ok: false, error: 'bad_qty' };

  const product = await prisma.product.findUnique({ where: { sku }, select: { stock: true } });
  if (!product) return { ok: false, error: 'unknown_sku' };

  const current = product.stock ?? 0;
  const toQty = current + opts.delta;
  if (toQty < 0) return { ok: false, error: 'bad_qty' };

  return setStock({ sku, toQty, reason: opts.reason, agentId: opts.agentId });
}
