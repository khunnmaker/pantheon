import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OdooImportError, accountClassFromOdooType, canonicalizeSourceObject, importOdooSnapshot,
  importedEntryAction, many2oneId, seedImportedJournalSequences, sourceContentHash,
} from '../src/jupiter/ledger/importOdoo.js';

const temporary: string[] = [];

async function syntheticSnapshot(companyId = 2, firstDebit: string | number = '10.00') {
  const root = await mkdtemp(join(tmpdir(), 'jupiter-odoo-synthetic-'));
  temporary.push(root);
  const company = join(root, 'TONR');
  await mkdir(company);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ status: 'complete', schemaVersion: 1, errors: [], failures: [] }));
  await writeFile(join(root, 'res_partner.jsonl'), `${JSON.stringify({ id: 7, name: 'Synthetic Partner', vat: '0000000000000' })}\n`);
  const rows = {
    account_account: [{ id: 10, company_ids: [companyId], code: '00100', name: 'Synthetic cash', account_type: 'asset_cash', reconcile: false }],
    account_journal: [{ id: 20, company_id: [companyId, 'TONR'], code: 'GEN', name: 'Synthetic journal', type: 'general', default_account_id: [10, '00100'] }],
    account_tax: [{ id: 30, company_id: [companyId, 'TONR'], name: 'Synthetic tax', amount: '7.000000', type_tax_use: 'purchase' }],
    account_move: [{ id: 40, company_id: [companyId, 'TONR'], journal_id: [20, 'GEN'], name: '/', date: '2026-07-18', state: 'draft' }],
    account_move_line: [
      { id: 50, company_id: [companyId, 'TONR'], move_id: [40, '/'], journal_id: [20, 'GEN'], account_id: [10, '00100'], debit: firstDebit, credit: '0.00', parent_state: 'draft', tax_ids: [] },
      { id: 51, company_id: [companyId, 'TONR'], move_id: [40, '/'], journal_id: [20, 'GEN'], account_id: [10, '00100'], debit: '0.00', credit: '10.00', parent_state: 'draft', tax_ids: [] },
    ],
  };
  for (const [name, records] of Object.entries(rows)) {
    await writeFile(join(company, `${name}.jsonl`), `${records.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }
  const tb = 'account_id,account_code,account_name,debit,credit,balance,line_count\r\n';
  await writeFile(join(company, 'trial_balance_client.csv'), tb);
  await writeFile(join(company, 'trial_balance_server.csv'), tb);
  await writeFile(join(company, 'partner_ledger.csv'), 'row_type,partner_id,partner_name,date,move_id,move_name,move_ref,account_id,account_code,account_name,line_name,debit,credit,balance,line_id,parent_state\r\n');
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Odoo rescue importer', () => {
  it('normalizes mixed many2one values and preserves account classification', () => {
    expect(many2oneId([22, 'Synthetic'])).toBe(22);
    expect(many2oneId(false)).toBeNull();
    expect(accountClassFromOdooType('liability_payable')).toBe('liability');
    expect(accountClassFromOdooType('expense_direct_cost')).toBe('expense');
  });

  it('canonicalizes source objects for stable content-hash idempotency', () => {
    expect(canonicalizeSourceObject({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(sourceContentHash({ a: 1, b: 2 })).toBe(sourceContentHash({ b: 2, a: 1 }));
    const hash = sourceContentHash({ id: 40, state: 'draft' });
    expect(importedEntryAction(null, hash)).toBe('insert');
    expect(importedEntryAction({ state: 'posted', contentHash: hash }, hash)).toBe('noop');
    expect(importedEntryAction({ state: 'draft', contentHash: 'old' }, hash)).toBe('update');
  });

  it('fails changed posted sources with posted_source_conflict', () => {
    expect(() => importedEntryAction({ state: 'posted', contentHash: 'old' }, 'new')).toThrowError(
      expect.objectContaining({ code: 'posted_source_conflict' }),
    );
  });

  it('dry-runs a synthetic extract-shaped snapshot without database writes', async () => {
    const root = await syntheticSnapshot();
    const result = await importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false });
    expect(result).toMatchObject({ dryRun: true, partners: 1, companies: { TONR: { accounts: 1, moves: 1, lines: 2 } } });
  });

  it('rejects an account whose company_ids disagree with its folder mapping', async () => {
    const root = await syntheticSnapshot(3);
    await expect(importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false })).rejects.toEqual(
      expect.objectContaining<Partial<OdooImportError>>({ code: 'company_mapping_mismatch' }),
    );
  });

  it('rejects numeric source amounts and names the offending record', async () => {
    const root = await syntheticSnapshot(2, 10);
    await expect(importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false })).rejects.toMatchObject({
      code: 'invalid_money',
      message: expect.stringContaining('account.move.line:50 debit'),
    });
  });

  it('seeds each imported journal-year sequence past its maximum numeric suffix', async () => {
    const create = vi.fn(async () => ({}));
    const update = vi.fn(async () => ({}));
    const tx = {
      jupiterJournalEntry: { findMany: vi.fn(async () => [
        { journalId: 'journal-1', entryDate: new Date('2026-01-02T00:00:00.000Z'), entryNo: 'GEN/2026/000041' },
        { journalId: 'journal-1', entryDate: new Date('2026-12-31T00:00:00.000Z'), entryNo: 'MISC-105' },
        { journalId: 'journal-1', entryDate: new Date('2025-12-31T00:00:00.000Z'), entryNo: 'GEN/2025/000007' },
        { journalId: 'journal-2', entryDate: new Date('2026-07-18T00:00:00.000Z'), entryNo: 'BNK/2026/000009' },
        { journalId: 'journal-2', entryDate: new Date('2026-07-18T00:00:00.000Z'), entryNo: 'NO-NUMBER' },
      ]) },
      jupiterJournalSequence: {
        findUnique: vi.fn(async ({ where }) => {
          const { journalId, fiscalYear } = where.companyCode_journalId_fiscalYear;
          if (journalId === 'journal-1' && fiscalYear === 2026) return { nextNo: 200 };
          if (journalId === 'journal-1' && fiscalYear === 2025) return { nextNo: 4 };
          return null;
        }),
        create,
        update,
      },
    };

    await seedImportedJournalSequences(tx as never, 'TONR');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { nextNo: 8 } }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: { companyCode: 'TONR', journalId: 'journal-2', fiscalYear: 2026, nextNo: 10 },
    }));
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { nextNo: 106 } }));
  });
});
