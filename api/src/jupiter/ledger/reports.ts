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
      ...(filters.partnerId ? { partnerId: filters.partnerId } : {}),
      account: { accountType: { in: ['asset_receivable', 'liability_payable'] } },
      entry: {
        companyCode: filters.companyCode,
        state: 'posted',
        ...(filters.to ? { entryDate: { lte: parseAccountingDate(filters.to) } } : {}),
      },
    },
    include: { entry: { include: { journal: true } }, account: true, partner: true },
    orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { entryNo: 'asc' } }, { lineNo: 'asc' }],
  });
  // Rescue exports account.move.line by ascending source ID. Reproduce that order for
  // imported rows; native Jupiter rows retain the deterministic accounting-date order above.
  const eligibleLines = lines.filter((line) =>
    line.account.accountType === 'asset_receivable' || line.account.accountType === 'liability_payable');
  eligibleLines.sort((left, right) => {
    const leftId = left.sourceRef?.match(/:(\d+)$/)?.[1];
    const rightId = right.sourceRef?.match(/:(\d+)$/)?.[1];
    return leftId && rightId ? Number(leftId) - Number(rightId) : 0;
  });
  const from = filters.from ? parseAccountingDate(filters.from) : null;
  const openings = new Map<string, Prisma.Decimal>();
  const periodLines = eligibleLines.filter((line) => {
    if (!from || line.entry.entryDate >= from) return true;
    const key = line.partnerId ?? '';
    const opening = (openings.get(key) ?? new Prisma.Decimal(0)).plus(line.debit).minus(line.credit);
    openings.set(key, opening);
    return false;
  });
  const balances = new Map(openings);
  return periodLines.map((line) => {
    const key = line.partnerId ?? '';
    const opening = openings.get(key) ?? new Prisma.Decimal(0);
    const lineBalance = line.debit.minus(line.credit);
    // The rescue CSV's unbounded `balance` is Odoo account.move.line.balance (the
    // signed value of that line). Ranged calls retain Jupiter's opening/running balance.
    const balance = from ? (balances.get(key) ?? opening).plus(lineBalance) : lineBalance;
    balances.set(key, balance);
    return {
      rowType: 'detail',
      partnerId: line.partnerId,
      rescuePartnerId: line.partner ? rescueId(line.partner.sourceRef, line.partner.id) : null,
      partnerName: line.partner?.displayName ?? '(No partner)',
      date: accountingDateString(line.entry.entryDate),
      moveId: line.entryId,
      rescueMoveId: rescueId(line.entry.sourceRef, line.entryId),
      moveName: line.entry.entryNo,
      moveRef: line.entry.ref,
      journalName: line.entry.journal.name,
      accountId: line.accountId,
      rescueAccountId: rescueId(line.account.sourceRef, line.accountId),
      accountCode: line.account.code,
      accountName: line.account.name,
      accountType: line.account.accountType,
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
    'row_type', 'partner_id', 'partner_name', 'date', 'move_name', 'ref', 'journal_name',
    'account_code', 'account_name', 'account_type', 'label', 'debit', 'credit', 'balance', 'line_id', 'parent_state',
  ];
  const csvRows: unknown[][] = [];
  const seenPartners = new Set<string>();
  const totals = new Map<string, {
    partnerId: string | null; partnerName: string; debit: Prisma.Decimal; credit: Prisma.Decimal;
    balance: Prisma.Decimal; lines: number;
  }>();
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
      row.rowType, row.rescuePartnerId, row.partnerName, row.date, row.moveName, row.moveRef, row.journalName,
      row.accountCode, row.accountName, row.accountType, row.lineName, row.debit, row.credit, row.balance,
      row.rescueLineId, row.parentState,
    ]);
    const total = totals.get(partnerKey) ?? {
      partnerId: row.rescuePartnerId, partnerName: row.partnerName,
      debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0), balance: new Prisma.Decimal(0), lines: 0,
    };
    total.debit = total.debit.plus(row.debit);
    total.credit = total.credit.plus(row.credit);
    total.balance = total.balance.plus(new Prisma.Decimal(row.debit).minus(row.credit));
    total.lines += 1;
    totals.set(partnerKey, total);
  }
  for (const total of [...totals.values()].sort((left, right) =>
    left.partnerName.localeCompare(right.partnerName, 'th')
    || Number(left.partnerId ?? 0) - Number(right.partnerId ?? 0))) {
    csvRows.push([
      'partner_total', total.partnerId, total.partnerName, '', '', '', '', '', '', '', `${total.lines} line(s)`,
      moneyToString(total.debit), moneyToString(total.credit), moneyToString(total.balance), '', 'posted',
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
