import { parseCsv } from './csv.js';
import { BankParseError, type ParsedBankFile, type ParsedBankRow } from './types.js';

// Parser for the K SHOP merchant-app "TRANSACTION REPORT - payment" export (UTF-8 with
// BOM, LF line endings). See JUNO_PROCESS_BRIEF.md PHASE B / B0 for the confirmed layout:
//
//   TRANSACTION REPORT - payment,
//   Request Date :,03-07-2026,
//   Merchant ID :,KB000001748389,
//   Shop Name :,พรอมมิเน้นท์,No. of Payment transaction :,23,
//   Shop Owner :,<name>,No. of Void transaction :,0,
//   No.,Date Time,Transaction ID,Transaction Type,Amount,From Account,To Account,Source of Fund,Customer,Item,Original Transaction ID,
//   1,01-07-2026 09:21:29,EMPKB000001748389004,Payment,8820.00,บจก. เพชรสมุทร,KB000001748389,"TMBThanachart Bank","-",-,EMPKB000001748389004,
//   ...
//   ,,,Total (THB),88787.60,
//   ,,,*ยอดเงินที่แสดง...,
//
// Data rows = rows whose first cell is numeric (the "No." running index). Footer
// (Total/note) rows have an empty first cell and are skipped. `Transaction Type` ==
// "Void" rows are NOT stored (excluded, counted) — everything else with type "Payment"
// is an income row. Amounts are GROSS (pre-fee/VAT per the footer note) so they match
// Payment.amount directly.

const HEADER_MARKER = 'TRANSACTION REPORT';

// DD-MM-YYYY HH:MM:SS, Thai local time. Built with an explicit +07:00 offset so the
// resulting Date is correct regardless of the server's TZ.
function parseKshopDateTime(s: string): Date | null {
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseKshop(text: string): ParsedBankFile {
  const clean = text.replace(/^﻿/, '');
  if (!clean.includes(HEADER_MARKER)) {
    throw new BankParseError('not_a_kshop_file');
  }

  const rows = parseCsv(clean);
  const out: ParsedBankRow[] = [];
  let parsed = 0;
  let excluded = 0;
  let periodFrom: Date | null = null;
  let periodTo: Date | null = null;

  for (const r of rows) {
    const first = (r[0] ?? '').trim();
    // Data rows start with the numeric running index ("No."). Header/metadata/footer
    // rows (blank first cell, or literal "No." on the column-header row) are skipped.
    if (!/^\d+$/.test(first)) continue;

    parsed++;
    const txnAtRaw = (r[1] ?? '').trim();
    const txnType = (r[3] ?? '').trim();
    const amountRaw = (r[4] ?? '').trim();
    const fromAccount = (r[5] ?? '').trim(); // payer name
    const sourceOfFund = (r[7] ?? '').trim(); // payer's bank (quoted in the file)
    const originalTxnId = (r[10] ?? '').trim(); // terminal id lives here on card/QR rows

    const txnAt = parseKshopDateTime(txnAtRaw);
    if (!txnAt) { excluded++; continue; } // unparseable date — can't reconcile, don't guess

    if (periodFrom === null || txnAt < periodFrom) periodFrom = txnAt;
    if (periodTo === null || txnAt > periodTo) periodTo = txnAt;

    if (txnType === 'Void') { excluded++; continue; } // voided — do not store, count as excluded
    if (txnType !== 'Payment') { excluded++; continue; } // unknown type — be conservative

    const amountNum = parseFloat(amountRaw.replace(/,/g, ''));
    if (!Number.isFinite(amountNum)) { excluded++; continue; }

    out.push({
      txnAt,
      amount: amountNum.toFixed(2),
      direction: 'in', // K SHOP transaction report is payment-in only
      channel: 'K SHOP',
      description: txnType, // "Payment"
      details: [fromAccount, sourceOfFund, originalTxnId].filter(Boolean).join(' · '),
      payerName: fromAccount === '-' ? '' : fromAccount,
      payerBank: sourceOfFund === '-' ? '' : sourceOfFund,
    });
  }

  if (parsed === 0) throw new BankParseError('no_rows_found');

  return { source: 'kshop', rows: out, parsed, excluded, periodFrom, periodTo };
}
