import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';

import { moneyToString, parseMoney } from './money.js';
import type { LedgerCompanyCode } from './types.js';

export const ODOO_IMPORT_SOURCE = 'sync:odoo';
export const ODOO_COMPANY_MAP = {
  1: 'APPT', 2: 'TONR', 3: 'DENC', 4: 'PROM', 5: 'DENL', 6: 'KPKF',
} as const satisfies Record<number, LedgerCompanyCode>;

type SourceRow = Record<string, unknown>;
type ImportCompanyCode = (typeof ODOO_COMPANY_MAP)[keyof typeof ODOO_COMPANY_MAP];
type LedgerTx = Prisma.TransactionClient;
type LedgerReports = typeof import('./reports.js');

export class OdooImportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OdooImportError';
  }
}

export interface OdooSnapshotPreflight {
  snapshotPath: string;
  snapshotRef: string;
  manifest: SourceRow;
  manifestSha256: string;
  partnerFile: string;
  companyFiles: Map<ImportCompanyCode, Record<
    'accounts' | 'journals' | 'taxes' | 'moves' | 'lines' | 'trialBalanceClient' | 'trialBalanceServer' | 'partnerLedger', string
  >>;
}

export interface ImportOdooOptions {
  snapshotPath: string;
  companies: ImportCompanyCode[];
  apply: boolean;
  createdByName?: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as SourceRow)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function canonicalizeSourceObject(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sourceContentHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeSourceObject(value), 'utf8').digest('hex');
}

export function importedEntryAction(
  existing: { state: string; contentHash: string | null } | null,
  incomingHash: string,
): 'insert' | 'noop' | 'update' {
  if (!existing) return 'insert';
  if (existing.contentHash === incomingHash) return 'noop';
  if (existing.state === 'posted') {
    throw new OdooImportError('posted_source_conflict', 'A posted imported source changed');
  }
  return 'update';
}

export function many2oneId(value: unknown): number | null {
  if (value === false || value === null || value === undefined || value === '') return null;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
  if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  throw new OdooImportError('invalid_many2one', `Invalid Odoo many2one value: ${JSON.stringify(value)}`);
}

function requiredId(row: SourceRow, model: string): number {
  const id = many2oneId(row.id);
  if (id === null) throw new OdooImportError('invalid_source_row', `${model} row has no integer id`);
  return id;
}

function text(value: unknown, fallback = ''): string {
  return value === false || value === null || value === undefined ? fallback : String(value);
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const dateText = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new OdooImportError('invalid_source_row', `Invalid Odoo accounting date: ${raw}`);
  }
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) {
    throw new OdooImportError('invalid_source_row', `Invalid Odoo accounting date: ${raw}`);
  }
  return date;
}

function sourceMoney(value: unknown, record = 'Odoo record', fallback = '0.00'): Prisma.Decimal {
  if (value === false || value === null || value === undefined || value === '') return parseMoney(fallback);
  if (typeof value !== 'string') {
    throw new OdooImportError(
      'invalid_money',
      `${record} has a non-string money value (${typeof value}): ${JSON.stringify(value)}`,
    );
  }
  return parseMoney(value);
}

function sourceRate(value: unknown): Prisma.Decimal {
  const raw = value === false || value === null || value === undefined || value === '' ? '0' : String(value);
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(raw)) throw new OdooImportError('invalid_tax_rate', `Invalid Odoo tax rate ${raw}`);
  const rate = new Prisma.Decimal(raw);
  if (rate.abs().greaterThanOrEqualTo('1000')) throw new OdooImportError('invalid_tax_rate', `Odoo tax rate out of range ${raw}`);
  return rate;
}

export function accountClassFromOdooType(accountType: string): string {
  if (accountType === 'off_balance') return 'off_balance';
  if (accountType.startsWith('asset')) return 'asset';
  if (accountType.startsWith('liability')) return 'liability';
  if (accountType.startsWith('equity')) return 'equity';
  if (accountType.startsWith('income')) return 'income';
  if (accountType.startsWith('expense')) return 'expense';
  throw new OdooImportError('unknown_account_type', `Unknown Odoo account_type ${accountType}`);
}

function companyIdForCode(code: ImportCompanyCode): number {
  const pair = Object.entries(ODOO_COMPANY_MAP).find(([, mapped]) => mapped === code);
  if (!pair) throw new OdooImportError('unknown_company', `Unknown company ${code}`);
  return Number(pair[0]);
}

export function assertRowCompany(row: SourceRow, companyCode: ImportCompanyCode, model: string): void {
  const expected = companyIdForCode(companyCode);
  if (model === 'account.account') {
    const rawCompanyIds = row.company_ids;
    const actual = Array.isArray(rawCompanyIds)
      ? rawCompanyIds.map((value) => many2oneId(value)).filter((id): id is number => id !== null)
      : [];
    if (actual.length !== 1 || actual[0] !== expected) {
      throw new OdooImportError(
        'company_mapping_mismatch',
        `${model}:${text(row.id, '?')} in ${companyCode} has company_ids ${JSON.stringify(rawCompanyIds ?? [])}; expected [${expected}]`,
      );
    }
    return;
  }
  const actual = many2oneId(row.company_id);
  if (actual !== expected) {
    throw new OdooImportError(
      'company_mapping_mismatch',
      `${model}:${text(row.id, '?')} in ${companyCode} has company_id ${actual ?? 'missing'}; expected ${expected}`,
    );
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(path));
    else found.push(path);
  }
  return found;
}

const FILE_NAMES = {
  partners: ['res_partner.jsonl', 'res.partner.jsonl', 'partners.jsonl'],
  accounts: ['account_account.jsonl', 'account.account.jsonl', 'accounts.jsonl'],
  journals: ['account_journal.jsonl', 'account.journal.jsonl', 'journals.jsonl'],
  taxes: ['account_tax.jsonl', 'account.tax.jsonl', 'taxes.jsonl'],
  moves: ['account_move.jsonl', 'account.move.jsonl', 'moves.jsonl'],
  lines: ['account_move_line.jsonl', 'account.move.line.jsonl', 'move_lines.jsonl', 'lines.jsonl'],
  trialBalanceClient: ['trial_balance_client.csv'],
  trialBalanceServer: ['trial_balance_server.csv'],
  partnerLedger: ['partner_ledger.csv', 'partner_ledger_client.csv'],
} as const;

function matchesName(path: string, names: readonly string[]): boolean {
  return names.includes(basename(path).toLowerCase());
}

function companyPathMatch(path: string, snapshotPath: string, code: string): boolean {
  const normalized = relative(snapshotPath, path).replace(/\\/g, '/').toUpperCase();
  const companyId = companyIdForCode(code as ImportCompanyCode);
  return normalized.split('/').slice(0, -1).some((segment) =>
    segment === code || segment.startsWith(`${code}_`) || segment.endsWith(`_${code}`)
    || segment.includes(`-${code}-`) || segment === String(companyId)
    || segment === `COMPANY_${companyId}` || segment.startsWith(`${companyId}_${code}`));
}

function manifestIssues(manifest: SourceRow): string[] {
  const issues: string[] = [];
  const status = text(manifest.status).toLowerCase();
  if (status !== 'complete' && manifest.complete !== true) issues.push('manifest status is not complete');
  for (const key of ['errors', 'failures'] as const) {
    const value = manifest[key];
    if (Array.isArray(value) && value.length) issues.push(`manifest has ${key}`);
    else if (typeof value === 'number' && value !== 0) issues.push(`manifest has ${value} ${key}`);
  }
  const verification = manifest.verification;
  if (verification && typeof verification === 'object') {
    for (const key of ['errors', 'failures'] as const) {
      const value = (verification as SourceRow)[key];
      if ((Array.isArray(value) && value.length) || (typeof value === 'number' && value !== 0)) {
        issues.push(`manifest verification has ${key}`);
      }
    }
  }
  const version = manifest.schemaVersion ?? manifest.schema_version ?? manifest.formatVersion;
  if (version !== undefined && ![1, '1', 'odoo-rescue-v1'].includes(version as never)) {
    issues.push(`unsupported manifest schema version ${String(version)}`);
  }
  return issues;
}

export async function preflightOdooSnapshot(
  snapshotPath: string,
  companies: readonly ImportCompanyCode[],
): Promise<OdooSnapshotPreflight> {
  const absolute = resolve(snapshotPath);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) throw new OdooImportError('snapshot_not_found', `Snapshot directory not found: ${absolute}`);
  const manifestPath = resolve(absolute, 'manifest.json');
  const manifestBytes = await readFile(manifestPath).catch(() => null);
  if (!manifestBytes) throw new OdooImportError('manifest_missing', 'manifest.json is required');
  let manifest: SourceRow;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as SourceRow; }
  catch { throw new OdooImportError('manifest_invalid', 'manifest.json is not valid JSON'); }
  const issues = manifestIssues(manifest);
  if (issues.length) throw new OdooImportError('manifest_incomplete', issues.join('; '));

  const allFiles = await filesBelow(absolute);
  const listedFiles = Array.isArray(manifest.files)
    ? manifest.files.map((item) => typeof item === 'string' ? item : text((item as SourceRow)?.path)).filter(Boolean)
    : [];
  for (const listed of listedFiles) {
    const target = resolve(absolute, listed);
    const relativeTarget = relative(absolute, target);
    if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
      throw new OdooImportError('manifest_invalid', `Manifest file escapes snapshot: ${listed}`);
    }
    if (!allFiles.includes(target)) throw new OdooImportError('expected_file_missing', `Manifest file is missing: ${listed}`);
  }
  const partnerFile = allFiles.find((path) => matchesName(path, FILE_NAMES.partners));
  if (!partnerFile) throw new OdooImportError('expected_file_missing', 'Global res.partner JSONL is missing');
  const companyFiles = new Map<ImportCompanyCode, Record<
    'accounts' | 'journals' | 'taxes' | 'moves' | 'lines' | 'trialBalanceClient' | 'trialBalanceServer' | 'partnerLedger', string
  >>();
  for (const company of companies) {
    const record = {} as Record<
      'accounts' | 'journals' | 'taxes' | 'moves' | 'lines' | 'trialBalanceClient' | 'trialBalanceServer' | 'partnerLedger', string
    >;
    for (const kind of [
      'accounts', 'journals', 'taxes', 'moves', 'lines', 'trialBalanceClient', 'trialBalanceServer', 'partnerLedger',
    ] as const) {
      const candidates = allFiles.filter((path) => matchesName(path, FILE_NAMES[kind]) && companyPathMatch(path, absolute, company));
      if (candidates.length !== 1) {
        throw new OdooImportError('expected_file_missing', `Expected one ${company} ${kind} JSONL, found ${candidates.length}`);
      }
      record[kind] = candidates[0];
    }
    companyFiles.set(company, record);
  }
  return {
    snapshotPath: absolute,
    snapshotRef: basename(absolute),
    manifest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    partnerFile,
    companyFiles,
  };
}

export function parseRfc4180Csv(rawInput: string): SourceRow[] {
  const raw = rawInput.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (char === '"' && raw[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { record.push(field); field = ''; }
    else if (char === '\n') { record.push(field.replace(/\r$/, '')); records.push(record); record = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new OdooImportError('invalid_csv', 'Unterminated quoted CSV field');
  if (field || record.length) { record.push(field.replace(/\r$/, '')); records.push(record); }
  const [headers, ...rows] = records.filter((row) => row.some((cell) => cell !== ''));
  if (!headers?.length) throw new OdooImportError('invalid_csv', 'CSV has no header');
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function csvMoney(value: unknown): string {
  return moneyToString(sourceMoney(text(value).replace(/,/g, '')));
}

function compareTrialBalance(
  expected: SourceRow[],
  actual: Awaited<ReturnType<LedgerReports['trialBalance']>>,
) {
  const actualById = new Map(actual.map((row) => [row.rescueAccountId, row]));
  const differences: string[] = [];
  for (const row of expected) {
    const id = text(row.account_id);
    const found = actualById.get(id);
    if (!found) { differences.push(`missing account_id ${id}`); continue; }
    for (const [sourceKey, actualValue] of [
      ['debit', found.periodDebit], ['credit', found.periodCredit], ['balance', found.closingBalance],
    ] as const) {
      if (csvMoney(row[sourceKey]) !== actualValue) differences.push(`${id} ${sourceKey}`);
    }
    if (Number(row.line_count) !== found.lineCount) differences.push(`${id} line_count`);
    actualById.delete(id);
  }
  for (const id of actualById.keys()) differences.push(`unexpected account_id ${id}`);
  return { matched: differences.length === 0, differences };
}

function sumRows(rows: readonly { debit: string; credit: string }[]) {
  return rows.reduce((sum, row) => ({
    debit: sum.debit.plus(parseMoney(row.debit)), credit: sum.credit.plus(parseMoney(row.credit)),
  }), { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) });
}

function comparePartnerLedger(
  expectedRows: SourceRow[],
  actual: Awaited<ReturnType<LedgerReports['partnerLedger']>>,
) {
  const expected = expectedRows.filter((row) => !row.row_type || text(row.row_type).toLowerCase() === 'detail');
  const actualByLine = new Map(actual.map((row) => [row.rescueLineId, row]));
  const differences: string[] = [];
  for (const row of expected) {
    const lineId = text(row.line_id);
    const found = actualByLine.get(lineId);
    if (!found) { differences.push(`missing line_id ${lineId}`); continue; }
    for (const [sourceKey, actualValue] of [
      ['debit', found.debit], ['credit', found.credit], ['balance', found.balance],
    ] as const) {
      if (csvMoney(row[sourceKey]) !== actualValue) differences.push(`${lineId} ${sourceKey}`);
    }
    for (const [sourceKey, actualValue] of [
      ['partner_id', found.rescuePartnerId], ['move_id', found.rescueMoveId], ['account_id', found.rescueAccountId], ['parent_state', found.parentState],
    ] as const) {
      if (text(row[sourceKey]) !== text(actualValue)) differences.push(`${lineId} ${sourceKey}`);
    }
    actualByLine.delete(lineId);
  }
  for (const id of actualByLine.keys()) differences.push(`unexpected line_id ${id}`);
  const expectedTotal = expected.reduce<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>((sum, row) => ({
    debit: sum.debit.plus(sourceMoney(text(row.debit).replace(/,/g, ''))),
    credit: sum.credit.plus(sourceMoney(text(row.credit).replace(/,/g, ''))),
  }), { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) });
  const actualTotal = sumRows(actual);
  if (!expectedTotal.debit.equals(actualTotal.debit)) differences.push('total debit');
  if (!expectedTotal.credit.equals(actualTotal.credit)) differences.push('total credit');
  return { matched: differences.length === 0, differences };
}

function uniqueIds(rows: SourceRow[], model: string): Set<number> {
  const ids = rows.map((row) => requiredId(row, model));
  if (new Set(ids).size !== ids.length) throw new OdooImportError('duplicate_source_id', `${model} contains duplicate IDs`);
  return new Set(ids);
}

function validateSourceCompany(
  company: ImportCompanyCode,
  rows: {
    accounts: SourceRow[]; journals: SourceRow[]; taxes: SourceRow[]; moves: SourceRow[]; lines: SourceRow[];
  },
  partnerIds: Set<number>,
) {
  const accountIds = uniqueIds(rows.accounts, 'account.account');
  const journalIds = uniqueIds(rows.journals, 'account.journal');
  const taxIds = uniqueIds(rows.taxes, 'account.tax');
  const moveIds = uniqueIds(rows.moves, 'account.move');
  uniqueIds(rows.lines, 'account.move.line');
  const accountCodes = new Set<string>();
  for (const row of rows.accounts) {
    assertRowCompany(row, company, 'account.account');
    const mapped = accountData(row, company);
    if (!mapped.data.code || accountCodes.has(mapped.data.code)) {
      throw new OdooImportError('invalid_source_row', `${company} account code is missing or duplicated: ${mapped.data.code}`);
    }
    accountCodes.add(mapped.data.code);
  }
  for (const row of rows.journals) {
    assertRowCompany(row, company, 'account.journal');
    const defaultAccount = many2oneId(row.default_account_id);
    if (defaultAccount !== null && !accountIds.has(defaultAccount)) {
      throw new OdooImportError('unresolved_reference', `account.journal:${text(row.id)} default account ${defaultAccount}`);
    }
  }
  for (const row of rows.taxes) {
    assertRowCompany(row, company, 'account.tax');
    sourceRate(row.amount);
  }
  const linesByMove = new Map<number, SourceRow[]>();
  for (const line of rows.lines) {
    assertRowCompany(line, company, 'account.move.line');
    const moveId = many2oneId(line.move_id);
    const accountId = many2oneId(line.account_id);
    const journalId = many2oneId(line.journal_id);
    const partnerId = many2oneId(line.partner_id);
    if (moveId === null || !moveIds.has(moveId)) throw new OdooImportError('unresolved_reference', `Move line ${text(line.id)} move`);
    if (accountId === null || !accountIds.has(accountId)) throw new OdooImportError('unresolved_reference', `Move line ${text(line.id)} account`);
    if (journalId !== null && !journalIds.has(journalId)) throw new OdooImportError('unresolved_reference', `Move line ${text(line.id)} journal`);
    if (partnerId !== null && !partnerIds.has(partnerId)) throw new OdooImportError('unresolved_reference', `Move line ${text(line.id)} partner`);
    const appliedTaxIds = Array.isArray(line.tax_ids) ? line.tax_ids.map(many2oneId).filter((id): id is number => id !== null) : [];
    const taxLineId = many2oneId(line.tax_line_id);
    if ([...appliedTaxIds, ...(taxLineId === null ? [] : [taxLineId])].some((id) => !taxIds.has(id))) {
      throw new OdooImportError('unresolved_reference', `Move line ${text(line.id)} tax`);
    }
    const lineRecord = `account.move.line:${text(line.id)}`;
    sourceMoney(line.debit, `${lineRecord} debit`); sourceMoney(line.credit, `${lineRecord} credit`);
    if (line.amount_currency !== false && line.amount_currency !== null && line.amount_currency !== undefined) {
      sourceMoney(line.amount_currency, `${lineRecord} amount_currency`);
    }
    const bucket = linesByMove.get(moveId) ?? [];
    bucket.push(line); linesByMove.set(moveId, bucket);
  }
  for (const move of rows.moves) {
    assertRowCompany(move, company, 'account.move');
    const id = requiredId(move, 'account.move');
    const state = text(move.state);
    if (!['draft', 'posted'].includes(state)) throw new OdooImportError('invalid_source_state', `account.move:${id} state ${state}`);
    const journalId = many2oneId(move.journal_id);
    const partnerId = many2oneId(move.partner_id);
    if (journalId === null || !journalIds.has(journalId)) throw new OdooImportError('unresolved_reference', `account.move:${id} journal`);
    if (partnerId !== null && !partnerIds.has(partnerId)) throw new OdooImportError('unresolved_reference', `account.move:${id} partner`);
    if (!optionalDate(move.date)) throw new OdooImportError('invalid_source_row', `account.move:${id} has no date`);
    const moveLines = linesByMove.get(id) ?? [];
    if (!moveLines.length) throw new OdooImportError('unresolved_reference', `account.move:${id} has no lines`);
    let debit = new Prisma.Decimal(0); let credit = new Prisma.Decimal(0);
    for (const line of moveLines) {
      const lineRecord = `account.move.line:${text(line.id)}`;
      debit = debit.plus(sourceMoney(line.debit, `${lineRecord} debit`));
      credit = credit.plus(sourceMoney(line.credit, `${lineRecord} credit`));
      const parentState = text(line.parent_state);
      if (parentState && parentState !== state) throw new OdooImportError('source_state_mismatch', `account.move.line:${text(line.id)}`);
      const lineJournal = many2oneId(line.journal_id);
      if (lineJournal !== null && lineJournal !== journalId) throw new OdooImportError('unresolved_reference', `Move line ${text(line.id)} journal mismatch`);
    }
    if (!debit.equals(credit)) throw new OdooImportError('unbalanced_entry', `${company}:account.move:${id}`);
  }
}

export async function readSourceRows(path: string): Promise<SourceRow[]> {
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new OdooImportError('invalid_jsonl', `${path} is not an array`);
    return parsed as SourceRow[];
  }
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as SourceRow; }
    catch { throw new OdooImportError('invalid_jsonl', `${path}:${index + 1} is invalid JSON`); }
  });
}

function currencyCode(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return text(value[1]).trim() || null;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function partnerType(row: SourceRow): string {
  const customer = Number(row.customer_rank ?? 0) > 0;
  const vendor = Number(row.supplier_rank ?? 0) > 0;
  return customer && vendor ? 'both' : customer ? 'customer' : vendor ? 'vendor' : 'other';
}

async function importPartners(tx: LedgerTx, rows: SourceRow[], counts: Record<string, number>) {
  for (const row of rows) {
    const id = requiredId(row, 'res.partner');
    const sourceRef = `res.partner:${id}`;
    const hash = sourceContentHash(row);
    const data = {
      displayName: text(row.display_name ?? row.name), legalName: text(row.name), taxId: text(row.vat),
      partnerType: partnerType(row), address: text(row.contact_address_complete ?? row.contact_address),
      source: ODOO_IMPORT_SOURCE, sourceRef, contentHash: hash,
    };
    const existing = await tx.jupiterLedgerPartner.findUnique({ where: { source_sourceRef: { source: ODOO_IMPORT_SOURCE, sourceRef } } });
    if (existing?.contentHash === hash) counts.noop += 1;
    else if (existing) { await tx.jupiterLedgerPartner.update({ where: { id: existing.id }, data }); counts.updated += 1; }
    else { await tx.jupiterLedgerPartner.create({ data }); counts.inserted += 1; }
  }
}

function accountData(row: SourceRow, companyCode: ImportCompanyCode) {
  const id = requiredId(row, 'account.account');
  const accountType = text(row.account_type ?? row.user_type_code ?? row.internal_type);
  const accountClass = accountClassFromOdooType(accountType);
  return {
    sourceRef: `${companyCode}:account.account:${id}`,
    hash: sourceContentHash(row),
    data: {
      companyCode, code: text(row.code), name: text(row.name), accountType, accountClass,
      normalBalance: ['liability', 'equity', 'income'].includes(accountClass) ? 'credit' : 'debit',
      reconcile: bool(row.reconcile), active: row.deprecated === true ? false : bool(row.active, true),
      currencyCode: currencyCode(row.currency_id), source: ODOO_IMPORT_SOURCE,
    },
  };
}

async function upsertCompanyMasters(
  tx: LedgerTx,
  companyCode: ImportCompanyCode,
  rows: { accounts: SourceRow[]; journals: SourceRow[]; taxes: SourceRow[] },
  counts: Record<string, number>,
) {
  for (const row of rows.accounts) {
    assertRowCompany(row, companyCode, 'account.account');
    const mapped = accountData(row, companyCode);
    if (!mapped.data.code) throw new OdooImportError('invalid_source_row', `Account ${mapped.sourceRef} has no code`);
    const existing = await tx.jupiterLedgerAccount.findUnique({
      where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef: mapped.sourceRef } },
    });
    if (existing?.contentHash === mapped.hash) counts.noop += 1;
    else if (existing) {
      await tx.jupiterLedgerAccount.update({ where: { id: existing.id }, data: { ...mapped.data, sourceRef: mapped.sourceRef, contentHash: mapped.hash } });
      counts.updated += 1;
    } else {
      await tx.jupiterLedgerAccount.create({ data: { ...mapped.data, sourceRef: mapped.sourceRef, contentHash: mapped.hash } });
      counts.inserted += 1;
    }
  }

  for (const row of rows.journals) {
    assertRowCompany(row, companyCode, 'account.journal');
    const id = requiredId(row, 'account.journal');
    const sourceRef = `${companyCode}:account.journal:${id}`;
    const hash = sourceContentHash(row);
    const defaultId = many2oneId(row.default_account_id);
    const defaultAccount = defaultId === null ? null : await tx.jupiterLedgerAccount.findUnique({
      where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef: `${companyCode}:account.account:${defaultId}` } },
    });
    if (defaultId !== null && !defaultAccount) throw new OdooImportError('unresolved_reference', `${sourceRef} default account ${defaultId}`);
    const data = {
      companyCode, code: text(row.code), name: text(row.name), journalType: text(row.type, 'general'),
      active: bool(row.active, true), defaultAccountId: defaultAccount?.id ?? null,
      source: ODOO_IMPORT_SOURCE, sourceRef, contentHash: hash,
    };
    const existing = await tx.jupiterLedgerJournal.findUnique({
      where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef } },
    });
    if (existing?.contentHash === hash) counts.noop += 1;
    else if (existing) { await tx.jupiterLedgerJournal.update({ where: { id: existing.id }, data }); counts.updated += 1; }
    else { await tx.jupiterLedgerJournal.create({ data }); counts.inserted += 1; }
  }

  for (const row of rows.taxes) {
    assertRowCompany(row, companyCode, 'account.tax');
    const id = requiredId(row, 'account.tax');
    const sourceRef = `${companyCode}:account.tax:${id}`;
    const hash = sourceContentHash(row);
    const data = {
      companyCode, name: text(row.name), description: text(row.description), taxKind: 'unclassified',
      usage: text(row.type_tax_use, 'none'), amountType: text(row.amount_type, 'percent'),
      rate: sourceRate(row.amount), priceIncluded: bool(row.price_include), active: bool(row.active, true),
      source: ODOO_IMPORT_SOURCE, sourceRef, contentHash: hash,
    };
    const existing = await tx.jupiterLedgerTax.findUnique({
      where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef } },
    });
    if (existing?.contentHash === hash) counts.noop += 1;
    else if (existing) { await tx.jupiterLedgerTax.update({ where: { id: existing.id }, data }); counts.updated += 1; }
    else { await tx.jupiterLedgerTax.create({ data }); counts.inserted += 1; }
  }
}

async function resolvePartner(tx: LedgerTx, value: unknown) {
  const id = many2oneId(value);
  if (id === null) return null;
  const partner = await tx.jupiterLedgerPartner.findUnique({
    where: { source_sourceRef: { source: ODOO_IMPORT_SOURCE, sourceRef: `res.partner:${id}` } },
  });
  if (!partner) throw new OdooImportError('unresolved_reference', `res.partner:${id}`);
  return partner;
}

export async function seedImportedJournalSequences(tx: LedgerTx, companyCode: ImportCompanyCode): Promise<void> {
  const entries = await tx.jupiterJournalEntry.findMany({
    where: { companyCode, source: ODOO_IMPORT_SOURCE, entryNo: { not: null } },
    select: { journalId: true, entryDate: true, entryNo: true },
  });
  const maxima = new Map<string, { journalId: string; fiscalYear: number; maxNo: number }>();
  for (const entry of entries) {
    const suffix = entry.entryNo?.match(/(\d+)$/)?.[1];
    if (!suffix) continue;
    const number = Number(suffix);
    if (!Number.isSafeInteger(number) || number < 1 || number >= 2_147_483_647) continue;
    const fiscalYear = entry.entryDate.getUTCFullYear();
    const key = `${entry.journalId}:${fiscalYear}`;
    const current = maxima.get(key);
    if (!current || number > current.maxNo) maxima.set(key, { journalId: entry.journalId, fiscalYear, maxNo: number });
  }
  for (const { journalId, fiscalYear, maxNo } of maxima.values()) {
    const where = { companyCode_journalId_fiscalYear: { companyCode, journalId, fiscalYear } };
    const sequence = await tx.jupiterJournalSequence.findUnique({ where, select: { nextNo: true } });
    const nextNo = maxNo + 1;
    if (!sequence) {
      await tx.jupiterJournalSequence.create({ data: { companyCode, journalId, fiscalYear, nextNo } });
    } else if (sequence.nextNo < nextNo) {
      await tx.jupiterJournalSequence.update({ where, data: { nextNo } });
    }
  }
}

async function importMoves(
  tx: LedgerTx,
  companyCode: ImportCompanyCode,
  moves: SourceRow[],
  lines: SourceRow[],
  snapshotRef: string,
  counts: Record<string, number>,
) {
  const linesByMove = new Map<number, SourceRow[]>();
  for (const line of lines) {
    assertRowCompany(line, companyCode, 'account.move.line');
    const moveId = many2oneId(line.move_id);
    if (moveId === null) throw new OdooImportError('unresolved_reference', 'Move line has no move_id');
    const bucket = linesByMove.get(moveId) ?? [];
    bucket.push(line);
    linesByMove.set(moveId, bucket);
  }
  for (const move of moves) {
    assertRowCompany(move, companyCode, 'account.move');
    const moveId = requiredId(move, 'account.move');
    const moveLines = (linesByMove.get(moveId) ?? []).sort((a, b) =>
      Number(a.sequence ?? 0) - Number(b.sequence ?? 0) || requiredId(a, 'account.move.line') - requiredId(b, 'account.move.line'));
    if (!moveLines.length) throw new OdooImportError('unresolved_reference', `account.move:${moveId} has no lines`);
    const debit = moveLines.reduce((sum, line) => sum.plus(sourceMoney(line.debit, `account.move.line:${text(line.id)} debit`)), new Prisma.Decimal(0));
    const credit = moveLines.reduce((sum, line) => sum.plus(sourceMoney(line.credit, `account.move.line:${text(line.id)} credit`)), new Prisma.Decimal(0));
    if (!debit.equals(credit)) {
      throw new OdooImportError('unbalanced_entry', `${companyCode}:account.move:${moveId} debit ${moneyToString(debit)} credit ${moneyToString(credit)}`);
    }
    const journalId = many2oneId(move.journal_id);
    if (journalId === null) throw new OdooImportError('unresolved_reference', `Move ${moveId} has no journal`);
    const journal = await tx.jupiterLedgerJournal.findUnique({
      where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef: `${companyCode}:account.journal:${journalId}` } },
    });
    if (!journal) throw new OdooImportError('unresolved_reference', `account.journal:${journalId}`);
    const partner = await resolvePartner(tx, move.partner_id);
    const sourceRef = `${companyCode}:account.move:${moveId}`;
    const hash = sourceContentHash({ move, lines: moveLines });
    const existing = await tx.jupiterJournalEntry.findUnique({
      where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef } },
    });
    const action = importedEntryAction(existing, hash);
    if (action === 'noop') { counts.noop += 1; continue; }
    const targetState = text(move.state) === 'posted' ? 'posted' : 'draft';
    for (const line of moveLines) {
      const parentState = text(line.parent_state);
      if (parentState && parentState !== targetState) {
        throw new OdooImportError('source_state_mismatch', `${companyCode}:account.move.line:${text(line.id)} parent_state ${parentState} disagrees with move ${targetState}`);
      }
    }
    const header = {
      companyCode, journalId: journal.id, entryNo: text(move.name) === '/' ? null : text(move.name) || null,
      entryDate: optionalDate(move.date) ?? (() => { throw new OdooImportError('invalid_source_row', `${sourceRef} has no date`); })(),
      state: 'draft', entryType: text(move.move_type, 'general'), ref: text(move.ref), memo: text(move.narration),
      partnerId: partner?.id ?? null, documentNo: text(move.invoice_origin), documentDate: optionalDate(move.invoice_date),
      dueDate: optionalDate(move.invoice_date_due), paymentReference: text(move.payment_reference), paymentState: text(move.payment_state),
      currencyCode: currencyCode(move.currency_id) ?? 'THB', source: ODOO_IMPORT_SOURCE, sourceRef,
      sourceSnapshotRef: snapshotRef, contentHash: hash, createdByName: 'Odoo rescue import',
    };
    let entryId: string;
    if (action === 'update' && existing) {
      await tx.jupiterJournalLineTax.deleteMany({ where: { line: { entryId: existing.id } } });
      await tx.jupiterJournalLine.deleteMany({ where: { entryId: existing.id } });
      const updated = await tx.jupiterJournalEntry.update({ where: { id: existing.id }, data: { ...header, version: { increment: 1 } }, select: { id: true } });
      entryId = updated.id;
      counts.updated += 1;
    } else {
      entryId = (await tx.jupiterJournalEntry.create({ data: header, select: { id: true } })).id;
      counts.inserted += 1;
    }
    for (const [index, line] of moveLines.entries()) {
      const lineId = requiredId(line, 'account.move.line');
      const accountId = many2oneId(line.account_id);
      if (accountId === null) throw new OdooImportError('unresolved_reference', `Move line ${lineId} has no account`);
      const account = await tx.jupiterLedgerAccount.findUnique({
        where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef: `${companyCode}:account.account:${accountId}` } },
      });
      if (!account) throw new OdooImportError('unresolved_reference', `account.account:${accountId}`);
      const lineJournalId = many2oneId(line.journal_id);
      if (lineJournalId !== null && lineJournalId !== journalId) throw new OdooImportError('unresolved_reference', `Move line ${lineId} journal mismatch`);
      const linePartner = await resolvePartner(tx, line.partner_id);
      const createdLine = await tx.jupiterJournalLine.create({ data: {
        entryId, lineNo: index + 1, accountId: account.id, partnerId: linePartner?.id ?? null,
        label: text(line.name),
        debit: sourceMoney(line.debit, `account.move.line:${lineId} debit`),
        credit: sourceMoney(line.credit, `account.move.line:${lineId} credit`),
        amountCurrency: line.amount_currency === false || line.amount_currency == null
          ? null : sourceMoney(line.amount_currency, `account.move.line:${lineId} amount_currency`),
        currencyCode: currencyCode(line.currency_id), maturityDate: optionalDate(line.date_maturity),
        reconciled: bool(line.reconciled), externalReconcileRef: text(line.full_reconcile_id || line.matching_number) || null,
        sourceRef: `${companyCode}:account.move.line:${lineId}`,
      }, select: { id: true } });
      const applied = Array.isArray(line.tax_ids) ? line.tax_ids.map(many2oneId).filter((id): id is number => id !== null) : [];
      const taxLineId = many2oneId(line.tax_line_id);
      for (const [role, ids] of [['applied', applied], ['tax_line', taxLineId === null ? [] : [taxLineId]]] as const) {
        for (const taxId of ids) {
          const tax = await tx.jupiterLedgerTax.findUnique({
            where: { companyCode_source_sourceRef: { companyCode, source: ODOO_IMPORT_SOURCE, sourceRef: `${companyCode}:account.tax:${taxId}` } },
          });
          if (!tax) throw new OdooImportError('unresolved_reference', `account.tax:${taxId}`);
          await tx.jupiterJournalLineTax.create({ data: { lineId: createdLine.id, taxId: tax.id, role } });
        }
      }
    }
    if (targetState === 'posted') {
      await tx.jupiterJournalEntry.update({ where: { id: entryId }, data: { state: 'posted', postedByName: 'Odoo rescue import' } });
    }
  }
  const orphanLines = [...linesByMove.keys()].filter((id) => !moves.some((move) => requiredId(move, 'account.move') === id));
  if (orphanLines.length) throw new OdooImportError('unresolved_reference', `Orphan move lines for moves ${orphanLines.join(',')}`);
}

export async function importOdooSnapshot(options: ImportOdooOptions, client?: PrismaClient) {
  if (!options.companies.length) throw new OdooImportError('companies_required', 'At least one company is required');
  const companies = [...new Set(options.companies)];
  for (const company of companies) {
    if (!Object.values(ODOO_COMPANY_MAP).includes(company)) throw new OdooImportError('unknown_company', company);
  }
  const preflight = await preflightOdooSnapshot(options.snapshotPath, companies);
  const partners = await readSourceRows(preflight.partnerFile);
  const sourceByCompany = new Map<ImportCompanyCode, {
    accounts: SourceRow[]; journals: SourceRow[]; taxes: SourceRow[]; moves: SourceRow[]; lines: SourceRow[];
    trialBalanceClient: SourceRow[]; trialBalanceServer: SourceRow[]; partnerLedger: SourceRow[];
    hashes: Record<string, string>;
  }>();
  for (const company of companies) {
    const files = preflight.companyFiles.get(company)!;
    sourceByCompany.set(company, {
      accounts: await readSourceRows(files.accounts), journals: await readSourceRows(files.journals),
      taxes: await readSourceRows(files.taxes), moves: await readSourceRows(files.moves), lines: await readSourceRows(files.lines),
      trialBalanceClient: parseRfc4180Csv(await readFile(files.trialBalanceClient, 'utf8')),
      trialBalanceServer: parseRfc4180Csv(await readFile(files.trialBalanceServer, 'utf8')),
      partnerLedger: parseRfc4180Csv(await readFile(files.partnerLedger, 'utf8')),
      hashes: Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await sha256File(path)]))),
    });
  }
  const partnerIds = uniqueIds(partners, 'res.partner');
  for (const [company, rows] of sourceByCompany) validateSourceCompany(company, rows, partnerIds);
  const result: Record<string, unknown> = {
    dryRun: !options.apply,
    partners: partners.length,
    companies: Object.fromEntries([...sourceByCompany].map(([code, rows]) => [code, {
      accounts: rows.accounts.length, journals: rows.journals.length, taxes: rows.taxes.length,
      moves: rows.moves.length, lines: rows.lines.length, hashes: rows.hashes,
    }])),
  };
  // Mapping and balance validation happens in the same routines on apply. Dry-run performs all
  // deterministic source validations without opening a database transaction.
  if (!options.apply) {
    return { ...result, snapshotRef: preflight.snapshotRef, manifestSha256: preflight.manifestSha256 };
  }

  const applyClient = client ?? (await import('../../db/prisma.js')).prisma;
  const { generalLedger, partnerLedger, trialBalance } = await import('./reports.js');
  const batch = await applyClient.jupiterLedgerImportBatch.upsert({
    where: { source_manifestSha256: { source: ODOO_IMPORT_SOURCE, manifestSha256: preflight.manifestSha256 } },
    create: {
      source: ODOO_IMPORT_SOURCE, snapshotRef: preflight.snapshotRef, manifestSha256: preflight.manifestSha256,
      status: 'running', requestedCompanies: companies, createdByName: options.createdByName ?? 'cli',
    },
    update: { status: 'running', requestedCompanies: companies, result: Prisma.JsonNull, completedAt: null },
  });
  try {
    const mutations = { inserted: 0, updated: 0, noop: 0 };
    await applyClient.$transaction((tx) => importPartners(tx, partners, mutations));
    for (const [company, rows] of sourceByCompany) {
      await applyClient.$transaction(async (tx) => {
        const current = await tx.jupiterCompany.findUnique({ where: { code: company } });
        if (!current) throw new OdooImportError('unknown_company', company);
        if (current.ledgerMode === 'book_of_record' || current.ledgerMode === 'paper_only') {
          throw new OdooImportError('invalid_ledger_mode', `${company} is ${current.ledgerMode}; import requires cockpit or shadow`);
        }
        if (current.ledgerMode !== 'shadow') await tx.jupiterCompany.update({ where: { code: company }, data: { ledgerMode: 'shadow' } });
        await upsertCompanyMasters(tx, company, rows, mutations);
        await importMoves(tx, company, rows.moves, rows.lines, preflight.snapshotRef, mutations);
        await seedImportedJournalSequences(tx, company);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    const reconciliation: Record<string, unknown> = {};
    for (const company of companies) {
      const source = sourceByCompany.get(company)!;
      const [gl, tb, partnersReport] = await Promise.all([
        generalLedger({ companyCode: company, state: 'posted' }, applyClient),
        trialBalance({ companyCode: company }, applyClient),
        partnerLedger({ companyCode: company }, applyClient),
      ]);
      const glTotals = sumRows(gl);
      const sourcePostedLines = source.lines.filter((line) => text(line.parent_state) === 'posted');
      const sourceDebit = sourcePostedLines.reduce((sum, line) => sum.plus(
        sourceMoney(line.debit, `account.move.line:${text(line.id)} debit`),
      ), new Prisma.Decimal(0));
      const sourceCredit = sourcePostedLines.reduce((sum, line) => sum.plus(
        sourceMoney(line.credit, `account.move.line:${text(line.id)} credit`),
      ), new Prisma.Decimal(0));
      const comparisons = {
        trialBalanceClient: compareTrialBalance(source.trialBalanceClient, tb),
        trialBalanceServer: compareTrialBalance(source.trialBalanceServer, tb),
        partnerLedger: comparePartnerLedger(source.partnerLedger, partnersReport),
        postedBalance: {
          matched: sourceDebit.equals(sourceCredit) && sourceDebit.equals(glTotals.debit) && sourceCredit.equals(glTotals.credit),
          sourceDebit: moneyToString(sourceDebit), sourceCredit: moneyToString(sourceCredit),
          jupiterDebit: moneyToString(glTotals.debit), jupiterCredit: moneyToString(glTotals.credit),
        },
      };
      reconciliation[company] = {
        counts: {
          postedMoves: source.moves.filter((move) => text(move.state) === 'posted').length,
          draftMoves: source.moves.filter((move) => text(move.state) !== 'posted').length,
          postedLines: sourcePostedLines.length, glLines: gl.length, trialBalanceRows: tb.length, partnerLedgerRows: partnersReport.length,
        },
        comparisons,
      };
      if (!Object.values(comparisons).every((comparison) => comparison.matched)) {
        throw new OdooImportError('reconciliation_difference', `${company} did not reconcile exactly to the rescue reports`);
      }
    }
    Object.assign(result, { mutations, reconciliation });
    await applyClient.jupiterLedgerImportBatch.update({
      where: { id: batch.id },
      data: { status: 'verified', result: result as Prisma.InputJsonValue, completedAt: new Date() },
    });
    return { ...result, batchId: batch.id, snapshotRef: preflight.snapshotRef, manifestSha256: preflight.manifestSha256 };
  } catch (error) {
    const failed = { ...result, error: error instanceof OdooImportError ? error.code : 'import_failed' };
    await applyClient.jupiterLedgerImportBatch.update({
      where: { id: batch.id }, data: { status: 'failed', result: failed as Prisma.InputJsonValue, completedAt: new Date() },
    });
    throw error;
  }
}
