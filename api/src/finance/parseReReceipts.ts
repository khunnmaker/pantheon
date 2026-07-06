import { decodeExpressBytes } from '../stock/parseExpressReport.js';

// Parser for Prominent's Express AR-RECEIPT report ("ARRCPDAT" / "รายงานการรับชำระหนี้
// เรียงตามวันที่ของใบเสร็จ"). Same family as parseArmast/parseOesoc/parseExpressReport: NOT
// a CSV — a fixed-width printer report exported as .txt, encoded Windows-874 (win874).
// Feeds Juno's RE-reconciliation tab (see JUNO_BRIEF.md "future RE-import" — the WHT task 2
// work exposed grossOf() specifically so this import could compare against it).
//
// Verified against the real ~79KB export (234 receipts, no cancellations): the file's own
// footer ("รวม 234 ใบ … 3,048,569.30 …") matches our parsed count + amount sum EXACTLY —
// see the `fileTotal`/`totalsMatch` self-check below.
//
// STRUCTURE:
//
// Page headers repeat every ~37-38 lines: the "บริษัท พรอมมิเน้นท์ จำกัด" banner (prefixed
// with \f form-feed after page 1), the ESC-W-bracketed "รายงานการรับชำระหนี้..." title, the
// "วันที่จาก...ถึง..." + "พนักงานขาย...ถึง..." filter lines (the latter only on page 1),
// dashed separators, and the "วันที่ เลขที่ใบเสร็จ ชื่อลูกค้า..." column-header line — all
// stripped before reassembly, same strategy as parseArmast/parseOesoc (strip page junk
// from the WHOLE line stream first, then walk the cleaned stream so a page break landing
// mid-receipt or mid-invoice-block is transparent, never special-cased).
//
// RE header line, FIXED COLUMN layout (confirmed against all 234 real header lines with
// zero variance — customer names run right up against the sales-code column with NO
// double-space gap when the name is long enough to fill the field, so token/whitespace
// splitting breaks; fixed character position does not):
//   [0:8)   "DD/MM/YY" receipt date (Thai Buddhist, dd/mm/yy)
//   [8:23)  gap + "RE#######" (7-digit core) + padding
//   [23:64) customerName, trimmed (the printer truncates long names at this column —
//           preserved as a real report limitation, not "fixed", same call parseArmast makes)
//   [64: )  "tail": salesName (first whitespace token) then the money columns. The FIRST
//           `\d[\d,]*\.\d{2}` token in the tail is ยอดตามใบกำกับ (invoice/gross total) — the
//           amount this parser captures. ตัดเงินมัดจำ (deposit-applied) is a defined column
//           to its LEFT but is blank on every real row seen (0.00 only ever appears in the
//           file's own grand-total footer), so "first money token in the tail" reliably
//           resolves to ยอดตามใบกำกับ and not a deposit figure; if a future export ever
//           populates ตัดเงินมัดจำ this assumption would need revisiting (nothing in the
//           234-row real file exercises that path, so we document rather than guess at it).
//           A row whose receipt was NOT fully posted (see notPosted below) has a BLANK
//           second money column (ชำระเป็น) — that's fine, we only read the first token.
//           A trailing "***" appears on those rows (see notPosted).
//
// notPosted: the file's own footer legend states a "***" in the หมายเหตุ (notes) column
// means "ทำรายการรับชำระหนี้ไม่เรียบร้อย" (the receipt transaction was not completed/posted
// cleanly) — captured verbatim as a flag, not excluded (owner spec: reconcile ALL REs
// equally, no special handling).
//
// Cancelled receipts: the footer legend also states a "*" BEFORE the receipt/doc number
// means the receipt was cancelled ("ใบเสร็จถูกยกเลิก") — these must be SKIPPED (not
// imported at all). None appear in the real 234-row file (footer count 234 == every row
// parsed), so this path is exercised only by the synthetic fixture.
//
// Detail lines (indented, no leading date), collected under the CURRENT open receipt until
// the next RE header / page header:
//   "                             IV#######    DD/MM/YY           amount"   (invoice settled)
//   "                             SR#######    DD/MM/YY          -amount"  (credit note, negative)
// Both share one shape once stripped of the doc-type prefix: `\s+(IV|SR)\d{7}\s+DD/MM/YY\s+
// -?[\d,]+\.\d{2}\s*$` — verified against all 344 real detail lines (301 IV + ... credit
// notes) with zero unresolved.
//
// Footer: "                         รวม 234 ใบ        <ESC-E>   0.00   3,048,569.30
// 2,676,820.20   0.00   0.00   0.00   0.00  <ESC-F>" — same ESC 'E'/'F' bracketing
// parseArmast/parseOesoc strip around subtotal lines. Column order after "รวม <n> ใบ" is
// ตัดเงินมัดจำ, ยอดตามใบกำกับ, ชำระเป็น, ... — so the SECOND number is the file's own total
// of ยอดตามใบกำกับ, used below as `fileTotal` (self-check against our parsed sum).

export interface ReReceiptInvoice {
  docNo: string; // IV####### or SR#######
  date: string; // as printed, dd/mm/yy (Thai Buddhist) — kept as-typed like Payment.transferAt
  amount: number; // negative for SR (credit note) lines
}

export interface ReReceiptRow {
  reNumber: string; // bare 7-digit core (ARRCPDAT "RE6907402" -> "6907402")
  receiptDate: string; // dd/mm/yy as printed
  customerName: string;
  salesName: string;
  amount: number; // ยอดตามใบกำกับ (gross/invoice total) — the FIRST money column on the header line
  notPosted: boolean; // true when the line carries a trailing "***" (ทำรายการรับชำระหนี้ไม่เรียบร้อย)
  invoices: ReReceiptInvoice[];
}

export interface ParseReReceiptsResult {
  receipts: ReReceiptRow[];
  parsedCount: number;
  totalAmount: number; // sum of receipts[].amount
  fileTotal: number | null; // the report's own "รวม <n> ใบ" ยอดตามใบกำกับ column, if a footer was found
  totalsMatch: boolean; // totalAmount === fileTotal (satang-rounded); true (vacuously) if no footer present
  cancelledSkipped: number; // receipts marked cancelled ('*' before the doc number) — skipped, not imported
  unresolved: number;
  unresolvedSamples: string[];
}

const NAME_START = 23;
const NAME_END = 64;

// RE header candidate: "DD/MM/YY␠␠RE#######␠␠..." — optionally preceded by a cancellation
// marker "*" per the footer legend ("ใบเสร็จที่มีเครื่องหมาย '*' หน้าเลขที่เอกสาร หมายถึง
// ใบเสร็จถูกยกเลิก"). We test for the marker separately (see below) rather than folding it
// into one regex, so a cancelled receipt is unambiguously identified and skipped rather than
// silently parsed with a stray asterisk in some field.
const RE_HEADER_RE = /^(\d{2}\/\d{2}\/\d{2})\s{2,}\*?\s*RE(\d{7})\s{2,}/;
const RE_CANCELLED_RE = /^\d{2}\/\d{2}\/\d{2}\s{2,}\*\s*RE\d{7}/;

// Detail (invoice/credit-note) line: indented, no leading date, doc type IV or SR, a date,
// then one trailing money token (negative for SR). Verified against all 344 real detail
// lines in ARRCPDAT.TXT with zero unresolved.
const DETAIL_RE = /^\s+(IV|SR)(\d{7})\s+(\d{2}\/\d{2}\/\d{2})\s+(-?[\d,]+\.\d{2})\s*$/;
const DETAIL_CANDIDATE_RE = /^\s+(?:IV|SR)\d{7}\s+/;

// Footer self-check: "รวม <n> ใบ ... <ตัดเงินมัดจำ> <ยอดตามใบกำกับ> <ชำระเป็น> ..." — ESC
// E/F already stripped by the time this is tested (stripEsc runs first, same as
// parseArmast/parseOesoc). We only need the SECOND money figure (ยอดตามใบกำกับ).
const FOOTER_RE = /^\s*รวม\s+(\d+)\s*ใบ\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/;
const FOOTER_CANDIDATE_RE = /^\s*รวม\s+\d+\s*ใบ/;

// Strip Express's ESC/P control sequences. Same shapes as parseArmast/parseOesoc:
//   ESC 'W' <1 byte>       — printer mode toggle around the report title
//   ESC 'E' <text> ESC 'F' — brackets the footer totals line; keep the bracketed text, only
//                            drop the two markers themselves
// Any other lone ESC+letter is dropped defensively.
function stripEsc(line: string): string {
  return line
    .replace(/\x1b[EF]/g, '')
    .replace(/\x1bW./g, '')
    .replace(/\x1b./g, '');
}

// Page-furniture / separator / filter / column-header / legend lines — dropped wherever
// they occur (including mid-receipt across a page break), matched on the ESC-stripped line.
function isPageJunk(line: string): boolean {
  const t = line.replace(/^\f/, '');
  const s = t.trim();
  if (s === '') return true;
  if (t.includes('บริษัท พรอมมิเน้นท์')) return true;
  if (t.includes('รายงานการรับชำระหนี้')) return true;
  if (t.startsWith('วันที่จาก')) return true;
  if (t.startsWith('พนักงานขาย') && t.includes('ถึง')) return true;
  if (/^-{10,}$/.test(s)) return true;
  // The rule lines flanking the footer totals: several dash- or equals-groups separated by
  // spaces, right-aligned under the money columns (same shape as parseOesoc's
  // SUBTOTAL_RULE_RE) — furniture, not data.
  if (/^-+(?:\s+-+)*$/.test(s)) return true;
  if (/^=+(?:\s+=+)*$/.test(s)) return true;
  if (t.includes('วันที่') && t.includes('เลขที่ใบเสร็จ') && t.includes('ชื่อลูกค้า')) return true;
  // Footer legend lines (printed once, after the totals) + the "จบรายงาน" marker. The real
  // file uses a non-breaking space ( ) around the quoted marker rather than a plain
  // space, so match on the space-free "เครื่องหมาย" substring plus the marker itself rather
  // than a literal multi-space run (which silently failed to match against the real export).
  if (t.includes('เครื่องหมาย') && t.includes('ยกเลิก')) return true;
  if (t.includes('เครื่องหมาย') && t.includes('ไม่เรียบร้อย')) return true;
  if (t.includes('จบรายงาน')) return true;
  return false;
}

function parseMoney(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

export function parseReReceipts(text: string): ParseReReceiptsResult {
  const rawLines = text.split(/\r?\n/);

  // Pass 1: strip ESC sequences + drop page furniture. Page breaks can land mid-receipt or
  // mid-invoice-block, so we strip everything first and reassemble state from the cleaned
  // stream — no special-casing for page boundaries (same strategy as parseArmast/parseOesoc).
  const lines: string[] = [];
  for (const raw of rawLines) {
    const stripped = stripEsc(raw);
    if (isPageJunk(stripped)) continue;
    lines.push(stripped.replace(/^\f/, ''));
  }

  const receipts: ReReceiptRow[] = [];
  let cancelledSkipped = 0;
  let unresolved = 0;
  const unresolvedSamples: string[] = [];
  const sample = (s: string) => {
    if (unresolvedSamples.length < 10) unresolvedSamples.push(s.trim().slice(0, 160));
  };

  let cur: ReReceiptRow | null = null;
  let fileTotal: number | null = null;
  // True immediately after skipping a cancelled receipt's header, until the next RE header
  // / footer / non-detail line — lets that cancelled receipt's OWN detail lines (which
  // follow it in the raw stream just like any other receipt's) be silently absorbed instead
  // of flagged unresolved, since they belong to a receipt we've deliberately excluded, not
  // to a genuine parse anomaly.
  let afterCancelled = false;

  for (const line of lines) {
    // Footer total — tested before the RE-header test since neither shares a prefix, but
    // ordering defensively matches the sibling parsers' style (candidate-then-full regex).
    if (FOOTER_CANDIDATE_RE.test(line)) {
      const m = line.match(FOOTER_RE);
      if (m) {
        fileTotal = parseMoney(m[3]); // 2nd money column = ยอดตามใบกำกับ
        cur = null;
        afterCancelled = false;
        continue;
      }
    }

    if (RE_CANCELLED_RE.test(line)) {
      // Cancelled receipt — skip entirely (owner/report spec: not imported), and close out
      // any previously-open receipt. Its own detail lines (which follow just like any other
      // receipt's) get silently absorbed via afterCancelled below, not flagged unresolved.
      cancelledSkipped++;
      cur = null;
      afterCancelled = true;
      continue;
    }

    const hdrM = line.match(RE_HEADER_RE);
    if (hdrM) {
      afterCancelled = false;
      if (line.length < NAME_END) {
        // Header matched the date+RE prefix but the line is too short to hold a full
        // name/tail — flag rather than guess.
        unresolved++;
        sample(line);
        cur = null;
        continue;
      }
      const receiptDate = hdrM[1];
      const reNumber = hdrM[2];
      const customerName = line.slice(NAME_START, NAME_END).trim();
      const tail = line.slice(NAME_END);
      const salesNameM = tail.match(/^(\S*)/);
      const salesName = salesNameM ? salesNameM[1] : '';
      const amtM = tail.match(/-?[\d,]+\.\d{2}/);
      if (!amtM) {
        // No money token at all on the header line — shouldn't happen against the real
        // file (every receipt has ยอดตามใบกำกับ), flag rather than silently drop.
        unresolved++;
        sample(line);
        cur = null;
        continue;
      }
      const amount = parseMoney(amtM[0]);
      const notPosted = tail.includes('***');

      cur = { reNumber, receiptDate, customerName, salesName, amount, notPosted, invoices: [] };
      receipts.push(cur);
      continue;
    }

    if (DETAIL_CANDIDATE_RE.test(line)) {
      const m = line.match(DETAIL_RE);
      if (!m) {
        unresolved++;
        sample(line);
        continue;
      }
      if (!cur) {
        // A detail line with no open receipt. If it directly follows a cancelled receipt's
        // header, it's that cancelled receipt's own (excluded) invoice — silently absorbed,
        // not a parse anomaly. Otherwise (e.g. one stray after a footer) it genuinely has
        // nowhere to attach — flag it rather than guess.
        if (!afterCancelled) {
          unresolved++;
          sample(line);
        }
        continue;
      }
      const docNo = `${m[1]}${m[2]}`;
      const date = m[3];
      const amount = parseMoney(m[4]);
      cur.invoices.push({ docNo, date, amount });
      continue;
    }

    // A non-blank, non-matching line that's neither a header, detail, nor footer — flag it
    // (never silently drop; mirrors parseArmast/parseOesoc's "unresolved" bucket).
    if (line.trim() !== '') {
      unresolved++;
      sample(line);
    }
  }

  const totalAmount = receipts.reduce((acc, r) => acc + r.amount, 0);
  const totalsMatch =
    fileTotal === null ? true : Math.round(totalAmount * 100) === Math.round(fileTotal * 100);

  return {
    receipts,
    parsedCount: receipts.length,
    totalAmount,
    fileTotal,
    totalsMatch,
    cancelledSkipped,
    unresolved,
    unresolvedSamples,
  };
}

export { decodeExpressBytes };
