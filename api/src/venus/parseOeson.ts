import { decodeExpressBytes } from '../stock/parseExpressReport.js';

// Parser for Prominent's Express SALES ORDER report ("OESON" / "รายงานใบสั่งขาย เรียงตาม
// เลขที่"). Like parseArmast/parseExpressReport, this is NOT a CSV — it's a fixed-width
// printer report exported as .txt, encoded Windows-874 (win874). Verified against the real
// 31 MB export: 28,780 doc headers (70 marked void with a leading "*"), 185,116 line
// items, 3,097 distinct SKUs, date span Jan 2025 - Jul 2026. Doc-number prefixes: SO
// (28,240), RG (536), BO (4) - stored as docType.
//
// Page furniture (banner, ESC W-bracketed title, the two filter lines, dashed separators,
// the two column-header rows) repeats every ~40 lines and — critically — CAN LAND
// MID-DOCUMENT: a big multi-page order's line items are interrupted by a full page-header
// block right in the middle (verified on SO6800053, a 99-line order spanning pages 92-95).
// Same fix as parseArmast: strip ALL furniture from the line stream FIRST, then associate
// line-items with the most recently seen doc header from the CLEANED stream.
//
// CUSTOMER NAME CAVEAT (same shape as ARMAST): the name field is truncated at roughly 30
// DISPLAY columns and Thai vowel/tone marks are separate bytes, so the field is
// positionally UNSTABLE. Long names run straight into (and sometimes swallow) the
// salesperson/rep-code column with no separating whitespace — verified e.g. doc RG6800364
// ("...จำกัด(สาขาสถานC1ัน ร้าน") where the rep code "C1" is embedded inside the name and
// the delivery-date column fails to separate at all (~5,355 / 28,780 docs show a null
// deliveryDate for this reason). We capture customerNameRaw BEST-EFFORT only — it is NOT a
// reliable join key. The real customer join key (Express รหัสลูกค้า) will come from a
// follow-up export; do NOT attempt fuzzy name-to-customer matching here. The rep code is
// ASCII-ish (แลป / C1-C9 / ยร / two-digit codes / blank) and more stable, but still fails
// silently (comes back null, swallowed into the name) in the same long-name cases.
//
// Doc header, fields in fixed order (see DOC_RE): void flag, docNo, order date, customer
// name (best-effort, see above), rep code, delivery date (optional — see above), credit
// days, V discount flag, an OPTIONAL header-level ส่วนลด (discount) amount (only present
// on ~4 real docs, e.g. SO6801536 "โปรโมชั่น100ตัว"), มูลค่าสินค้า (goods value, ex-VAT),
// VAT, รวมทั้งสิ้น (grand total, VAT-inclusive), ส่งหมด (Y/N delivered), อ้างอิง
// (free-text reference — may itself contain a literal "*" as part of the text, e.g.
// "NO.9415650*คืนแล้ว", so the void flag is only ever read from the LEADING "*").
//
// Line item, fields in fixed order (see LINE_RE): lineNo, sku (NN-NN-NNN..., variable
// trailing-digit width), name, then qty+unit glued together with no separator (e.g.
// "1.00ชิ้น", "3.00ตัว", "2.00each" — unit can be Thai or ASCII, split via QTY_UNIT_RE),
// then a tail that holds 0, 2, or 3 more decimal numbers:
//   0 numbers -> unitPrice/discount/amount all blank (warranty / in-guarantee lines,
//                confirmed ~7,505 / 185,116 real lines) - kept, never dropped.
//   2 numbers -> unitPrice, amount (the common case, ~177,605 / 185,116 lines).
//   3 numbers -> unitPrice, a per-line ส่วนลด (discount), amount (~6 real lines).
// Amount is VAT-inclusive; sum of a doc's line amounts is compared against the doc's
// รวมทั้งสิ้น for self-certification (see selfCertify below) — mismatches are common on
// large multi-page orders with an un-itemized bulk discount (verified e.g. SO6800053: 99
// lines at a flat unit price sum to less than the doc's ex-VAT goods value) and are
// FLAGGED, never used to silently adjust or drop data.
//
// Indented free text under a line, or a "หมายเหตุ:" block, are notes attached to the doc
// (not parsed as line-items and not attached to a specific line, since the report gives no
// stable way to tell which line a stray dash-note belongs to when several lines precede
// it).

export interface ParsedOesonLine {
  lineNo: number;
  sku: string;
  name: string;
  qty: number;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
}

export interface ParsedOesonDoc {
  docNo: string;
  docType: string;
  date: Date | null;
  void: boolean;
  customerNameRaw: string;
  repCode: string | null;
  deliveryDate: Date | null;
  creditDays: number | null;
  discount: number | null;
  goodsValue: number;
  vat: number;
  total: number;
  delivered: boolean | null;
  reference: string | null;
  notes: string[];
  lines: ParsedOesonLine[];
}

export interface SelfCertifyMismatch {
  docNo: string;
  total: number;
  lineSum: number;
  diff: number;
}

export interface ParseOesonResult {
  docs: ParsedOesonDoc[];
  lineItems: number;
  voids: number;
  distinctSkus: number;
  dateSpan: { min: Date | null; max: Date | null };
  selfCertify: {
    checked: number;
    ok: number;
    matchRate: number;
    mismatches: SelfCertifyMismatch[];
  };
  unresolved: number;
  unresolvedSamples: string[];
}

// Doc header line. Groups:
//  1 void flag ("*" or "")            8  V discount flag (0/1, may be blank)
//  2 docNo (e.g. SO6800001)           9  optional header-level ส่วนลด amount
//  3 order date (dd/mm/yy)           10  มูลค่าสินค้า (goods value)
//  4 customer name (best-effort)     11  VAT
//  5 rep code (best-effort)          12  รวมทั้งสิ้น (total)
//  6 delivery date (optional)        13  ส่งหมด (Y/N)
//  7 credit days (may be blank)      14  อ้างอิง (free-text reference, rest of line)
const DOC_RE =
  /^\s{0,4}(\*?)\s*([A-Z]{2}\d{7})\s+(\d{2}\/\d{2}\/\d{2})\s+(.*?)\s{2,}(\S*)\s+(\d{2}\/\d{2}\/\d{2})?\s*(\d*)\s+(\d*)\s+(?:(-?[\d,]+\.\d{2})\s+)?(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+([YN])\s*(.*)$/;
// Cheap pre-filter so we don't run the full DOC_RE against every line.
const DOC_CANDIDATE_RE = /^\s{0,4}\*?\s*[A-Z]{2}\d{7}\s+\d{2}\/\d{2}\/\d{2}/;

// Line-item line. Groups: 1 lineNo, 2 sku, 3 name, 4 qty (glued to unit), 5 unit, 6 tail
// (0, 2, or 3 trailing decimal numbers: unitPrice[, discount], amount).
const LINE_RE =
  /^\s+(\d+)\s+(\d{2}-\d{2}-\d+)\s+(.*?)\s{2,}(-?[\d,]+\.\d{2})([A-Za-zก-๛]+)\s*(.*)$/;
const LINE_CANDIDATE_RE = /^\s+\d+\s+\d{2}-\d{2}-\d+\s+/;

const NOTE_HEADER_RE = /^\s*หมายเหตุ\s*:?\s*$/;

function isPageJunk(line: string): boolean {
  const t = line.replace(/^\f/, '');
  const s = t.trim();
  if (s === '') return true;
  if (t.includes('บริษัท พรอมมิเน้นท์')) return true;
  if (t.includes('รายงานใบสั่งขาย')) return true;
  if (t.startsWith('วันที่จาก')) return true;
  if (t.startsWith('เลขที่จาก')) return true;
  if (t.startsWith('รหัสลูกค้าจาก')) return true;
  if (t.startsWith('พนักงานขายจาก')) return true;
  if (/^-{10,}$/.test(s)) return true;
  if (t.includes('เลขที่') && t.includes('ลูกค้า') && t.includes('พนักงานขาย')) return true;
  if (t.includes('รายละเอียด') && t.includes('จำนวน') && t.includes('ราคาต่อหน่วย')) return true;
  return false;
}

// Strip Express's ESC/P control sequences. Same shapes as parseArmast's stripEsc: a lone
// ESC 'W' <1 byte> toggles printer mode around the report title; any other lone ESC+letter
// is dropped defensively (not seen in this report, but a different export/printer driver
// could emit one).
function stripEsc(line: string): string {
  return line.replace(/\x1bW./g, '').replace(/\x1b./g, '');
}

function parseThaiDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const beYear = Number(m[3]);
  const gregYear = 2500 + beYear - 543;
  const d = new Date(Date.UTC(gregYear, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function parseMoney(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

function parseMoneyOrNull(s: string | undefined | null): number | null {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

export function parseOeson(text: string): ParseOesonResult {
  const rawLines = text.split(/\r?\n/);

  // Pass 1: strip ESC sequences + drop page furniture. Page breaks can land mid-doc, so we
  // strip everything first and reassemble from the cleaned stream — no special-casing.
  const lines: string[] = [];
  for (const raw of rawLines) {
    const stripped = stripEsc(raw);
    if (isPageJunk(stripped)) continue;
    lines.push(stripped.replace(/^\f/, ''));
  }

  const docs: ParsedOesonDoc[] = [];
  const skuSet = new Set<string>();
  let voids = 0;
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  let unresolved = 0;
  const unresolvedSamples: string[] = [];
  const sample = (s: string) => {
    if (unresolvedSamples.length < 10) unresolvedSamples.push(s.trim().slice(0, 160));
  };

  let cur: ParsedOesonDoc | null = null;
  let inNoteBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (DOC_CANDIDATE_RE.test(line)) {
      const m = line.match(DOC_RE);
      if (!m) {
        // Looks like a doc header (docNo + date at the front) but didn't fit the full
        // fixed shape — flag it, never silently drop the line.
        unresolved++;
        sample(line);
        continue;
      }
      inNoteBlock = false;

      const isVoid = m[1] === '*';
      const docNo = m[2];
      const date = parseThaiDate(m[3]);
      const customerNameRaw = m[4].trim();
      const repCode = m[5]?.trim() || null;
      const deliveryDate = parseThaiDate(m[6]);
      const creditDays = m[7] ? Number(m[7]) : null;
      // m[8] is the V discount flag (0/1) — not modeled as a separate field on the doc;
      // callers can infer "has header discount" from `discount !== null`.
      const discount = parseMoneyOrNull(m[9]);
      const goodsValue = parseMoney(m[10]);
      const vat = parseMoney(m[11]);
      const total = parseMoney(m[12]);
      const delivered = m[13] === 'Y' ? true : m[13] === 'N' ? false : null;
      const reference = m[14]?.trim() || null;

      cur = {
        docNo,
        docType: docNo.slice(0, 2),
        date,
        void: isVoid,
        customerNameRaw,
        repCode,
        deliveryDate,
        creditDays: creditDays !== null && !Number.isNaN(creditDays) ? creditDays : null,
        discount,
        goodsValue,
        vat,
        total,
        delivered,
        reference,
        notes: [],
        lines: [],
      };
      docs.push(cur);
      if (isVoid) voids++;
      if (date) {
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
      }
      continue;
    }

    if (LINE_CANDIDATE_RE.test(line)) {
      const m = line.match(LINE_RE);
      if (!m) {
        unresolved++;
        sample(line);
        continue;
      }
      if (!cur) {
        // A line-item with no preceding doc header in the cleaned stream — should not
        // happen against the real file, but flag rather than guess.
        unresolved++;
        sample(line);
        continue;
      }
      inNoteBlock = false;

      const lineNo = Number(m[1]);
      const sku = m[2];
      const name = m[3].trim();
      const qty = parseFloat(m[4].replace(/,/g, ''));
      const unit = m[5];
      const tail = m[6].trim();
      const nums = tail.match(/-?[\d,]+\.\d{2}/g) ?? [];

      let unitPrice: number | null = null;
      let amount: number | null = null;
      if (nums.length === 2) {
        unitPrice = parseMoneyOrNull(nums[0]);
        amount = parseMoneyOrNull(nums[1]);
      } else if (nums.length === 3) {
        // unitPrice, per-line discount (nums[1], not separately modeled), amount
        unitPrice = parseMoneyOrNull(nums[0]);
        amount = parseMoneyOrNull(nums[2]);
      }
      // nums.length === 0: warranty / in-guarantee line — unitPrice/amount stay null,
      // the line is still kept (never dropped).

      skuSet.add(sku);
      cur.lines.push({ lineNo, sku, name, qty, unit, unitPrice, amount });
      continue;
    }

    if (NOTE_HEADER_RE.test(line)) {
      inNoteBlock = true;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '') {
      inNoteBlock = false;
      continue;
    }

    // A non-blank line that's not a doc header, not a line-item, not a note-block opener.
    // Two legitimate shapes: continuation lines inside an open "หมายเหตุ:" block, and
    // indented free-text directly under a line-item (e.g. "-ต่อสาย 1 ตัว"). Both are notes
    // attached to the current doc, not parsed as structured data.
    if (cur) {
      cur.notes.push(trimmed);
      inNoteBlock = inNoteBlock; // stays whatever it was; either shape is a note line
      continue;
    }

    // Stray text with no open doc at all — flag it.
    unresolved++;
    sample(line);
  }

  // Self-certify: compare sum(line amounts) to the doc's รวมทั้งสิ้น within a 2% tolerance
  // (floor of 1 baht to avoid false mismatches on tiny/zero totals). Void docs are excluded
  // from the check (they're cancelled; totals are typically already 0). Mismatches are
  // capped for review but every doc is still kept in `docs` — self-certify never drops data.
  let checked = 0;
  let ok = 0;
  const mismatches: SelfCertifyMismatch[] = [];
  for (const d of docs) {
    if (d.void) continue;
    checked++;
    const lineSum = d.lines.reduce((acc, l) => acc + (l.amount ?? 0), 0);
    const tol = Math.max(1, Math.abs(d.total) * 0.02);
    const diff = lineSum - d.total;
    if (Math.abs(diff) <= tol) {
      ok++;
    } else if (mismatches.length < 200) {
      mismatches.push({ docNo: d.docNo, total: d.total, lineSum, diff });
    }
  }

  const lineItems = docs.reduce((acc, d) => acc + d.lines.length, 0);

  return {
    docs,
    lineItems,
    voids,
    distinctSkus: skuSet.size,
    dateSpan: { min: minDate, max: maxDate },
    selfCertify: {
      checked,
      ok,
      matchRate: checked > 0 ? ok / checked : 1,
      mismatches,
    },
    unresolved,
    unresolvedSamples,
  };
}

export { decodeExpressBytes };
