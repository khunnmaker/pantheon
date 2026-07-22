import { normalizeBillReference } from './receiptReferences.js';

// Normalization shared by the bank-first RE/payment search route and its tests.
// Stored RE numbers are bare seven-digit cores; FIN commonly types RE-, spaces, or dashes.
export function reSearchCore(value: string): string | null {
  const core = value.trim().replace(/^re[\s-]*/i, '').replace(/[\s-]/g, '');
  return /^\d{2,7}$/.test(core) ? core : null;
}

// Stored billNos use the shared receipt-reference canonical form. This accepts the same
// spaces/dashes and optional MB prefix as the verify dialog, including XS references.
export function billSearchReference(value: string): string | null {
  return normalizeBillReference(value)?.value ?? null;
}

export function searchedAmount(value: string): number | null {
  const normalized = value.trim().replace(/[฿,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

// Keep the same "near amount" band used by the existing bank suggestions.
export function nearAmountTolerance(amount: number): number {
  return Math.max(1, amount * 0.02);
}

// Bank exports and staff searches may format the same cheque number with spaces, dashes,
// labels, and leading zeroes. Match on the significant digits only, like the auto-matcher.
export function chequeSearchDigits(value: string): string | null {
  const digits = value.replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

// Keep the receipt-first bank-line search's business ranking explicit and unit-testable.
export function bankTxnSearchTier(matches: {
  exactAmount: boolean;
  cheque: boolean;
  text: boolean;
  nearAmount: boolean;
}): number {
  if (matches.exactAmount) return 4;
  if (matches.cheque) return 3;
  if (matches.text) return 2;
  if (matches.nearAmount) return 1;
  return 0;
}
