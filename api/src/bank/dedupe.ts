import { createHash } from 'node:crypto';
import type { BankSource } from './types.js';

// dedupeKey = sha256("source|txnAt ISO|amount|details"). The owner's Wed/Sat exports
// overlap by design (a Wed export can re-include Monday's rows) — re-importing the same
// bank line must be a no-op (counted as `dup`), not a duplicate row. When two DISTINCT
// transactions within the SAME import genuinely hash identical (a same-second Details
// coincidence — rare but not impossible, e.g. two K PLUS rows sharing a terminal id), a
// "|n" suffix disambiguates them so neither is silently dropped; see makeUniqueDedupeKeys.
export function computeDedupeKey(source: BankSource, txnAt: Date, amount: string, details: string): string {
  return createHash('sha256').update(`${source}|${txnAt.toISOString()}|${amount}|${details}`).digest('hex');
}

// Applies computeDedupeKey across a batch from ONE file, appending "|n" (n = 2, 3, ...)
// on any within-file collision so every row in the returned array has a unique key. Order
// is preserved 1:1 with the input.
export function makeUniqueDedupeKeys(
  rows: { source: BankSource; txnAt: Date; amount: string; details: string }[],
): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = computeDedupeKey(r.source, r.txnAt, r.amount, r.details);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}|${n}`;
  });
}
