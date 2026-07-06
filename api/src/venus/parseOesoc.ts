import { decodeExpressBytes } from '../stock/parseExpressReport.js';

// Parser for Prominent's Express SALES ORDER report GROUPED BY CUSTOMER ("OESOC" /
// "รายงานใบสั่งขาย แยกตามลูกค้า"). Sibling of parseOeson.ts (which is grouped by doc
// number and carries a best-effort customer NAME but no code); this report groups by
// customer and gives the real Express customer code — the join key — but does NOT repeat
// the customer name on each doc header. Same fixed-width printer-report shape as
// parseOeson/parseArmast: NOT a CSV, encoded Windows-874 (win874).
//
// Verified against the real 13 MB export: 2,384 distinct customer codes, 11,586 docs (20
// void), 72,604 line items, date span Dec 2025 - Jul 2026 (~8 months). The file's own
// grand-total footer ("รวมทั้งสิ้น 11,586 ใบ") matches doc count exactly.
//
// STRUCTURE (differs from OESON):
//
// Customer group header, bracketed in ESC 'E' ... ESC 'F' (same bracketing ARMAST uses for
// its "ประเภท :" section header): "<name> /<code>" e.g. "กำธร ทันตแพทย์ /ก003". The code
// can contain ASCII digits and letters glued to a Thai prefix (e.g. "ก017A", "ด1551",
// "ต013") - never assume a fixed shape, just "everything after the last '/' up to the
// column of trailing spaces". This code is the REAL join key against VenusCustomer.code.
// Sets the "current customer" for every doc until the next group header - this state MUST
// survive page breaks (verified: a customer's docs are routinely split across pages with a
// full page-header block in between, e.g. customer ก017 at line 69-107 of the real file).
//
// Per-customer subtotal line, also ESC E/F bracketed: "รวม <name> /<code>   <goods> <vat>
// <total>" - used only to self-certify (sum of that customer's doc totals vs this
// subtotal); never used as a data source.
//
// Doc header: same numeric tail as OESON (credit days, V flag, optional header discount,
// goods value, VAT, total, delivered Y/N, reference) but NO customer-name column - after
// the date comes the salesperson code directly. Void docs start with a leading "*".
//
// Line items: IDENTICAL shape to OESON (lineNo, dashed SKU, name, qty+unit glued, then a
// tail of 0/2/3 trailing money-shaped numbers). Discount/voucher lines use SKU "99-99-xx"
// (e.g. "99-99-02 VOUCHER", "99-99-03 ส่วนลด") with a NEGATIVE amount - self-certify must
// allow negative line sums. A handful of line items show a percentage discount token
// ("10%") in the tail instead of a decimal money amount - since our tail-number regex only
// matches `-?[\d,]+\.\d{2}` shapes, a bare "10%" token is naturally skipped and the
// remaining two numbers (unitPrice, amount) resolve correctly with zero special-casing.
//
// Dates are Thai Buddhist dd/mm/yy -> Gregorian year = 2500 + yy - 543 (same as OESON).
//
// Page furniture (repeating banner/title/filter lines/column headers/dashed separators)
// is stripped FIRST from the whole line stream, then the customer/doc/line state machine
// walks the cleaned stream - this is what makes page breaks transparent whether they land
// mid-doc, mid-customer-group, or between customers.

export interface ParsedOesocLine {
  lineNo: number;
  sku: string;
  name: string;
  qty: number;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
}

export interface ParsedOesocDoc {
  docNo: string;
  docType: string;
  date: Date | null;
  void: boolean;
  customerCode: string;
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
  lines: ParsedOesocLine[];
}

export interface ParsedOesocCustomer {
  code: string;
  name: string;
}

export interface OesocDocMismatch {
  docNo: string;
  total: number;
  lineSum: number;
  diff: number;
}

export interface OesocCustSubtotalMismatch {
  customerCode: string;
  subtotalTotal: number;
  docSum: number;
  diff: number;
}

export interface ParseOesocResult {
  customers: ParsedOesocCustomer[];
  docs: ParsedOesocDoc[];
  distinctCodes: number;
  lineItems: number;
  voids: number;
  dateSpan: { min: Date | null; max: Date | null };
  selfCertify: {
    docChecked: number;
    docOk: number;
    docMatchRate: number;
    custSubtotalChecked: number;
    custSubtotalOk: number;
    custSubtotalMatchRate: number;
    mismatches: OesocDocMismatch[];
    custMismatches: OesocCustSubtotalMismatch[];
  };
  unresolved: number;
  unresolvedSamples: string[];
}

// Customer group header: ESC 'E' <name> /<code> <trailing spaces> ESC 'F'. The code runs
// from the last "/" to end-of-content (trailing spaces trimmed) - codes are ragged
// (Thai-char prefix + ASCII digits/letters, e.g. "ก017A", "ด1551") so we don't anchor on a
// fixed character class, just "no whitespace, everything up to trailing padding".
const CUSTOMER_HEADER_RE = /^(.*)\s+\/(\S+)\s*$/;

// Per-customer subtotal: "       รวม <name> /<code>arbitrary-spaces<goods> <vat> <total>"
// (ESC E/F already stripped by the time we test this, since stripEsc runs first).
// NOTE: on long customer names the printer TRUNCATES the code itself (verified e.g.
// "ข046" -> printed "ข04" when the name pushes past the fixed column) - same class of
// truncation as ARMAST/OESON name caveats. The code captured here is therefore
// BEST-EFFORT ONLY; self-certify below intentionally uses the header-tracked `curCode`
// (the reliable source) to attribute the subtotal, not this capture.
const CUST_SUBTOTAL_RE =
  /^\s*รวม\s+(.*)\s+\/(\S+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/;
const CUST_SUBTOTAL_CANDIDATE_RE = /^\s*รวม\s+.*\/\S+\s+-?[\d,]+\.\d{2}/;

// The "--- --- ---" rule line directly above a customer subtotal (three dash-groups
// separated by spaces, right-aligned under the money columns) - furniture, not data.
const SUBTOTAL_RULE_RE = /^\s*-+(?:\s+-+)*\s*$/;

const NOTE_HEADER_RE = /^\s*หมายเหตุ\s*:?\s*$/;

// Doc header, fields in fixed order (see DOC_RE):
//  1 void flag ("*" or "")          7  optional header-level ส่วนลด (amount OR percent)
//  2 docNo (e.g. SO6819341)         8  มูลค่าสินค้า (goods value)
//  3 order date (dd/mm/yy)          9  VAT
//  4 rep code                      10  รวมทั้งสิ้น (total)
//  5 delivery date (optional)      11  ส่งหมด (Y/N)
//  6 credit days (may be blank)    12  อ้างอิง (free-text reference, rest of line)
// (no "V discount flag" capture group needed separately - it's folded into the optional
// look-ahead the same way OESON does; see the `(?:...)?` block before goods value. That
// header-level discount slot is normally a decimal amount but 2 real docs print a bare
// percentage there instead, e.g. "3%" - the alternation admits that shape too, though we
// don't separately model a percent vs amount distinction, same as the per-line discount.)
const DOC_RE =
  /^\s{0,4}(\*?)\s*([A-Z]{2}\d{7})\s+(\d{2}\/\d{2}\/\d{2})\s+(\S*)\s+(\d{2}\/\d{2}\/\d{2})?\s*(\d*)\s+(\d*)\s+(?:(-?[\d,]+\.\d{2}|\d+%)\s+)?(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+([YN])\s*(.*)$/;
const DOC_CANDIDATE_RE = /^\s{0,4}\*?\s*[A-Z]{2}\d{7}\s+\d{2}\/\d{2}\/\d{2}/;

// Line-item line: identical shape to OESON's LINE_RE.
const LINE_RE =
  /^\s+(\d+)\s+(\d{2}-\d{2}-\d+)\s+(.*?)\s{2,}(-?[\d,]+\.\d{2})([A-Za-zก-๛]+)\s*(.*)$/;
const LINE_CANDIDATE_RE = /^\s+\d+\s+\d{2}-\d{2}-\d+\s+/;

const GRAND_TOTAL_RE = /^\s*รวมทั้งสิ้น/;
const NOTE_FOOTER_RE = /^หมายเหตุ\s*:/;
const END_REPORT_RE = />>>>\s*จบรายงาน/;

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
  if (/^=+$/.test(s)) return true;
  if (t.includes('เลขที่') && t.includes('วันที่') && t.includes('พนักงานขาย')) return true;
  if (t.includes('รายละเอียด') && t.includes('จำนวน') && t.includes('ราคาต่อหน่วย')) return true;
  if (GRAND_TOTAL_RE.test(t)) return true;
  if (NOTE_FOOTER_RE.test(t)) return true;
  if (END_REPORT_RE.test(t)) return true;
  return false;
}

// Strip Express's ESC/P control sequences. Same shapes as parseArmast's stripEsc: ESC 'E'
// / ESC 'F' bracket the customer-header and subtotal lines (we keep the bracketed text,
// only drop the two markers); ESC 'W' <1 byte> toggles printer mode around the report
// title. Any other lone ESC+letter is dropped defensively.
function stripEsc(line: string): string {
  return line
    .replace(/\x1b[EF]/g, '')
    .replace(/\x1bW./g, '')
    .replace(/\x1b./g, '');
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

export function parseOesoc(text: string): ParseOesocResult {
  const rawLines = text.split(/\r?\n/);

  // Pass 1: strip ESC sequences + drop page furniture. Page breaks can land mid-doc or
  // mid-customer-group, so we strip everything first and reassemble state from the
  // cleaned stream - no special-casing for page boundaries.
  const lines: string[] = [];
  for (const raw of rawLines) {
    const stripped = stripEsc(raw);
    if (isPageJunk(stripped)) continue;
    lines.push(stripped.replace(/^\f/, ''));
  }

  const docs: ParsedOesocDoc[] = [];
  const customersByCode = new Map<string, string>(); // code -> name (last seen wins)
  let voids = 0;
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  let unresolved = 0;
  const unresolvedSamples: string[] = [];
  const sample = (s: string) => {
    if (unresolvedSamples.length < 10) unresolvedSamples.push(s.trim().slice(0, 160));
  };

  // Per-customer doc-total accumulator, keyed by code, reset is NOT needed since a code
  // could theoretically recur (defensive; not seen in the real file) - we accumulate
  // across all appearances and compare against the LAST subtotal line seen for that code,
  // which is the common case (subtotal immediately follows that code's doc block).
  const custDocSum = new Map<string, number>();
  const custMismatches: OesocCustSubtotalMismatch[] = [];
  let custSubtotalChecked = 0;
  let custSubtotalOk = 0;

  let curCode: string | null = null;
  let cur: ParsedOesocDoc | null = null;
  let inNoteBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Per-customer subtotal must be tested BEFORE the customer-header test, since both
    // share the "<text> /<code>" tail shape - the "รวม " prefix (candidate regex) disambiguates.
    if (CUST_SUBTOTAL_CANDIDATE_RE.test(line)) {
      const m = line.match(CUST_SUBTOTAL_RE);
      if (m) {
        // Attribute to the header-tracked curCode, NOT m[2] - the subtotal line's own
        // code capture is unreliable (truncated on long names, see CUST_SUBTOTAL_RE doc).
        const code = curCode ?? m[2].trim();
        const subtotalTotal = parseMoney(m[5]);
        const docSum = custDocSum.get(code) ?? 0;
        custSubtotalChecked++;
        const tol = Math.max(1, Math.abs(subtotalTotal) * 0.02);
        const diff = docSum - subtotalTotal;
        if (Math.abs(diff) <= tol) {
          custSubtotalOk++;
        } else if (custMismatches.length < 200) {
          custMismatches.push({ customerCode: code, subtotalTotal, docSum, diff });
        }
        inNoteBlock = false;
        continue;
      }
      // Looked like a subtotal but didn't fit - flag it, fall through to other checks
      // (it won't match anything else, but don't assume; let the loop re-test normally).
    }

    // Rule line directly above a subtotal - furniture, not data.
    if (SUBTOTAL_RULE_RE.test(line) && line.includes('-')) {
      continue;
    }

    // Customer group header: "<name> /<code>" with no leading whitespace (column 0), and
    // NOT a subtotal (already handled above) and not a doc/line-item line.
    if (
      line.length > 0 &&
      !/^\s/.test(line) &&
      !DOC_CANDIDATE_RE.test(line) &&
      !LINE_CANDIDATE_RE.test(line)
    ) {
      const m = line.match(CUSTOMER_HEADER_RE);
      if (m) {
        const name = m[1].trim();
        const code = m[2].trim();
        curCode = code;
        cur = null; // no open doc until the next doc header
        inNoteBlock = false;
        if (name || !customersByCode.has(code)) {
          customersByCode.set(code, name);
        }
        continue;
      }
    }

    if (DOC_CANDIDATE_RE.test(line)) {
      const m = line.match(DOC_RE);
      if (!m) {
        unresolved++;
        sample(line);
        continue;
      }
      if (!curCode) {
        // A doc header with no customer group open yet - should not happen against the
        // real file, but flag rather than silently attach to an unknown customer.
        unresolved++;
        sample(line);
        continue;
      }

      const isVoid = m[1] === '*';
      const docNo = m[2];
      const date = parseThaiDate(m[3]);
      const repCode = m[4]?.trim() || null;
      const deliveryDate = parseThaiDate(m[5]);
      const creditDays = m[6] ? Number(m[6]) : null;
      // m[7] is the "V" discount flag (0/1) - not modeled as its own field, same as OESON.
      const discount = parseMoneyOrNull(m[8]);
      const goodsValue = parseMoney(m[9]);
      const vat = parseMoney(m[10]);
      const total = parseMoney(m[11]);
      const delivered = m[12] === 'Y' ? true : m[12] === 'N' ? false : null;
      const reference = m[13]?.trim() || null;
      inNoteBlock = false;

      cur = {
        docNo,
        docType: docNo.slice(0, 2),
        date,
        void: isVoid,
        customerCode: curCode,
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
      custDocSum.set(curCode, (custDocSum.get(curCode) ?? 0) + total);
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
        // unitPrice, per-line discount (nums[1], not separately modeled), amount.
        unitPrice = parseMoneyOrNull(nums[0]);
        amount = parseMoneyOrNull(nums[2]);
      }
      // nums.length === 0: blank tail (e.g. warranty-style line) - kept, never dropped.
      // A "10%" style percentage token in the tail is simply not matched by the money
      // regex, so nums.length still resolves to 2 (unitPrice, amount) in that case.

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

    // A non-blank line that's not a customer header, subtotal, doc header, or line-item.
    // Two legitimate shapes: continuation lines inside an open "หมายเหตุ:" block (e.g. a
    // shipping address split across several indented lines), and indented free-text
    // directly under a line-item. Both are notes attached to the CURRENT DOC (mirrors
    // parseOeson's note handling) - not structured data, but not garbage either.
    if (cur) {
      cur.notes.push(trimmed);
      continue;
    }

    // Stray text with no open doc at all - flag it.
    unresolved++;
    sample(line);
  }

  const customers: ParsedOesocCustomer[] = Array.from(customersByCode.entries()).map(
    ([code, name]) => ({ code, name }),
  );

  // Self-certify per doc: sum(line amounts) vs the doc's รวมทั้งสิ้น, 2% tolerance (floor
  // 1 baht), NEGATIVE amounts (voucher/discount lines) allowed and included as-is. Void
  // docs excluded (cancelled, totals typically 0). Every doc stays in `docs` regardless.
  let docChecked = 0;
  let docOk = 0;
  const mismatches: OesocDocMismatch[] = [];
  for (const d of docs) {
    if (d.void) continue;
    docChecked++;
    const lineSum = d.lines.reduce((acc, l) => acc + (l.amount ?? 0), 0);
    const tol = Math.max(1, Math.abs(d.total) * 0.02);
    const diff = lineSum - d.total;
    if (Math.abs(diff) <= tol) {
      docOk++;
    } else if (mismatches.length < 200) {
      mismatches.push({ docNo: d.docNo, total: d.total, lineSum, diff });
    }
  }

  const lineItems = docs.reduce((acc, d) => acc + d.lines.length, 0);

  return {
    customers,
    docs,
    distinctCodes: customersByCode.size,
    lineItems,
    voids,
    dateSpan: { min: minDate, max: maxDate },
    selfCertify: {
      docChecked,
      docOk,
      docMatchRate: docChecked > 0 ? docOk / docChecked : 1,
      custSubtotalChecked,
      custSubtotalOk,
      custSubtotalMatchRate: custSubtotalChecked > 0 ? custSubtotalOk / custSubtotalChecked : 1,
      mismatches,
      custMismatches,
    },
    unresolved,
    unresolvedSamples,
  };
}

export { decodeExpressBytes };
