import { decodeExpressBytes } from '../stock/parseExpressReport.js';

// Parser for Prominent's Express CUSTOMER MASTER report ("ARMAST" / "รายละเอียดลูกค้า
// แยกตามประเภทลูกค้า"). Like parseExpressReport, this is NOT a CSV — it's a fixed-width
// printer report exported as .txt, encoded Windows-874 (win874). Verified against the
// real 6.6 MB export (10,568 customers, 2 ประเภท groups): every customer HEADER line is
// EXACTLY 98 characters, so columns are extracted by FIXED CHAR POSITION, not token
// splitting — token splitting breaks because long Thai names legitimately run past
// column 60 (see e.g. code "ค106": the tail-looking tokens "of","cements" are actually
// still inside the name). Column boundaries (0-indexed, confirmed against all 10,568
// header lines with zero variance):
//   [0:2)   = 2 leading spaces (record marker)
//   code    = the next non-space run, terminated by 2+ spaces (CODE_RE)
//   name    = codeEnd .. 76, trimmed (long names ARE truncated by the printer itself —
//             that's a real report limitation we preserve rather than "fix")
//   [76:88) = repCode (พนักงานขาย — e.g. "C1","C2","24","03"), often blank
//   [88:94) = zone (เขต), numeric, often blank for a handful of odd rows
//   [94:98) = priceType (ประเภทราคา), single digit 0-5
// ส่วนลด (discount) is a defined column in the printed header but is BLANK for every
// row in the real file (nothing ever prints past column 98) — kept as an optional field
// in case a future export populates it.
//
// Each customer is a 5-line record: HEADER, addr1(+contact), addr2(+acctNo+shipBy),
// addr3(+creditDays+creditLimit), phone(+creditTerms) — optionally followed by ragged
// indented free-note lines (e.g. "เงินสด", "+เพิ่มยอด 0.25%", or even prose that happens
// to contain a label word like "ที่อยู่..." — such notes must NOT be mistaken for a real
// address line, which is why note lines are collected only via "not a header, not a type
// header" rather than by matching on keywords).
//
// Section headers "ESC E ประเภท : <type> ESC F" set the current custType for every
// following customer until the next one. Page headers repeat every ~40 lines: the
// "บริษัท พรอมมิเน้นท์ จำกัด" banner (prefixed with \f form-feed after page 1), the
// "ESC W \x01 รายละเอียดลูกค้า... ESC W \x00" title, the two "...จาก...ถึง..." filter
// lines, dashed separators, and the "รหัส / คำนำหน้า+ชื่อลูกค้า ..." column header — all
// stripped before reassembly. A page break can land MID-RECORD (verified: customer
// "CS001"'s address block is interrupted by a full page-header block) — stripping first,
// then reassembling the cleaned line stream, handles this correctly without special-casing.

export interface ParsedVenusCustomer {
  code: string;
  name: string;
  custType: string | null;
  repCode: string | null;
  zone: string | null;
  priceType: string | null;
  discount: string | null;
  address: string | null;
  contact: string | null;
  phone: string | null;
  acctNo: string | null;
  shipBy: string | null;
  creditDays: number | null;
  creditLimit: string | null;
  creditTerms: string | null;
  creditTermsNorm: string;
  note: string | null;
}

export interface ParseArmastResult {
  customers: ParsedVenusCustomer[];
  typeGroups: Record<string, number>;
  pageCount: number;
  parsedCount: number;
  unresolved: number;
  unresolvedSamples: string[];
}

// A header line: 2 leading spaces, a code token, then 2+ spaces before the name.
const CODE_RE = /^ {2}(\S+)\s{2,}/;
const TYPE_RE = /ประเภท\s*:\s*(\S+)/;
const NAME_END_COL = 76;

const ADDR1_RE = /^\s*ที่อยู่\s*:\s*(.*?)\s{2,}ผู้ติดต่อ\s*:\s*(.*)$/;
const ADDR2_RE = /^\s*:\s*(.*?)\s{2,}เลขที่บ\/ช\s*:\s*(\S*)\s*ขนส่งโดย\s*:\s*(\S*)\s*$/;
const ADDR3_RE = /^\s*:\s*(.*?)\s{2,}เครดิต\s*:\s*(\d*)\s*วัน\s*วงเงิน\s*:\s*([\d,]+\.\d+)\s*$/;
const PHONE_RE = /^\s*โทร\.\s*:\s*(.*?)\s{2,}เงื่อนไข\s*:\s*(.*)$/;

// Strip Express's ESC/P control sequences. Two shapes seen in the real file:
//   ESC 'W' <1 byte>            — printer mode toggle around the report title
//   ESC 'E' <text> ESC 'F'      — brackets the "ประเภท : <type>" section header; we keep
//                                 the bracketed text (that's the useful part) and only
//                                 drop the two ESC+letter markers themselves.
// Any other lone ESC+letter is dropped defensively (never seen in the real file, but a
// different Express export/printer driver could emit one).
function stripEsc(line: string): string {
  return line
    .replace(/\x1b[EF]/g, '')
    .replace(/\x1bW./g, '')
    .replace(/\x1b./g, '');
}

// Page-furniture / separator / footer lines to drop wherever they occur (including
// mid-record, across a page break). Matched on the ESC-stripped line; a leading \f
// (form-feed, page-break marker on pages after the first) is stripped separately.
function isPageJunk(line: string): boolean {
  const t = line.replace(/^\f/, '');
  const s = t.trim();
  if (s === '') return true;
  if (t.includes('บริษัท พรอมมิเน้นท์')) return true;
  if (t.includes('รายละเอียดลูกค้า')) return true;
  if (t.startsWith('ประเภทลูกค้าจาก')) return true;
  if (t.startsWith('ลูกค้าจาก')) return true;
  if (t.startsWith('เขตการขายจาก')) return true;
  if (t.startsWith('พนักงานขายจาก')) return true;
  if (/^-{10,}$/.test(s)) return true;
  if (t.includes('รหัส') && t.includes('คำนำหน้า')) return true;
  if (t.includes('จบรายงาน')) return true;
  return false;
}

// เงื่อนไข free text -> a coarse, stable bucket. Matches substrings seen in the real
// file (78 distinct free-text variants, including typos like "เคดิต"/"เดดิต"/"เตดิต" for
// เครดิต, and "โอนก่องส่ง" for โอนก่อนส่ง) — CASH/PREPAY/CREDIT are matched permissively;
// anything else (or blank with creditDays=0 and no other signal) falls to OTHER, which is
// intentionally a catch-all rather than a guess.
export function normalizeCreditTerms(raw: string, creditDays: number | null): string {
  const t = (raw || '').trim();
  if (!t) return creditDays && creditDays > 0 ? 'CREDIT' : 'OTHER';
  if (/เงินสด|เงิฃนสด/.test(t)) return 'CASH';
  if (/โอน.*ก่อน|โอนก่อง|แจ้งยอดก่อนส่ง/.test(t)) return 'PREPAY';
  if (/เครดิต|เคดิต|เดดิต|เคติด|เตดิต|วงเงิน/.test(t)) return 'CREDIT';
  if (creditDays && creditDays > 0) return 'CREDIT';
  return 'OTHER';
}

export function parseArmast(text: string): ParseArmastResult {
  const rawLines = text.split(/\r?\n/);

  // Pass 1: strip ESC sequences + drop page furniture, counting pages as we go.
  let pageCount = 0;
  const lines: string[] = [];
  for (const raw of rawLines) {
    if (raw.includes('บริษัท พรอมมิเน้นท์')) pageCount++;
    const stripped = stripEsc(raw);
    if (isPageJunk(stripped)) continue;
    lines.push(stripped.replace(/^\f/, ''));
  }

  const typeGroups: Record<string, number> = {};
  const customers: ParsedVenusCustomer[] = [];
  const unresolvedSamples: string[] = [];
  let unresolved = 0;
  const sample = (s: string) => {
    if (unresolvedSamples.length < 10) unresolvedSamples.push(s.trim().slice(0, 160));
  };

  let curType: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const typeM = line.match(TYPE_RE);
    if (typeM) {
      curType = typeM[1].trim();
      i++;
      continue;
    }

    const codeM = line.match(CODE_RE);
    if (!codeM) {
      // Not a header, not a type banner, not junk (already filtered) — a stray line
      // outside any known shape. Flag it; never silently drop.
      unresolved++;
      sample(line);
      i++;
      continue;
    }

    const code = codeM[1].trim();
    const codeEnd = codeM[0].length;
    const name = line.slice(codeEnd, NAME_END_COL).trim();
    const tail = line.length > NAME_END_COL ? line.slice(NAME_END_COL) : '';
    // repCode [76:88) / zone [88:94) / priceType [94:98) relative to the full line, i.e.
    // tail indices 0..12 / 12..18 / 18..22.
    const repCode = tail.slice(0, 12).trim() || null;
    const zone = tail.slice(12, 18).trim() || null;
    const priceType = tail.slice(18, 22).trim() || null;
    const discount = tail.slice(22).trim() || null;

    const addr1Line = lines[i + 1] ?? '';
    const addr2Line = lines[i + 2] ?? '';
    const addr3Line = lines[i + 3] ?? '';
    const phoneLine = lines[i + 4] ?? '';

    const m1 = addr1Line.match(ADDR1_RE);
    const m2 = addr2Line.match(ADDR2_RE);
    const m3 = addr3Line.match(ADDR3_RE);
    const m4 = phoneLine.match(PHONE_RE);

    if (!code || !m1 || !m2 || !m3 || !m4) {
      // Missing a code, or the expected 4-line address/phone block didn't follow in
      // shape — don't guess at a partial record. Flag the whole header for review.
      unresolved++;
      sample(line);
      i++;
      continue;
    }

    const addr1 = m1[1].trim();
    const contact = m1[2].trim() || null;
    const addr2 = m2[1].trim();
    const acctNo = m2[2].trim() || null;
    const shipBy = m2[3].trim() || null;
    const addr3 = m3[1].trim();
    const creditDaysRaw = m3[2].trim();
    const creditDays = creditDaysRaw === '' ? null : Number(creditDaysRaw);
    const creditLimit = m3[3].trim() || null;
    const phone = m4[1].trim() || null;
    const creditTerms = m4[2].trim() || null;

    const address = [addr1, addr2, addr3].filter(Boolean).join(', ') || null;

    // Trailing ragged free-note lines: indented continuation lines that are neither a
    // new header nor a new type banner. Collected verbatim (never guessed at).
    let j = i + 5;
    const noteLines: string[] = [];
    while (j < lines.length) {
      const nl = lines[j];
      if (CODE_RE.test(nl)) break;
      if (TYPE_RE.test(nl)) break;
      const trimmed = nl.trim();
      if (trimmed) noteLines.push(trimmed);
      j++;
    }
    const note = noteLines.length ? noteLines.join(' | ') : null;

    customers.push({
      code,
      name,
      custType: curType,
      repCode,
      zone,
      priceType,
      discount,
      address,
      contact,
      phone,
      acctNo,
      shipBy,
      creditDays: creditDays !== null && !Number.isNaN(creditDays) ? creditDays : null,
      creditLimit,
      creditTerms,
      creditTermsNorm: normalizeCreditTerms(creditTerms ?? '', creditDays),
      note,
    });
    typeGroups[curType ?? '(none)'] = (typeGroups[curType ?? '(none)'] ?? 0) + 1;
    i = j;
  }

  return {
    customers,
    typeGroups,
    pageCount,
    parsedCount: customers.length,
    unresolved,
    unresolvedSamples,
  };
}

export { decodeExpressBytes };
