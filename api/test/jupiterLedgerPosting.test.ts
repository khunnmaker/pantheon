import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/prisma.js', () => ({ prisma: {} }));

import {
  LedgerPostingError,
  assertAfterLedgerLock,
  parseAccountingDate,
  postJournalEntry,
  reverseJournalEntry,
  setLedgerLockDate,
  validateDraftLines,
  voidJournalEntry,
} from '../src/jupiter/ledger/posting.js';

const actor = { id: 'staff-1', name: 'Synthetic Tester', requestId: 'request-1' };

function line(lineNo: number, debit: string, credit: string, companyCode = 'TONR') {
  return {
    id: `line-${lineNo}`,
    entryId: 'entry-1',
    lineNo,
    accountId: `account-${lineNo}`,
    partnerId: null,
    label: `Synthetic line ${lineNo}`,
    debit: new Prisma.Decimal(debit),
    credit: new Prisma.Decimal(credit),
    amountCurrency: null,
    currencyCode: null,
    maturityDate: null,
    reconciled: false,
    externalReconcileRef: null,
    sourceRef: null,
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    account: { id: `account-${lineNo}`, companyCode },
    partner: null,
    taxes: [],
  };
}

interface EntryState {
  state: string;
  entryNo: string | null;
  version: number;
  voidedAt: Date | null;
}

function makeEntry(overrides: Record<string, unknown> = {}, mutable?: EntryState) {
  const live = mutable ?? { state: 'draft', entryNo: null, version: 1, voidedAt: null };
  return {
    id: 'entry-1',
    companyCode: 'TONR',
    journalId: 'journal-1',
    entryNo: live.entryNo,
    entryDate: new Date('2026-07-18T00:00:00.000Z'),
    state: live.state,
    entryType: 'general',
    ref: '',
    memo: '',
    partnerId: null,
    documentNo: '',
    documentDate: null,
    dueDate: null,
    paymentReference: '',
    paymentState: '',
    taxInvoiceNo: '',
    taxInvoiceDate: null,
    whtCertificateNo: '',
    currencyCode: 'THB',
    version: live.version,
    source: 'manual',
    sourceRef: null,
    sourceSnapshotRef: null,
    contentHash: null,
    originTxnId: null,
    reversalOfId: null,
    createdById: null,
    createdByName: '',
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    updatedAt: new Date('2026-07-18T00:00:00.000Z'),
    postedById: null,
    postedByName: '',
    postedAt: null,
    voidedAt: live.voidedAt,
    company: { code: 'TONR', ledgerMode: 'cockpit', ledgerLockDate: null },
    journal: { id: 'journal-1', companyCode: 'TONR', code: 'GEN' },
    partner: null,
    reversedBy: null,
    lines: [line(1, '100.00', '0.00'), line(2, '0.00', '100.00')],
    ...overrides,
  };
}

function makePostingClient(overrides: Record<string, unknown> = {}) {
  const mutable: EntryState = { state: 'draft', entryNo: null, version: 1, voidedAt: null };
  const audits: Array<Record<string, unknown>> = [];
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (typeof data.state === 'string') mutable.state = data.state;
    if (typeof data.entryNo === 'string') mutable.entryNo = data.entryNo;
    if (data.voidedAt instanceof Date) mutable.voidedAt = data.voidedAt;
    if (data.version) mutable.version += 1;
    return {};
  });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'entry-1' }]),
    jupiterJournalEntry: {
      findUnique: vi.fn(async () => makeEntry(overrides, mutable)),
      update,
    },
    jupiterJournalSequence: { upsert: vi.fn(async () => ({ nextNo: 2 })) },
    jupiterLedgerAudit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
  };
  const client = { $transaction: vi.fn(async (callback) => callback(tx)) };
  return { client, tx, mutable, audits };
}

describe('Jupiter draft posting rules', () => {
  it('accepts exactly balanced two-decimal lines', () => {
    const result = validateDraftLines([
      { lineNo: 1, accountId: 'cash', debit: '100.10', credit: '0.00' },
      { lineNo: 2, accountId: 'equity', debit: '0.00', credit: '100.10' },
    ]);
    expect(result.debitTotal.toFixed(2)).toBe('100.10');
    expect(result.creditTotal.toFixed(2)).toBe('100.10');
  });

  it('rejects a one-satang imbalance, dual-sided lines, and fewer than two nonzero lines', () => {
    expect(() => validateDraftLines([
      { lineNo: 1, accountId: 'cash', debit: '10.00', credit: '0.00' },
      { lineNo: 2, accountId: 'equity', debit: '0.00', credit: '9.99' },
    ])).toThrowError(expect.objectContaining({ code: 'unbalanced_entry' }));
    expect(() => validateDraftLines([
      { lineNo: 1, accountId: 'cash', debit: '1.00', credit: '1.00' },
      { lineNo: 2, accountId: 'equity', debit: '0.00', credit: '0.00' },
    ])).toThrowError(expect.objectContaining({ code: 'invalid_line' }));
    expect(() => validateDraftLines([
      { lineNo: 1, accountId: 'cash', debit: '0.00', credit: '0.00' },
      { lineNo: 2, accountId: 'equity', debit: '0.00', credit: '0.00' },
    ])).toThrowError(expect.objectContaining({ code: 'invalid_line' }));
  });

  it('treats the lock date as inclusive and validates real calendar dates', () => {
    const lock = parseAccountingDate('2026-06-30');
    expect(() => assertAfterLedgerLock(parseAccountingDate('2026-06-30'), lock)).toThrowError(
      expect.objectContaining({ code: 'lock_date_violation' }),
    );
    expect(() => assertAfterLedgerLock(parseAccountingDate('2026-07-01'), lock)).not.toThrow();
    expect(() => parseAccountingDate('2026-02-30')).toThrowError(
      expect.objectContaining({ code: 'invalid_entry_date' }),
    );
  });

  it('posts atomically with a journal sequence and an audit row', async () => {
    const { client, tx, mutable, audits } = makePostingClient();
    const posted = await postJournalEntry('entry-1', actor, client as never);
    expect(posted.state).toBe('posted');
    expect(mutable.entryNo).toBe('GEN/2026/000001');
    expect(tx.jupiterJournalSequence.upsert).toHaveBeenCalledOnce();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'post', entityId: 'entry-1', actorId: 'staff-1' });
  });

  it('rejects cross-company accounts, paper-only companies, and locked entries before writing', async () => {
    for (const overrides of [
      { lines: [line(1, '100.00', '0.00', 'DENC'), line(2, '0.00', '100.00')] },
      { company: { code: 'APPT', ledgerMode: 'paper_only', ledgerLockDate: null } },
      { company: { code: 'TONR', ledgerMode: 'cockpit', ledgerLockDate: new Date('2026-07-18T00:00:00.000Z') } },
    ]) {
      const { client, tx } = makePostingClient(overrides);
      await expect(postJournalEntry('entry-1', actor, client as never)).rejects.toBeInstanceOf(LedgerPostingError);
      expect(tx.jupiterJournalEntry.update).not.toHaveBeenCalled();
    }
  });

  it('voids drafts with an audit row and never permits posted voids', async () => {
    const draft = makePostingClient();
    const result = await voidJournalEntry('entry-1', 'duplicate', actor, draft.client as never);
    expect(result.state).toBe('void');
    expect(draft.audits[0]).toMatchObject({ action: 'void', reason: 'duplicate' });

    const posted = makePostingClient();
    posted.mutable.state = 'posted';
    await expect(voidJournalEntry('entry-1', '', actor, posted.client as never)).rejects.toMatchObject({
      code: 'entry_not_draft',
    });
  });

  it('requires a reason before attempting a reversal', async () => {
    await expect(reverseJournalEntry('entry-1', '2026-07-19', '  ', actor, {} as never)).rejects.toMatchObject({
      code: 'reason_required',
    });
  });

  it('creates a balanced swapped-line reversal, posts it, and audits both actions', async () => {
    let reversalState = 'draft';
    let reversalNo: string | null = null;
    let reversalLines: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const original = makeEntry({ state: 'posted', entryNo: 'GEN/2026/000001' });
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'entry-1' }]),
      jupiterJournalEntry: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === 'entry-1') return original;
          return makeEntry({
            id: 'reversal-1',
            state: reversalState,
            entryNo: reversalNo,
            reversalOfId: 'entry-1',
            entryDate: new Date('2026-07-19T00:00:00.000Z'),
            lines: reversalLines.map((row, index) => ({
              ...line(index + 1, '0.00', '0.00'),
              ...row,
              id: `reversal-line-${index + 1}`,
              entryId: 'reversal-1',
              account: { id: row.accountId, companyCode: 'TONR' },
              partner: null,
              taxes: [],
            })),
          });
        }),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          reversalLines = data.lines.create;
          return { id: 'reversal-1' };
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.state === 'string') reversalState = data.state;
          if (typeof data.entryNo === 'string') reversalNo = data.entryNo;
          return {};
        }),
      },
      jupiterJournalSequence: { upsert: vi.fn(async () => ({ nextNo: 2 })) },
      jupiterLedgerAudit: { create: vi.fn(async ({ data }) => { audits.push(data); }) },
    };
    const client = { $transaction: vi.fn(async (callback) => callback(tx)) };

    const result = await reverseJournalEntry('entry-1', '2026-07-19', 'correct synthetic error', actor, client as never);
    expect(result.state).toBe('posted');
    expect(reversalLines[0]).toMatchObject({ debit: new Prisma.Decimal('0.00'), credit: new Prisma.Decimal('100.00') });
    expect(reversalLines[1]).toMatchObject({ debit: new Prisma.Decimal('100.00'), credit: new Prisma.Decimal('0.00') });
    expect(audits.map((audit) => audit.action)).toEqual(['reverse', 'post']);
  });

  it('requires a reason to move a manual company lock backward and audits a forward move', async () => {
    const audits: Array<Record<string, unknown>> = [];
    let current = new Date('2026-06-30T00:00:00.000Z');
    const tx = {
      $queryRaw: vi.fn(async () => [{ code: 'TONR' }]),
      jupiterCompany: {
        findUnique: vi.fn(async () => ({ code: 'TONR', ledgerLockDate: current })),
        update: vi.fn(async ({ data }) => { current = data.ledgerLockDate; }),
      },
      jupiterLedgerAudit: { create: vi.fn(async ({ data }) => { audits.push(data); }) },
    };
    const client = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(setLedgerLockDate('TONR', '2026-05-31', '', actor, client as never)).rejects.toMatchObject({
      code: 'reason_required',
    });
    await setLedgerLockDate('TONR', '2026-07-31', '', actor, client as never);
    expect(audits[0]).toMatchObject({ action: 'lock_change', entityType: 'company_lock' });
  });
});
