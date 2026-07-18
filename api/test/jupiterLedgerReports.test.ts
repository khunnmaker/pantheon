import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/prisma.js', () => ({ prisma: {} }));

import { partnerLedger, partnerLedgerCsv, rfc4180Csv } from '../src/jupiter/ledger/reports.js';

function reportLine({
  id, partnerId, date, debit, credit, accountType = 'asset_receivable', partnerName = 'Alpha',
}: {
  id: string; partnerId: string; date: string; debit: string; credit: string;
  accountType?: string; partnerName?: string;
}) {
  return {
    id,
    entryId: `entry-${id}`,
    lineNo: 1,
    accountId: `account-${accountType}`,
    partnerId,
    label: `Line ${id}`,
    debit: new Prisma.Decimal(debit),
    credit: new Prisma.Decimal(credit),
    sourceRef: `TONR:account.move.line:${id.replace(/\D/g, '') || '1'}`,
    entry: {
      entryDate: new Date(`${date}T00:00:00.000Z`), entryNo: `GEN/${date.slice(0, 4)}/${id}`,
      ref: '', state: 'posted', sourceRef: `TONR:account.move:${id.replace(/\D/g, '') || '1'}`,
    },
    account: {
      code: accountType === 'income' ? '4000' : '1100', name: accountType,
      accountType, sourceRef: `TONR:account.account:${accountType === 'income' ? '40' : '11'}`,
    },
    partner: { id: partnerId, displayName: partnerName, sourceRef: `res.partner:${partnerId === 'partner-a' ? '7' : '8'}` },
  };
}

describe('Jupiter ledger reports', () => {
  it('starts each ranged partner ledger at its posted AR/AP opening balance', async () => {
    const client = { jupiterJournalLine: { findMany: vi.fn(async () => [
      reportLine({ id: '1', partnerId: 'partner-a', date: '2026-06-01', debit: '100.00', credit: '0.00' }),
      reportLine({ id: '2', partnerId: 'partner-a', date: '2026-06-02', debit: '999.00', credit: '0.00', accountType: 'income' }),
      reportLine({ id: '3', partnerId: 'partner-a', date: '2026-07-01', debit: '0.00', credit: '30.00' }),
      reportLine({ id: '4', partnerId: 'partner-a', date: '2026-07-02', debit: '5.00', credit: '0.00' }),
      reportLine({ id: '5', partnerId: 'partner-b', partnerName: 'Beta', date: '2026-06-03', debit: '0.00', credit: '40.00', accountType: 'liability_payable' }),
      reportLine({ id: '6', partnerId: 'partner-b', partnerName: 'Beta', date: '2026-07-03', debit: '10.00', credit: '0.00', accountType: 'liability_payable' }),
    ]) } };

    const rows = await partnerLedger({ companyCode: 'TONR', from: '2026-07-01', to: '2026-07-31' }, client as never);
    expect(rows.map((row) => ({ partner: row.partnerId, opening: row.openingBalance, balance: row.balance }))).toEqual([
      { partner: 'partner-a', opening: '100.00', balance: '70.00' },
      { partner: 'partner-a', opening: '100.00', balance: '75.00' },
      { partner: 'partner-b', opening: '-40.00', balance: '-30.00' },
    ]);

    const csv = partnerLedgerCsv(rows, true);
    const dataRows = csv.replace(/^\uFEFF/, '').trim().split('\r\n').slice(1);
    expect(dataRows.map((row) => row.split(',')[0])).toEqual(['opening', 'detail', 'detail', 'opening', 'detail']);
    expect(dataRows[0].split(',')[13]).toBe('100.00');
    expect(dataRows[3].split(',')[13]).toBe('-40.00');
  });

  it('keeps no-from running balances at zero-based openings', async () => {
    const client = { jupiterJournalLine: { findMany: vi.fn(async () => [
      reportLine({ id: '1', partnerId: 'partner-a', date: '2026-06-01', debit: '100.00', credit: '0.00' }),
    ]) } };
    const rows = await partnerLedger({ companyCode: 'TONR' }, client as never);
    expect(rows[0]).toMatchObject({ openingBalance: '0.00', balance: '100.00' });
    expect(partnerLedgerCsv(rows).match(/\r\nopening,/)).toBeNull();
  });

  it('guards formula-like text cells without changing negative amount cells', () => {
    expect(rfc4180Csv(
      ['equals', 'plus', 'minus_text', 'at', 'amount'],
      [['=2+2', '+cmd', '-danger', '@SUM(A1)', '-10.00']],
      [4],
    )).toBe("\uFEFFequals,plus,minus_text,at,amount\r\n'=2+2,'+cmd,'-danger,'@SUM(A1),-10.00\r\n");
  });
});
