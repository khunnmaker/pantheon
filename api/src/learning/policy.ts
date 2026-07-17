// Product prices and promotional amounts are owned by the live catalog, never the learned KB.
// Keep this deliberately mechanical: if monetary content survives distillation, a human must
// remove it before promotion. Policy fees are intentionally not whitelisted.
export const PRICE_CONTENT_RE = /\d[\d,.]*\s*บาท|฿\s*\d/u;

export function hasPriceContent(text: string): boolean {
  return PRICE_CONTENT_RE.test(text);
}
