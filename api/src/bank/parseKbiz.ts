import iconv from 'iconv-lite';
import { parseCsv } from './csv.js';

// Parser for the KBIZ (Kasikorn business banking) statement CSV. This is a SHARED
// parser — the Juno workstream (income reconciliation) uses the same file format for
// the SAME bank account family; Ceres imports statements from a SEPARATE expense
// account, same format. Keep this module generic (not Ceres-specific). K SHOP parsing
// is Juno's job and does NOT live here — see checkBankParsers.ts header comment.
//
// Format (confirmed against a real export, see docs/JUNO_PROCESS_BRIEF.md PHASE B / B0):
//   รายการเดินบัญชี...,,,,,,,,,,,,
//   K-DEPOSIT STATEMENT OF SAVING ACCOUNT (WITH DETAIL),,,,,,,,,,,,
//   ,Ref. No. ...
//   ,Account,"PROMINENT CO.,LTD.
//   47/3 ซ.อินทามระ 25 ...",,,,,Reference Code,,,,...,
//   ,,,,,,,Account Number,,,,000-0-00000-0,
//   ,,,,,,,Period,,,,01/07/2026 - 02/07/2026,
//   ,,,,,,,TOTAL WITHDRAWAL,,6,,ITEMS,"916,925.84"
//   ,,,,,,,TOTAL DEPOSIT,,59,,ITEMS,"438,334.94"
//   ,Date,"Time/\nEff.Date",Descriptions,Withdrawal,,Deposit,,"Outstanding\nBalance",,Channel,,Details
//   ,01-07-26,,Beginning Balance,,,,,"11,795,844.81",,,,
//   ,01-07-26,02:24,Transfer Deposit,,,"2,425.00",,"11,798,269.81",,K BIZ,,From X5610 SP SUSTAINABLE CO.++
//   ...
//
// The multi-line quoted "Account" cell (and the "Time/\nEff.Date" / "Outstanding\nBalance"
// header cells) are why this MUST go through the real CSV tokenizer (parseCsv) rather
// than a raw line-split. Every data row's first cell is empty; the fields we need sit at
// fixed indexes (1=Date, 2=Time, 3=Descriptions, 4=Withdrawal, 6=Deposit, 8=Balance,
// 10=Channel, 12=Details) — found dynamically once via the header row rather than
// hardcoded, so a stray leading/trailing blank column wouldn't silently misalign every
// field (we still index into the row using the spec's fixed positions once the header
// row itself is located, per the task spec).

export interface KbizRow {
  txnAt: Date;
  amount: string;
  direction: 'in' | 'out';
  channel: string;
  description: string;
  details: string;
  payerName: string;
  payerBank: string;
}

export interface KbizParseResult {
  rows: KbizRow[];
  counts: { parsed: number; excluded: number };
  periodFrom: string;
  periodTo: string;
  headerTotals: { depositItems: number | null; withdrawalItems: number | null };
}

const HEADER_MARKER = 'K-DEPOSIT STATEMENT';
const KSHOP_MARKER = 'TRANSACTION REPORT'; // K SHOP file — belongs to Juno, not here
const EXCLUDED_CHANNEL = 'EDC/K SHOP/MYQR'; // nightly K SHOP settlement lump

// Known bank codes that can appear as the token right after "From" (with or without a
// leading "SMART " for Automatic Deposit rows). Used to tell "From BBL X0824 NAME++"
// (bank code present) apart from "From X7375 NAME++" (no bank code, K PLUS/K BIZ internal).
const BANK_CODES = new Set([
  'SCB', 'KTB', 'BBL', 'TTB', 'BAY', 'GSB', 'LHBANK', 'KK', 'KBANK', 'UOB', 'CIMB', 'ICBC',
]);

function decodeKbizBytes(buf: Buffer): string {
  // Try utf8 first, strip a leading BOM. If the decoded text contains the replacement
  // character (U+FFFD) — a sign the bytes were actually windows-874/TIS-620 — retry
  // decoding the SAME buffer with iconv-lite using windows-874.
  const utf8 = buf.toString('utf8').replace(/^﻿/, '');
  if (utf8.includes('�')) {
    return iconv.decode(buf, 'windows-874');
  }
  return utf8;
}

// mirrors common.ts's thaiDayKey (api/src/routes/ceres/common.ts) — duplicated locally
// rather than imported to avoid a module-boundary/circular-import risk between
// api/src/bank/ (generic, shared with Juno) and api/src/routes/ceres/ (Ceres-specific).
const TH_OFFSET_MS = 7 * 3600 * 1000;
function thaiDayKey(d: Date): string {
  return new Date(d.getTime() + TH_OFFSET_MS).toISOString().slice(0, 10);
}

// DD-MM-YY (Gregorian, 26 -> 2026) + optional HH:MM, built with an explicit +07:00
// offset so downstream .toISOString() is unambiguous regardless of server TZ. Time is
// empty on the Beginning Balance row — that row is skipped before txnAt is ever used.
function parseKbizDateTime(dateRaw: string, timeRaw: string): Date | null {
  const dm = dateRaw.trim().match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const [, dd, mm, yy] = dm;
  const yyyy = 2000 + Number(yy);
  const tm = timeRaw.trim().match(/^(\d{2}):(\d{2})$/);
  const hh = tm ? tm[1] : '00';
  const min = tm ? tm[2] : '00';
  const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Amounts arrive quoted with thousands-separator commas (e.g. "1,234.56"). Normalize to
// a plain decimal string ("1234.56") — kept as a string throughout (not a float) to
// match CeresStatementLine.amount's String/Decimal-as-string house style and avoid
// float precision loss.
function parseAmount(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, '').replace(/,/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

// Best-effort extraction from Details, per spec:
//   payerName = text after the LAST "X####␣" up to (not including) the next "++"
//   payerBank = token after "From" when it is a known bank code (special-cases a
//     "SMART" marker before the bank code: "From SMART BBL X5678 NAME++" -> payerBank BBL)
// Defensive: any malformed row just yields ''.
function extractPayerInfo(details: string): { payerName: string; payerBank: string } {
  try {
    const xMatches = [...details.matchAll(/X\d{3,6}\s/g)];
    if (xMatches.length === 0) return { payerName: '', payerBank: '' };
    const last = xMatches[xMatches.length - 1];
    const afterX = details.slice((last.index ?? 0) + last[0].length);
    const plusIdx = afterX.indexOf('++');
    const payerName = (plusIdx === -1 ? afterX : afterX.slice(0, plusIdx)).trim();

    // Bank code = the token immediately before the X#### we anchored on ("From BBL
    // X0824 NAME++" -> "BBL"), UNLESS that token is the literal "SMART" marker used on
    // Automatic Deposit rows without a bank code ("From SMART X#### NAME++" -> no bank).
    // The "From SMART BBL X5678 NAME++" special case (SMART + bank code both present)
    // is handled because the token immediately before X#### is "BBL", not "SMART" —
    // "SMART" only matters when it's the token directly preceding X#### with no code.
    const beforeX = details.slice(0, last.index ?? 0).trim().split(/\s+/).filter(Boolean);
    const tokenBeforeX = beforeX[beforeX.length - 1] ?? '';
    const candidate = tokenBeforeX.toUpperCase() === 'SMART' ? '' : tokenBeforeX;
    const payerBank = BANK_CODES.has(candidate.toUpperCase()) ? candidate.toUpperCase() : '';

    return { payerName, payerBank };
  } catch {
    return { payerName: '', payerBank: '' };
  }
}

// Opportunistic extraction of the header/footer summary lines:
//   ...,TOTAL WITHDRAWAL,,6,,ITEMS,"916,925.84"
//   ...,TOTAL DEPOSIT,,59,,ITEMS,"438,334.94"
// Scans every row's cells for one containing the label text, then pulls the nearest
// adjacent numeric cell (the item COUNT, not the amount) as the header total. Best
// effort — null if not found; never throws.
function extractHeaderTotal(allRows: string[][], label: string): number | null {
  for (const r of allRows) {
    const idx = r.findIndex((c) => c.trim().toUpperCase() === label);
    if (idx === -1) continue;
    // The count sits a couple of cells after the label (label,,N,,ITEMS,"amount");
    // scan forward for the first purely-numeric cell.
    for (let i = idx + 1; i < r.length; i++) {
      const cell = r[i].trim();
      if (/^\d+$/.test(cell)) return Number(cell);
    }
  }
  return null;
}

export function parseKbiz(buf: Buffer): KbizParseResult {
  const text = decodeKbizBytes(buf);

  if (text.includes(KSHOP_MARKER) && !text.includes(HEADER_MARKER)) {
    throw new Error('not_kbiz'); // K SHOP file — out of scope here, belongs to Juno
  }
  if (!text.includes(HEADER_MARKER)) {
    throw new Error('not_kbiz');
  }

  const allRows = parseCsv(text);
  const headerIdx = allRows.findIndex(
    (r) => r.some((c) => c.trim() === 'Date') && r.some((c) => c.includes('Descriptions')),
  );
  if (headerIdx === -1) throw new Error('not_kbiz');

  const depositItems = extractHeaderTotal(allRows, 'TOTAL DEPOSIT');
  const withdrawalItems = extractHeaderTotal(allRows, 'TOTAL WITHDRAWAL');

  const rows: KbizRow[] = [];
  let parsed = 0;
  let excluded = 0;
  let periodFromDate: Date | null = null;
  let periodToDate: Date | null = null;

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const r = allRows[i];
    const firstCell = (r[0] ?? '').trim();
    if (firstCell !== '') continue; // only rows whose FIRST cell is empty are data rows

    const description = (r[3] ?? '').trim();
    const withdrawalRaw = r[4] ?? '';
    const depositRaw = r[6] ?? '';

    if (description === 'Beginning Balance') { continue; } // not stored, not counted in parsed/excluded (it's not a transaction row at all)
    if (!withdrawalRaw.trim() && !depositRaw.trim()) { continue; } // neither column populated — not a transaction row

    parsed++;

    const channel = (r[10] ?? '').trim();
    if (channel === EXCLUDED_CHANNEL) { excluded++; continue; } // nightly K SHOP settlement lump

    const dateRaw = r[1] ?? '';
    const timeRaw = r[2] ?? '';
    const txnAt = parseKbizDateTime(dateRaw, timeRaw);
    if (!txnAt) { excluded++; continue; }

    const withdrawal = parseAmount(withdrawalRaw);
    const deposit = parseAmount(depositRaw);
    const details = (r[12] ?? '').trim();

    const direction: 'in' | 'out' = deposit !== null ? 'in' : 'out';
    const amount = deposit !== null ? deposit : withdrawal;
    if (amount === null) { excluded++; continue; }

    if (periodFromDate === null || txnAt < periodFromDate) periodFromDate = txnAt;
    if (periodToDate === null || txnAt > periodToDate) periodToDate = txnAt;

    const { payerName, payerBank } = extractPayerInfo(details);

    rows.push({
      txnAt,
      amount,
      direction,
      channel,
      description,
      details,
      payerName,
      payerBank,
    });
  }

  return {
    rows,
    counts: { parsed, excluded },
    periodFrom: periodFromDate ? thaiDayKey(periodFromDate) : '',
    periodTo: periodToDate ? thaiDayKey(periodToDate) : '',
    headerTotals: { depositItems, withdrawalItems },
  };
}
