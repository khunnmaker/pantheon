// Normalize slip fields to ONE consistent form for the finance sheet, regardless of how
// the bank/app printed them (ISO vs DD/MM/YYYY, Buddhist พ.ศ. vs Gregorian ค.ศ., Thai digits).

// → "DD/MM/YYYY HH:MM" with a Gregorian year (Buddhist years ≥2500 get −543).
export function normalizeSlipDate(input: string): string {
  if (!input) return '';
  const t = input.replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)));
  const timeM = t.match(/(\d{1,2}):(\d{2})/);
  const time = timeM ? `${timeM[1].padStart(2, '0')}:${timeM[2]}` : '';

  let day = '';
  let mon = '';
  let year = '';
  let m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); // YYYY-MM-DD (ISO)
  if (m) {
    [, year, mon, day] = m;
  } else {
    m = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/); // DD/MM/YYYY or DD/MM/YY
    if (m) [, day, mon, year] = m;
  }
  if (!day || !mon || !year) return input; // unparseable → leave as-is

  let y = parseInt(year, 10);
  if (year.length <= 2) y = y >= 50 ? 2500 + y : 2000 + y; // 2-digit: ≥50 = พ.ศ. 25xx, else ค.ศ. 20xx
  if (y >= 2500) y -= 543; // Buddhist → Gregorian
  return `${day.padStart(2, '0')}/${mon.padStart(2, '0')}/${y}${time ? ` ${time}` : ''}`;
}

export interface ResolvedSlipTransferAt {
  value: string;
  fromSlip: boolean;
}

// Prefer the timestamp OCR read from INSIDE the bank slip. The LINE message timestamp is only
// a last-resort prefill when OCR returned a genuinely blank value; callers must retain
// `fromSlip` so that fallback value stays editable rather than being mistaken for locked OCR.
export function resolveSlipTransferAt(
  ocrTransferAt: string,
  lineArrivedAt: Date,
): ResolvedSlipTransferAt {
  const normalized = normalizeSlipDate(ocrTransferAt.trim());
  if (normalized) return { value: normalized, fromSlip: true };

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(lineArrivedAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    value: `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`,
    fromSlip: false,
  };
}

// → a plain 2-decimal number string (strip ฿, commas, spaces). "1,500" → "1500.00".
export function normalizeAmount(input: string): string {
  const cleaned = (input || '').replace(/[^\d.]/g, '');
  if (!cleaned) return '';
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? cleaned : n.toFixed(2);
}
