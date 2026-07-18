// Matching helpers shared by the auto-matcher (POST /bank/import/apply, /bank/automatch)
// and the suggestions endpoint (GET /bank/txns/:id/suggestions). See
// JUNO_PROCESS_BRIEF.md PHASE B / B3.

const DAY_MS = 24 * 3600 * 1000;

// Payment.transferAt is normally "DD/MM/YYYY HH:MM" Gregorian (see finance/normalize.ts
// normalizeSlipDate), but rows written before the write-path normalization can hold Buddhist
// or 2-digit years — parse those with normalizeSlipDate's year convention rather than trust
// the string. Blank/unparseable raw OCR text falls back to createdAt, per spec.
export function paymentTimestamp(transferAt: string, createdAt: Date): Date {
  const m = transferAt.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const [, dd, mm, year, hh, min] = m;
    let y = parseInt(year, 10);
    if (year.length <= 2) y = y >= 50 ? 2500 + y : 2000 + y;
    if (y >= 2500) y -= 543;
    const d = new Date(`${y}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${min}:00+07:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return createdAt;
}

// Strict counterpart for high-confidence matching: the slip timestamp must contain a real
// calendar date + minute. Unlike paymentTimestamp, this never falls back to createdAt.
export function strictPaymentTimestamp(transferAt: string): Date | null {
  const m = transferAt.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const [, dd, mm, year, hh, min] = m;
  let y = parseInt(year, 10);
  if (year.length <= 2) y = y >= 50 ? 2500 + y : 2000 + y;
  if (y >= 2500) y -= 543;

  const day = parseInt(dd, 10);
  const month = parseInt(mm, 10);
  const hour = parseInt(hh, 10);
  const minute = parseInt(min, 10);
  if (month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const daysInMonth = new Date(Date.UTC(y, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;

  const parsed = new Date(
    `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const BANGKOK_MINUTE_FORMAT = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Calendar-minute identity in Bangkok; seconds and milliseconds are deliberately discarded.
export function bangkokMinuteKey(timestamp: Date): string {
  const parts = Object.fromEntries(
    BANGKOK_MINUTE_FORMAT.formatToParts(timestamp).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
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

export type NameAgreement = 'agree' | 'conflict' | 'unknown';

const THAI_NAME_AFFIXES = [
  'จำกัดมหาชน', 'นางสาว', 'บริษัท', 'คลินิก', 'ร้าน', 'จำกัด', 'บจก', 'หจก', 'บมจ', 'หสม', 'นาย', 'นาง', 'คุณ',
  'ทพญ', 'ดช', 'ดญ', 'ดร', 'ทพ', 'นพ', 'พญ', 'นส',
].sort((a, b) => b.length - a.length);
const LATIN_NAME_AFFIXES = [
  'companylimited', 'coltd', 'limited', 'mister', 'clinic', 'miss', 'mrs', 'inc', 'ltd', 'mr', 'ms', 'dr', 'co',
].sort((a, b) => b.length - a.length);
const NAME_AFFIXES = [...THAI_NAME_AFFIXES, ...LATIN_NAME_AFFIXES].sort((a, b) => b.length - a.length);

export function normalizeNameCore(raw: string): { core: string; script: 'thai' | 'latin' | '' } {
  let core = raw
    .trim()
    .replace(/\+\+\s*$/, '')
    .replace(/\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/[.,\-/'"·]/g, '')
    .replace(/\s/g, '')
    .replace(/\*+/g, '*');

  // WHY: parser names can carry stacked titles/company wrappers on either side. Keep the
  // stripping bounded and refuse to erase short real names that happen to start/end in "co".
  for (let pass = 0; pass < 2; pass++) {
    const prefix = NAME_AFFIXES.find((affix) => core.startsWith(affix) && core.length - affix.length >= 3);
    if (!prefix) break;
    core = core.slice(prefix.length);
  }
  for (let pass = 0; pass < 2; pass++) {
    const suffix = NAME_AFFIXES.find((affix) => core.endsWith(affix) && core.length - affix.length >= 3);
    if (!suffix) break;
    core = core.slice(0, -suffix.length);
  }

  const script = /[฀-๿]/.test(core) ? 'thai' : /[a-z]/.test(core) ? 'latin' : '';
  return { core, script };
}

function pairNameAgreement(
  bank: ReturnType<typeof normalizeNameCore>,
  payment: ReturnType<typeof normalizeNameCore>,
): NameAgreement {
  const bankSolid = bank.core.split('*', 1)[0];
  const paymentSolid = payment.core.split('*', 1)[0];
  if (bankSolid.length < 3 || paymentSolid.length < 3) return 'unknown';
  if (!bank.script || !payment.script || bank.script !== payment.script) return 'unknown';

  if (bank.core.includes('*')) return payment.core.startsWith(bankSolid) ? 'agree' : 'conflict';
  if (payment.core.includes('*')) return bank.core.startsWith(paymentSolid) ? 'agree' : 'conflict';

  const [shorter, longer] = bank.core.length <= payment.core.length
    ? [bank.core, payment.core]
    : [payment.core, bank.core];
  return longer.startsWith(shorter) || (shorter.length >= 4 && longer.includes(shorter))
    ? 'agree'
    : 'conflict';
}

export function nameAgreement(bankName: string, paymentNames: string[]): NameAgreement {
  const bank = normalizeNameCore(bankName);
  let sawConflict = false;
  for (const raw of paymentNames) {
    if (!raw.trim()) continue;
    const verdict = pairNameAgreement(bank, normalizeNameCore(raw));
    if (verdict === 'agree') return 'agree';
    if (verdict === 'conflict') sawConflict = true;
  }
  return sawConflict ? 'conflict' : 'unknown';
}

export function narrowByAgreement(cands: { id: string; agree: boolean }[]): string[] {
  const agreed = cands.filter((cand) => cand.agree);
  return (agreed.length ? agreed : cands).map((cand) => cand.id);
}

// Casefolded substring / token-overlap name similarity — a soft signal for ranking
// suggestions only. The separate strict nameAgreement verdict gates/disambiguates auto-links
// in runAutoMatcher Pass 2; this fuzzy score never does.
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

export function maxNameSimilarity(bankSide: string, paymentNames: string[]): number {
  const scores = paymentNames
    .filter((name) => name.trim())
    .map((name) => nameSimilarity(bankSide, name));
  return scores.length ? Math.max(...scores) : 0;
}
