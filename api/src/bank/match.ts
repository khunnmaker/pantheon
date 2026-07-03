// Matching helpers shared by the auto-matcher (POST /bank/import/apply, /bank/automatch)
// and the suggestions endpoint (GET /bank/txns/:id/suggestions). See
// JUNO_PROCESS_BRIEF.md PHASE B / B3.

const DAY_MS = 24 * 3600 * 1000;

// Payment.transferAt is stored "DD/MM/YYYY HH:MM" (Gregorian — see finance/normalize.ts
// normalizeSlipDate), but can be blank, or left as unparseable raw OCR text when the LLM's
// output didn't match either expected shape. Falls back to createdAt in both cases, per spec.
export function paymentTimestamp(transferAt: string, createdAt: Date): Date {
  const m = transferAt.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const [, dd, mm, yyyy, hh, min] = m;
    const d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${min}:00+07:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return createdAt;
}

// 2dp-normalized numeric compare so "1234.5" and "1234.50" (both valid house-String
// amounts) are treated as equal, and floating point never causes a false mismatch.
export function amountsEqual(a: string, b: string): boolean {
  const na = Math.round(parseFloat(a || '0') * 100);
  const nb = Math.round(parseFloat(b || '0') * 100);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

export function dayDistance(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / DAY_MS;
}

// Casefolded substring / token-overlap name similarity — a soft signal for ranking
// suggestions (never used to auto-link; only the unambiguous-exact-amount rule does that).
// Handles both a bank Details "PAYER NAME" style string and a plain customer name.
export function nameSimilarity(bankSide: string, paymentSide: string): number {
  const a = bankSide.trim().toLowerCase();
  const b = paymentSide.trim().toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;

  const tokenize = (s: string) => s.split(/[\s.,]+/).filter((t) => t.length >= 2);
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size); // Jaccard-ish, 0..1 (rewards proportional overlap over sheer token count)
}
