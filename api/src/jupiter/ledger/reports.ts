import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '../../db/prisma.js';
import { accountingDateString, parseAccountingDate } from './posting.js';
import { moneyToString } from './money.js';

function rescueId(sourceRef: string | null | undefined, fallback: string): string {
  const match = sourceRef?.match(/:(\d+)$/);
  return match?.[1] ?? fallback;
}

export interface LedgerReportFilters {
  companyCode: string;
  from?: string;
  to?: string;
  state?: 'draft' | 'posted' | 'void';
}

function inclusiveDates(from?: string, to?: string) {
  const result: { gte?: Date; lte?: Date } = {};
  if (from) result.gte = parseAccountingDate(from);
  if (to) result.lte = parseAccountingDate(to);
  return result;
}

export async function generalLedger(
  filters: LedgerReportFilters,
  client: PrismaClient = prisma,
) {
  const rows = await client.jupiterJournalLine.findMany({
    where: {
      entry: {
        companyCode: filters.companyCode,
        state: filters.state ?? 'posted',
        entryDate: inclusiveDates(filters.from, filters.to),
      },
    },
    orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { entryNo: 'asc' } }, { lineNo: 'asc' }],
    include: { entry: { include: { journal: true } }, account: true, partner: true },
  });
  return rows.map((line) => ({
    date: accountingDateString(line.entry.entryDate),
    entryId: line.entryId,
    entryNo: line.entry.entryNo,
    journalCode: line.entry.journal.code,
    ref: line.entry.ref,
    lineNo: line.lineNo,
    lineId: line.id,
    accountId: line.accountId,
    rescueAccountId: rescueId(line.account.sourceRef, line.accountId),
    accountCode: line.account.code,
    accountName: line.account.name,
    partnerId: line.partnerId,
    rescuePartnerId: line.partner ? rescueId(line.partner.sourceRef, line.partner.id) : null,
    partnerName: line.partner?.displayName ?? '',
    label: line.label,
    debit: moneyToString(line.debit),
    credit: moneyToString(line.credit),
    parentState: line.entry.state,
    rescueMoveId: rescueId(line.entry.sourceRef, line.entryId),
    rescueLineId: rescueId(line.sourceRef, line.id),
  }));
}

export async function trialBalance(
  filters: Omit<LedgerReportFilters, 'state'>,
  client: PrismaClient = prisma,
) {
  const lines = await client.jupiterJournalLine.findMany({
    where: {
      entry: {
        companyCode: filters.companyCode,
        state: 'posted',
        ...(filters.to ? { entryDate: { lte: parseAccountingDate(filters.to) } } : {}),
      },
    },
    include: { entry: true, account: true },
    orderBy: [{ account: { code: 'asc' } }, { entry: { entryDate: 'asc' } }, { lineNo: 'asc' }],
  });
  const from = filters.from ? parseAccountingDate(filters.from) : null;
  const grouped = new Map<string, {
    accountId: string; accountCode: string; accountName: string;
    rescueAccountId: string; opening: Prisma.Decimal; debit: Prisma.Decimal; credit: Prisma.Decimal; lineCount: number;
  }>();
  for (const line of lines) {
    let row = grouped.get(line.accountId);
    if (!row) {
      row = {
        accountId: line.accountId,
        accountCode: line.account.code,
        accountName: line.account.name,
        rescueAccountId: rescueId(line.account.sourceRef, line.accountId),
        opening: new Prisma.Decimal(0), debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0), lineCount: 0,
      };
      grouped.set(line.accountId, row);
    }
    const net = line.debit.minus(line.credit);
    if (from && line.entry.entryDate < from) row.opening = row.opening.plus(net);
    else {
      row.debit = row.debit.plus(line.debit);
      row.credit = row.credit.plus(line.credit);
      row.lineCount += 1;
    }
  }
  return [...grouped.values()]
    .filter((row) => !row.opening.isZero() || !row.debit.isZero() || !row.credit.isZero())
    .map((row) => ({
      accountId: row.accountId,
      accountCode: row.accountCode,
      accountName: row.accountName,
      rescueAccountId: row.rescueAccountId,
      openingBalance: moneyToString(row.opening),
      periodDebit: moneyToString(row.debit),
      periodCredit: moneyToString(row.credit),
      closingBalance: moneyToString(row.opening.plus(row.debit).minus(row.credit)),
      lineCount: row.lineCount,
    }));
}

export async function partnerLedger(
  filters: Omit<LedgerReportFilters, 'state'> & { partnerId?: string },
  client: PrismaClient = prisma,
) {
  const lines = await client.jupiterJournalLine.findMany({
    where: {
      partnerId: filters.partnerId ?? { not: null },
      entry: {
        companyCode: filters.companyCode,
        state: 'posted',
        ...(filters.to ? { entryDate: { lte: parseAccountingDate(filters.to) } } : {}),
      },
    },
    include: { entry: true, account: true, partner: true },
    orderBy: [{ partner: { displayName: 'asc' } }, { entry: { entryDate: 'asc' } }, { entry: { entryNo: 'asc' } }, { lineNo: 'asc' }],
  });
  const from = filters.from ? parseAccountingDate(filters.from) : null;
  const openings = new Map<string, Prisma.Decimal>();
  const periodLines = lines.filter((line) => {
    if (!from || line.entry.entryDate >= from) return true;
    const key = line.partnerId ?? '';
    if (line.account.accountType === 'asset_receivable' || line.account.accountType === 'liability_payable') {
      const opening = (openings.get(key) ?? new Prisma.Decimal(0)).plus(line.debit).minus(line.credit);
      openings.set(key, opening);
    }
    return false;
  });
  const balances = new Map(openings);
  return periodLines.map((line) => {
    const key = line.partnerId ?? '';
    const opening = openings.get(key) ?? new Prisma.Decimal(0);
    const balance = (balances.get(key) ?? opening).plus(line.debit).minus(line.credit);
    balances.set(key, balance);
    return {
      rowType: 'detail',
      partnerId: line.partnerId,
      rescuePartnerId: line.partner ? rescueId(line.partner.sourceRef, line.partner.id) : null,
      partnerName: line.partner?.displayName ?? '',
      date: accountingDateString(line.entry.entryDate),
      moveId: line.entryId,
      rescueMoveId: rescueId(line.entry.sourceRef, line.entryId),
      moveName: line.entry.entryNo,
      moveRef: line.entry.ref,
      accountId: line.accountId,
      rescueAccountId: rescueId(line.account.sourceRef, line.accountId),
      accountCode: line.account.code,
      accountName: line.account.name,
      lineName: line.label,
      debit: moneyToString(line.debit),
      credit: moneyToString(line.credit),
      openingBalance: moneyToString(opening),
      balance: moneyToString(balance),
      lineId: line.id,
      rescueLineId: rescueId(line.sourceRef, line.id),
      parentState: line.entry.state,
    };
  });
}

function csvCell(value: unknown, formulaGuard: boolean): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = formulaGuard && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rfc4180Csv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  amountColumns: readonly number[] = [],
): string {
  const amounts = new Set(amountColumns);
  return `\uFEFF${[headers, ...rows].map((row, rowIndex) => row
    .map((value, columnIndex) => csvCell(value, rowIndex > 0 && !amounts.has(columnIndex))).join(',')).join('\r\n')}\r\n`;
}

export function trialBalanceCsv(rows: Awaited<ReturnType<typeof trialBalance>>): string {
  const headers = ['account_id', 'account_code', 'account_name', 'debit', 'credit', 'balance', 'line_count'];
  return rfc4180Csv(headers, rows.map((row) => [
    row.rescueAccountId, row.accountCode, row.accountName, row.periodDebit, row.periodCredit, row.closingBalance, row.lineCount,
  ]), [3, 4, 5]);
}

export function partnerLedgerCsv(
  rows: Awaited<ReturnType<typeof partnerLedger>>,
  includeZeroOpening = false,
): string {
  const headers = [
    'row_type', 'partner_id', 'partner_name', 'date', 'move_id', 'move_name', 'move_ref',
    'account_id', 'account_code', 'account_name', 'line_name', 'debit', 'credit', 'balance', 'line_id', 'parent_state',
  ];
  const csvRows: unknown[][] = [];
  const seenPartners = new Set<string>();
  for (const row of rows) {
    const partnerKey = row.partnerId ?? row.rescuePartnerId ?? '';
    if (!seenPartners.has(partnerKey)) {
      seenPartners.add(partnerKey);
      if (includeZeroOpening || row.openingBalance !== '0.00') {
        csvRows.push([
          'opening', row.rescuePartnerId, row.partnerName, '', '', '', '', '', '', '', 'Opening balance',
          '0.00', '0.00', row.openingBalance, '', 'posted',
        ]);
      }
    }
    csvRows.push([
      row.rowType, row.rescuePartnerId, row.partnerName, row.date, row.rescueMoveId, row.moveName, row.moveRef,
      row.rescueAccountId, row.accountCode, row.accountName, row.lineName, row.debit, row.credit, row.balance, row.rescueLineId, row.parentState,
    ]);
  }
  return rfc4180Csv(headers, csvRows, [11, 12, 13]);
}

export function generalLedgerCsv(rows: Awaited<ReturnType<typeof generalLedger>>): string {
  const headers = [
    'date', 'move_id', 'move_name', 'journal_code', 'move_ref', 'line_no', 'line_id',
    'account_id', 'account_code', 'account_name', 'partner_id', 'partner_name', 'line_name', 'debit', 'credit', 'parent_state',
  ];
  return rfc4180Csv(headers, rows.map((row) => [
    row.date, row.rescueMoveId, row.entryNo, row.journalCode, row.ref, row.lineNo, row.rescueLineId,
    row.rescueAccountId, row.accountCode, row.accountName, row.rescuePartnerId, row.partnerName, row.label, row.debit, row.credit, row.parentState,
  ]), [13, 14]);
}
