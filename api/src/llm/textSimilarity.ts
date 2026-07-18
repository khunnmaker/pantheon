const MAX_COMPARE_CHARS = 4000;

// Mechanical normalization only: spacing, punctuation, emoji, and invisible formatting.
// Thai politeness particles and all other wording remain meaningful.
export function normalizeForSimilarity(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[\p{Extended_Pictographic}\uFE0E\uFE0F]/gu, '')
    .replace(/\p{P}+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_COMPARE_CHARS);
}

// Character-level Levenshtein similarity in [0, 1]. Uses two rows to keep memory bounded.
export function textSimilarity(left: string, right: string): number {
  const a = Array.from(normalizeForSimilarity(left));
  const b = Array.from(normalizeForSimilarity(right));
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join('') === b.join('')) return 1;

  let prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return Math.max(0, Math.min(1, 1 - prev[b.length] / Math.max(a.length, b.length)));
}
