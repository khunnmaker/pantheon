import type { Product } from '@prisma/client';

// A SKU is "low" only when it has BOTH a known stock level and a reorder point,
// and the stock has fallen to/below it. No reorderPoint set ⇒ no threshold ⇒ not low.
// Stock unknown (null) ⇒ not low (we don't guess). Mirrors VULCAN_BRIEF §8.
export function isLow(stock: number | null, reorderPoint: number | null): boolean {
  return stock != null && reorderPoint != null && stock <= reorderPoint;
}

export interface StockRow {
  sku: string;
  nameEn: string;
  nameTh: string;
  price: number;
  photoSku: string | null;
  stock: number | null;
  stockAt: string | null; // ISO; null = unknown
  reorderPoint: number | null;
  low: boolean;
  // Short human code (e.g. "TR34"); filled by the /api/stock/list route, not toStockRow.
  alias?: string | null;
}

export function toStockRow(p: Product): StockRow {
  return {
    sku: p.sku,
    nameEn: p.nameEn,
    nameTh: p.nameTh,
    price: p.price,
    photoSku: p.photoSku,
    stock: p.stock,
    stockAt: p.stockAt ? p.stockAt.toISOString() : null,
    reorderPoint: p.reorderPoint,
    low: isLow(p.stock, p.reorderPoint),
  };
}
