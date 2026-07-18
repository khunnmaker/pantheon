// Parser for Express's STTRNR6.TXT — รายงานจ่ายสินค้าภายใน (internal goods-issue / XS report),
// CP874 fixed-width printer output, same family as parseReReceipts/parseArmast.
//
// Shape (after ESC-stripping):
//   XS6900342    15/07/69        R022                          ← doc header (note = free text;
//                                                                from XS6900340 the owner's
//                                                                sales-channel docs carry the
//                                                                Express customer code here)
//      1   07-01-03  GELMAX ...  02    5.00 ถุง   90.00  450.00 ← item lines (skipped; only the
//      2   07-01-03  GELMAX ...  02    2.00 ถุง   90.00  180.00   per-doc total matters)
//                                             รวม        630.00 ← per-doc total (absent when the
//                                                                doc has no priced lines → 0)
//   ...
//   เอกสาร  343 ใบ            รวมทั้งสิ้น  398,288.86           ← grand footer (self-check)
//
// Docs with no item lines at all are still real docs (amount 0). Page banners/headers repeat
// mid-doc across page breaks and are dropped wherever they occur.

import { decodeExpressBytes } from '../stock/parseExpressReport.js';

export interface XsDocParsed {
  xsNo: string; // compact incl. prefix, e.g. "XS6900342" — matches Payment.billNos entries
  docDate: string; // as printed, dd/mm/yy Buddhist
  note: string;
  amount: number; // per-doc รวม (0 when no priced lines)
  itemCount: number;
}

export interface XsParseResult {
  docs: XsDocParsed[];
  totalAmount: number;
  fileCount: number | null; // "เอกสาร N ใบ" from the grand footer (null if footer missing)
  fileTotal: number | null; // "รวมทั้งสิ้น" from the grand footer
  totalsMatch: boolean;
  encoding: string;
  unresolved: number;
  unresolvedSamples: string[];
}

const XS_HEADER_RE = /^XS(\d{7})\s+(\d{2}\/\d{2}\/\d{2})\s*(.*)$/;
// Item line: indented ลำดับ + a NN-NN-NN product code. Only counted, never priced — the per-doc
// รวม line is the money of record.
const ITEM_CANDIDATE_RE = /^\s+\d+\s+\d{2}-\d{2}-\d{2}\s+/;
const DOC_TOTAL_RE = /^\s*รวม\s+(-?[\d,]+\.\d{2})\s*$/;
const GRAND_FOOTER_RE = /เอกสาร\s+(\d+)\s*ใบ\s+รวมทั้งสิ้น\s+(-?[\d,]+\.\d{2})/;

function stripEsc(line: string): string {
  return line
    .replace(/\x1b[EF]/g, '')
    .replace(/\x1bW./g, '')
    .replace(/\x1b./g, '');
}

function isPageJunk(line: string): boolean {
  const t = line.replace(/^\f/, '');
  const s = t.trim();
  if (s === '') return true;
  if (t.includes('บริษัท พรอมมิเน้นท์')) return true;
  if (t.includes('รายงานจ่ายสินค้าภายใน')) return true;
  if (t.startsWith('วันที่จาก')) return true;
  if (t.startsWith('เลขที่จาก')) return true;
  if (/^-{10,}$/.test(s)) return true;
  if (/^-+(?:\s+-+)*$/.test(s)) return true;
  if (/^=+(?:\s+=+)*$/.test(s)) return true;
  if (t.includes('ลำดับ') && t.includes('รหัสสินค้า')) return true;
  if (t.includes('จบรายงาน')) return true;
  return false;
}

function parseMoney(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

export function parseXsDocs(buf: Buffer): XsParseResult {
  const { text, encoding } = decodeExpressBytes(buf);
  const docs: XsDocParsed[] = [];
  let current: XsDocParsed | null = null;
  let fileCount: number | null = null;
  let fileTotal: number | null = null;
  const unresolvedSamples: string[] = [];
  let unresolved = 0;

  const flush = () => {
    if (current) docs.push(current);
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripEsc(rawLine);
    if (isPageJunk(line)) continue;

    const grand = GRAND_FOOTER_RE.exec(line);
    if (grand) {
      flush();
      fileCount = Number(grand[1]);
      fileTotal = parseMoney(grand[2]);
      continue;
    }

    const header = XS_HEADER_RE.exec(line.replace(/^\f/, ''));
    if (header) {
      flush();
      current = {
        xsNo: `XS${header[1]}`,
        docDate: header[2],
        note: header[3].trim(),
        amount: 0,
        itemCount: 0,
      };
      continue;
    }

    const total = DOC_TOTAL_RE.exec(line);
    if (total && current) {
      current.amount = parseMoney(total[1]);
      continue;
    }

    if (ITEM_CANDIDATE_RE.test(line)) {
      if (current) current.itemCount += 1;
      // item lines outside a doc are page-break strays already covered by the junk filter; if one
      // truly appears with no open doc, record it below rather than guessing an owner.
      if (current) continue;
    }

    unresolved += 1;
    if (unresolvedSamples.length < 10) unresolvedSamples.push(line.slice(0, 160));
  }
  flush();

  const totalAmount = Number(docs.reduce((s, d) => s + d.amount, 0).toFixed(2));
  const totalsMatch =
    (fileCount === null || fileCount === docs.length) &&
    (fileTotal === null || Math.round(totalAmount * 100) === Math.round(fileTotal * 100));

  return { docs, totalAmount, fileCount, fileTotal, totalsMatch, encoding, unresolved, unresolvedSamples };
}
