import iconv from 'iconv-lite';
import { parseCsv } from './csv.js';
import { BankParseError, type ParsedBankFile, type ParsedBankRow } from './types.js';

// Parser for the KBIZ (Kasikorn business banking) statement CSV. See
// JUNO_PROCESS_BRIEF.md PHASE B / B0 for the confirmed layout. Sample header block:
//
//   รายการเดินบัญชีเงินฝากออมทรัพย์ (มีรายละเอียด),,,,,,,,,,,,
//   K-DEPOSIT STATEMENT OF SAVING ACCOUNT (WITH DETAIL),,,,,,,,,,,,
//   ,Ref. No. DD.048 : ...,Page 1/1,,,0099,,,,,,,
//   ,Account,"PROMINENT CO.,LTD.
//   47/3 ซ.อินทามระ 25 ...",,,,,Reference Code,,,,26070308150301530998,
//   ...
//   ,,,,,,,TOTAL WITHDRAWAL,,6,,ITEMS,"916,925.84"
//   ,,,,,,,TOTAL DEPOSIT,,59,,ITEMS,"438,334.94"
//   ,Date,"Time/\nEff.Date",Descriptions,Withdrawal,,Deposit,,"Outstanding\nBalance",,Channel,,Details
//   ,01-07-26,,Beginning Balance,,,,,"11,795,844.81",,,,
//   ,01-07-26,02:24,Transfer Deposit,,,"2,425.00",,"11,798,269.81",,K BIZ,,From X5610 SP SUSTAINABLE CO.++
//   ...
//
// The multi-line quoted "Account" cell (and the "Time/\nEff.Date" / "Outstanding\nBalance"
// header cells) are why this MUST go through the real CSV tokenizer (parseCsv) rather than
// a raw line-split. Every data row's first cell is empty; the fields we need sit at fixed
// indexes (1=Date, 2=Time, 3=Descriptions, 4=Withdrawal, 6=Deposit, 8=Balance, 10=Channel,
// 12=Details) — found dynamically once via the header row rather than hardcoded, so a
// stray leading/trailing blank column wouldn't silently misalign every field.

const HEADER_MARKER = 'K-DEPOSIT STATEMENT';
const EXCLUDED_CHANNEL = 'EDC/K SHOP/MYQR'; // the nightly K SHOP settlement lump (detail arrives via K SHOP file)

// Known bank codes that can appear as the token right after "From" (with or without a
// leading "SMART " for Automatic Deposit rows). Used to tell "From BBL X0824 NAME++"
// (bank code present) apart from "From X7375 NAME++" (no bank code, K PLUS/K BIZ internal).
const BANK_CODES = new Set([
  'SCB', 'KTB', 'BBL', 'TTB', 'BAY', 'GSB', 'LHBANK', 'KK', 'KBANK', 'UOB', 'CIMB', 'TISCO', 'ISBT', 'BAAC',
]);

function decodeKbizBytes(buf: Buffer): string {
  // Strip a UTF-8 BOM if present, then decode as UTF-8. If that yields the replacement
  // character (U+FFFD) — a sign the bytes were actually windows-874/TIS-620 — retry with
  // that codec instead (per spec: "if decoding yields U+FFFD, retry as windows-874").
  const utf8 = buf.toString('utf8');
  if (utf8.includes('�')) {
    return iconv.decode(buf, 'windows-874');
  }
  return utf8.replace(/^﻿/, '');
}

// DD-MM-YY (Gregorian, 26 -> 2026) + optional HH:MM. Time is empty on the Beginning
// Balance row — callers pass '' and get midnight, which is fine since that row is skipped
// before txnAt is ever used for matching.
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

function parseAmount(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Best-effort payer extraction from Details, per spec:
//   payerName = text after the last "X####␣" up to "++"
//   payerBank = token after "From" when it is a known bank code
//   cheque rows: refHint = the cheque no.
function extractPayerInfo(details: string): { payerName: string; payerBank: string; refHint: string } {
  const chequeMatch = details.match(/Cheque No\.\s*(\S+)/i);
  if (chequeMatch) {
    return { payerName: '', payerBank: '', refHint: chequeMatch[1] };
  }

  // "From [SMART ][BANKCODE ]X#### NAME++" — find the last X#### token (accounts embedded
  // in a company name, e.g. "X9354", would only be earlier in the string) and take
  // everything between it and the trailing "++" as the name.
  const xMatches = [...details.matchAll(/X\d{3,6}\s/g)];
  if (xMatches.length === 0) return { payerName: '', payerBank: '', refHint: '' };
  const last = xMatches[xMatches.length - 1];
  const afterX = details.slice(last.index! + last[0].length);
  const payerName = afterX.replace(/\+\+\s*$/, '').trim();

  // Bank code = the token immediately before the X#### we anchored on, skipping a
  // "SMART" marker (Automatic Deposit rows: "From SMART SCB X9447 ..."), and only if
  // it's a recognized code (otherwise "From X7375 ..." has no bank — K PLUS/K BIZ internal).
  const beforeX = details.slice(0, last.index!).trim().split(/\s+/);
  const candidate = beforeX[beforeX.length - 1] ?? '';
  const payerBank = BANK_CODES.has(candidate.toUpperCase()) ? candidate.toUpperCase() : '';

  return { payerName, payerBank, refHint: '' };
}

export function parseKbiz(buf: Buffer): ParsedBankFile {
  const text = decodeKbizBytes(buf);
  if (!text.includes(HEADER_MARKER)) {
    throw new BankParseError('not_a_kbiz_file');
  }

  const allRows = parseCsv(text);
  const headerIdx = allRows.findIndex(
    (r) => r.some((c) => c.trim() === 'Date') && r.some((c) => c.includes('Descriptions')),
  );
  if (headerIdx === -1) throw new BankParseError('header_row_not_found');

  const out: ParsedBankRow[] = [];
  let parsed = 0;
  let excluded = 0;
  let periodFrom: Date | null = null;
  let periodTo: Date | null = null;

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const r = allRows[i];
    const description = (r[3] ?? '').trim();
    if (!description) continue; // blank trailing rows

    parsed++;
    if (description === 'Beginning Balance') { excluded++; continue; }

    const dateRaw = r[1] ?? '';
    const timeRaw = r[2] ?? '';
    const txnAt = parseKbizDateTime(dateRaw, timeRaw);
    if (!txnAt) { excluded++; continue; }

    if (periodFrom === null || txnAt < periodFrom) periodFrom = txnAt;
    if (periodTo === null || txnAt > periodTo) periodTo = txnAt;

    const channel = (r[10] ?? '').trim();
    if (channel === EXCLUDED_CHANNEL) { excluded++; continue; } // nightly K SHOP settlement lump

    const withdrawal = parseAmount(r[4] ?? '');
    const deposit = parseAmount(r[6] ?? '');
    const details = (r[12] ?? '').trim();

    const direction = deposit !== null ? 'in' : 'out';
    const amount = deposit !== null ? deposit : withdrawal;
    if (amount === null) { excluded++; continue; } // neither column populated — can't use this row

    const { payerName, payerBank } = extractPayerInfo(details);

    out.push({
      txnAt,
      amount: amount.toFixed(2),
      direction,
      channel,
      description,
      details,
      payerName,
      payerBank,
    });
  }

  if (parsed === 0) throw new BankParseError('no_rows_found');

  return { source: 'kbiz', rows: out, parsed, excluded, periodFrom, periodTo };
}
