import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OdooImportError, accountClassFromOdooType, canonicalizeSourceObject, importOdooSnapshot,
  entryNameFields, importedEntryAction, lineNameFields, many2oneId, parseOdooNameMapping,
  partnerNameFields, seedImportedJournalSequences, sourceContentHash, sourceMoney,
  validateOdooNameMapping,
} from '../src/jupiter/ledger/importOdoo.js';
import { parseImportArgs } from '../src/scripts/importOdooRescue.js';

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
    account_move: [{ id: 40, company_id: [companyId, 'TONR'], journal_id: [20, 'GEN'], name: '/', date: '2026-07-18', state: 'draft', narration: 'Raw memo', ref: 'Raw ref' }],
    account_move_line: [
      { id: 50, company_id: [companyId, 'TONR'], move_id: [40, '/'], journal_id: [20, 'GEN'], account_id: [10, '00100'], name: 'Raw line', debit: firstDebit, credit: '0.00', parent_state: 'draft', tax_ids: [] },
      { id: 51, company_id: [companyId, 'TONR'], move_id: [40, '/'], journal_id: [20, 'GEN'], account_id: [10, '00100'], name: 'Already clean', debit: '0.00', credit: '10.00', parent_state: 'draft', tax_ids: [] },
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

  it('applies harmonized names, preserves changed originals, and leaves unchanged originals null', () => {
    const mapping = parseOdooNameMapping({
      partners: { 'res.partner:7': 'คู่ค้าทดสอบ' },
      entries: { 'TONR:account.move:40': { memo: 'รายการทดสอบ', ref: 'Raw ref' } },
      lines: { 'TONR:account.move.line:50': 'รายละเอียดทดสอบ', 'TONR:account.move.line:51': 'Already clean' },
    });
    expect(partnerNameFields({ id: 7, name: 'Synthetic Partner' }, mapping)).toEqual({
      displayName: 'คู่ค้าทดสอบ', nameOriginal: 'Synthetic Partner',
    });
    expect(entryNameFields('TONR', { id: 40, narration: 'Raw memo', ref: 'Raw ref' }, mapping)).toEqual({
      memo: 'รายการทดสอบ', memoOriginal: 'Raw memo', ref: 'Raw ref', refOriginal: null,
    });
    expect(lineNameFields('TONR', { id: 50, name: 'Raw line' }, mapping)).toEqual({
      label: 'รายละเอียดทดสอบ', labelOriginal: 'Raw line',
    });
    expect(lineNameFields('TONR', { id: 51, name: 'Already clean' }, mapping)).toEqual({
      label: 'Already clean', labelOriginal: null,
    });
  });

  it('parses --names and rejects unknown mapping fields', () => {
    expect(parseImportArgs([
      '--snapshot', 'snapshot', '--companies', 'TONR,DENC', '--names', 'mapping.json', '--dry-run',
    ])).toMatchObject({ snapshotPath: 'snapshot', companies: ['TONR', 'DENC'], namesPath: 'mapping.json', apply: false });
    expect(() => parseOdooNameMapping({ partners: {}, entries: {}, lines: {}, accounts: {} })).toThrowError(
      expect.objectContaining({ code: 'invalid_name_mapping' }),
    );
    expect(() => parseOdooNameMapping({
      partners: {}, entries: { 'TONR:account.move:40': { label: 'wrong field' } }, lines: {},
    })).toThrowError(expect.objectContaining({ code: 'invalid_name_mapping' }));
  });

  it('counts validated no-op mapping rows in the rename summary', () => {
    const mapping = parseOdooNameMapping({
      partners: {}, entries: {}, lines: { 'TONR:account.move.line:51': 'Already clean' },
    });
    const source = new Map([['TONR', { moves: [], lines: [{ id: 51, name: 'Already clean' }] }]]);
    expect(validateOdooNameMapping(mapping, [], source as never)).toEqual({ partners: 0, entries: 0, lines: 1 });
  });

  it('keeps raw source hashes stable under --names and reports dry-run rename counts', async () => {
    const root = await syntheticSnapshot();
    const namesPath = join(root, 'names.json');
    await writeFile(namesPath, JSON.stringify({
      partners: { 'res.partner:7': 'คู่ค้าทดสอบ' },
      entries: { 'TONR:account.move:40': { memo: 'รายการทดสอบ' } },
      lines: { 'TONR:account.move.line:50': 'รายละเอียดทดสอบ' },
    }));
    const withoutNames = await importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false });
    const withNames = await importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false, namesPath });
    expect(withNames).toMatchObject({ renames: { partners: 1, entries: 1, lines: 1 } });
    expect(withNames.companies).toEqual(withoutNames.companies);

    const rawMove = { id: 40, narration: 'Raw memo', ref: 'Raw ref' };
    const before = sourceContentHash(rawMove);
    entryNameFields('TONR', rawMove, parseOdooNameMapping({
      partners: {}, entries: { 'TONR:account.move:40': { memo: 'รายการทดสอบ' } }, lines: {},
    }));
    expect(sourceContentHash(rawMove)).toBe(before);
  });

  it('rejects unknown name mapping references loudly', async () => {
    const root = await syntheticSnapshot();
    const namesPath = join(root, 'names.json');
    await writeFile(namesPath, JSON.stringify({ partners: {}, entries: {}, lines: { 'TONR:account.move.line:999': 'Unknown' } }));
    await expect(importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false, namesPath })).rejects.toMatchObject({
      code: 'unknown_name_mapping_key',
      message: expect.stringContaining('TONR:account.move.line:999'),
    });
  });

  it('rejects an account whose company_ids disagree with its folder mapping', async () => {
    const root = await syntheticSnapshot(3);
    await expect(importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false })).rejects.toEqual(
      expect.objectContaining<Partial<OdooImportError>>({ code: 'company_mapping_mismatch' }),
    );
  });

  it('accepts exact two-decimal numeric source amounts', async () => {
    const root = await syntheticSnapshot(2, 10);
    await expect(importOdooSnapshot({ snapshotPath: root, companies: ['TONR'], apply: false })).resolves.toMatchObject({
      dryRun: true,
    });
    expect(sourceMoney(10.25).toFixed(2)).toBe('10.25');
  });

  it.each([10.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e13])(
    'rejects unsafe numeric source amount %s and names the offending field',
    (value) => {
      expect(() => sourceMoney(value, 'account.move.line:50 debit')).toThrowError(expect.objectContaining({
        code: 'invalid_money',
        message: expect.stringContaining('account.move.line:50 debit'),
      }));
    },
  );

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
