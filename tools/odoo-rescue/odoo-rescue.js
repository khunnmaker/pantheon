#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');

// EDIT THIS BLOCK after --smoke prints the exact res.company names.
// Matching ignores case and repeated whitespace, but never uses substrings/fuzzy guesses.
const CONFIG = Object.freeze({
  companyNameToCode: Object.freeze({
    'Appoint Alliance': 'APPT',
    'TONMAI RESIDENCE COMPANY LIMITED': 'TONR',
    'DENTALPORT DENTAL CLINIC COMPANY LIMITED': 'DENC',
    'PROMINENT COMPANY LIMITED': 'PROM',
    'DENTALPORT COMPANY LIMITED': 'DENL',
    'KHUN PHUA KHUN LIMITED PARTNERSHIP': 'KPKF',
  }),
  requiredCompanyCodes: Object.freeze(['APPT', 'TONR', 'DENC', 'PROM', 'DENL', 'KPKF']),
  batchSize: 2000,
  maxRetries: 6,
  requestTimeoutMs: 120000,
});

const ODOO_STRING_TYPES = new Set(['char', 'text', 'html', 'selection', 'date', 'datetime']);
const STORED_STRING_FIELDS = new Set([
  'code', 'name', 'display_name', 'ref', 'date', 'move_name', 'date_maturity',
  'invoice_date', 'invoice_date_due', 'create_date', 'write_date',
  'export_account_code', 'export_account_name', 'export_partner_name',
  'export_journal_name', 'export_move_name',
]);
const MISSING_POSTED_ACCOUNT_CODE_WARNING = 'posted_move_line_account_missing_code';

const GLOBAL_SPECS = [
  spec('res.company', [
    'id', 'name', 'active', 'currency_id', 'partner_id', 'vat', 'company_registry',
    'email', 'phone', 'website', 'street', 'street2', 'city', 'state_id', 'zip',
    'country_id', 'create_date', 'write_date',
  ], ['id', 'name', 'currency_id']),
  spec('res.currency', [
    'id', 'name', 'full_name', 'symbol', 'position', 'rounding', 'decimal_places',
    'active', 'currency_unit_label', 'currency_subunit_label', 'rate', 'date',
    'create_date', 'write_date',
  ], ['id', 'name', 'rounding']),
  spec('res.partner', [
    'id', 'name', 'display_name', 'active', 'company_type', 'is_company', 'parent_id',
    'commercial_partner_id', 'ref', 'vat', 'company_registry', 'email', 'phone', 'mobile',
    'street', 'street2', 'city', 'state_id', 'zip', 'country_id', 'lang', 'tz',
    'category_id', 'customer_rank', 'supplier_rank', 'property_account_receivable_id',
    'property_account_payable_id', 'bank_ids', 'company_id', 'company_ids',
    'create_date', 'write_date',
  ], ['id', 'name']),
];

const COMPANY_SPECS = [
  spec('account.account', [
    'id', 'code', 'name', 'display_name', 'account_type', 'reconcile', 'active',
    'currency_id', 'company_id', 'company_ids', 'tax_ids', 'tag_ids', 'group_id',
    'note', 'create_date', 'write_date',
  ], ['id', 'code', 'name', 'account_type']),
  spec('account.journal', [
    'id', 'name', 'code', 'type', 'active', 'company_id', 'currency_id',
    'default_account_id', 'suspense_account_id', 'profit_account_id', 'loss_account_id',
    'bank_account_id', 'refund_sequence', 'payment_sequence', 'create_date', 'write_date',
  ], ['id', 'name', 'code', 'company_id']),
  spec('account.tax', [
    'id', 'name', 'description', 'active', 'company_id', 'type_tax_use', 'tax_scope',
    'amount_type', 'amount', 'price_include', 'include_base_amount',
    'is_base_affected', 'sequence', 'invoice_repartition_line_ids',
    'refund_repartition_line_ids', 'tax_group_id', 'country_id', 'create_date', 'write_date',
  ], ['id', 'name', 'company_id']),
  spec('account.move', [
    'id', 'name', 'ref', 'date', 'state', 'move_type', 'journal_id', 'company_id',
    'currency_id', 'partner_id', 'commercial_partner_id', 'invoice_date',
    'invoice_date_due', 'invoice_origin', 'invoice_payment_term_id', 'payment_reference',
    'payment_state', 'amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual',
    'amount_untaxed_signed', 'amount_tax_signed', 'amount_total_signed',
    'amount_residual_signed', 'fiscal_position_id', 'invoice_user_id', 'invoice_partner_display_name',
    'line_ids', 'invoice_line_ids', 'reversed_entry_id', 'reversal_move_id',
    'create_date', 'write_date',
  ], [
    'id', 'name', 'ref', 'date', 'state', 'move_type', 'journal_id', 'company_id',
    'invoice_date', 'invoice_date_due', 'payment_state', 'amount_untaxed',
    'amount_tax', 'amount_total',
  ]),
  spec('account.move.line', [
    'id', 'date', 'move_id', 'move_name', 'ref', 'journal_id', 'company_id',
    'account_id', 'partner_id', 'name', 'debit', 'credit', 'balance',
    'amount_currency', 'currency_id', 'tax_ids', 'tax_line_id', 'tax_tag_ids',
    'reconciled', 'full_reconcile_id', 'matching_number', 'parent_state',
    'date_maturity', 'amount_residual', 'amount_residual_currency', 'display_type',
    'analytic_distribution', 'product_id', 'quantity', 'price_unit',
    'create_date', 'write_date',
  ], [
    'id', 'date', 'move_id', 'move_name', 'ref', 'journal_id', 'company_id', 'account_id',
    'partner_id', 'name', 'debit', 'credit', 'balance', 'amount_currency',
    'currency_id', 'tax_ids', 'tax_line_id', 'reconciled', 'full_reconcile_id',
    'matching_number', 'parent_state',
  ]),
];

function spec(model, fields, required) {
  return Object.freeze({ model, fields: Object.freeze(fields), required: Object.freeze(required) });
}

function usage() {
  return [
    'Usage:',
    '  node odoo-rescue.js --selftest',
    '  node odoo-rescue.js --smoke',
    '  node odoo-rescue.js [--output <new-run-directory>]',
    '  node odoo-rescue.js --resume <existing-run-directory>',
    '',
    'Credentials: ODOO_LOGIN and ODOO_API_KEY are required; ODOO_URL and ODOO_DB are optional.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { mode: 'full', output: null, resume: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--selftest') out.mode = 'selftest';
    else if (arg === '--smoke') out.mode = 'smoke';
    else if (arg === '--help' || arg === '-h') out.mode = 'help';
    else if (arg === '--output' || arg === '--resume') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a directory path`);
      if (arg === '--output') out.output = path.resolve(value);
      else out.resume = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (out.output && out.resume) throw new Error('Use either --output or --resume, not both');
  if (out.mode !== 'full' && (out.output || out.resume)) {
    throw new Error('--output/--resume apply only to a full run');
  }
  return out;
}

class RpcClient {
  constructor({ url, db, login, apiKey, maxRetries, timeoutMs }) {
    this.url = url.replace(/\/+$/, '');
    this.db = db;
    this.login = login;
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.uid = null;
    this.nextId = 1;
  }

  async authenticate() {
    const uid = await this.call('common', 'authenticate', [
      this.db, this.login, this.apiKey, {},
    ]);
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new Error('Authentication failed: Odoo returned no user id. Check database, login, and API key.');
    }
    this.uid = uid;
    return uid;
  }

  async execute(model, method, args = [], kwargs = {}) {
    if (!this.uid) throw new Error('RPC client is not authenticated');
    return this.call('object', 'execute_kw', [
      this.db, this.uid, this.apiKey, model, method, args, kwargs,
    ]);
  }

  async call(service, method, args) {
    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.url}/jsonrpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: { service, method, args }, id: this.nextId++,
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw transientError(`Odoo returned non-JSON HTTP ${response.status}`);
        }
        if (!response.ok) {
          const err = new Error(`Odoo HTTP ${response.status}: ${safeRpcMessage(payload, this.apiKey)}`);
          err.transient = response.status === 408 || response.status === 429 || response.status >= 500;
          throw err;
        }
        if (payload.error) {
          const message = safeRpcMessage(payload.error, this.apiKey);
          const err = new Error(`Odoo RPC error: ${message}`);
          err.transient = /timeout|temporar|deadlock|serialization|connection|try again|rate limit/i.test(message);
          throw err;
        }
        return payload.result;
      } catch (error) {
        lastError = error;
        const transient = error.name === 'AbortError' || error.transient === true ||
          /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(String(error.message));
        if (!transient || attempt === this.maxRetries - 1) throw error;
        const delay = Math.min(10000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250);
        console.warn(`Transient RPC failure; retrying in ${delay} ms (attempt ${attempt + 2}/${this.maxRetries}).`);
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

function transientError(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

function safeRpcMessage(value, secret) {
  let message = '';
  if (value && typeof value === 'object') {
    message = value.data?.message || value.message || value.error || 'unknown RPC failure';
  } else {
    message = String(value || 'unknown RPC failure');
  }
  message = String(message);
  if (secret) message = message.split(secret).join('[REDACTED]');
  return message.slice(0, 2000);
}

async function groupSums(rpc, model, domain, groupbyField, aggregateFields, context) {
  const aggregates = aggregateFields.map((field) => `${field}:sum`);
  let rows;
  try {
    rows = await rpc.execute(model, 'formatted_read_group', [
      domain, [groupbyField], [...aggregates, '__count'],
    ], { context });
  } catch (error) {
    const message = safeRpcMessage(error);
    if (!message.includes('formatted_read_group') || !/does not exist/i.test(message)) throw error;
    rows = await rpc.execute(model, 'read_group', [
      domain, [groupbyField, ...aggregates], [groupbyField],
    ], { lazy: false, context });
  }

  const ownValue = (row, keys, fallback) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    }
    return fallback;
  };
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const normalized = { [groupbyField]: ownValue(row, [groupbyField], false) };
    for (const field of aggregateFields) {
      normalized[field] = ownValue(row, [`${field}:sum`, field], 0);
    }
    normalized.__count = ownValue(row, [
      '__count', `${groupbyField}_count`, `${groupbyField}:count`, `${groupbyField}:count_distinct`,
    ], 0);
    return normalized;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCompanyName(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

async function discoverCompanies(rpc) {
  const rows = await rpc.execute('res.company', 'search_read', [[]], {
    fields: ['id', 'name', 'active', 'currency_id'], order: 'id asc', context: { active_test: false },
  });
  if (!rows.length) throw new Error('No res.company records are visible to this API user.');

  const configured = new Map();
  for (const [name, code] of Object.entries(CONFIG.companyNameToCode)) {
    const key = normalizeCompanyName(name);
    if (configured.has(key)) throw new Error(`Duplicate normalized company name in CONFIG: ${name}`);
    configured.set(key, code);
  }
  const mapped = rows.map((row) => ({
    ...row,
    code: configured.get(normalizeCompanyName(row.name)) || null,
  }));
  console.table(mapped.map(({ id, name, active, code }) => ({ id, name, active, code: code || 'UNMAPPED' })));

  const unmapped = mapped.filter((row) => !row.code);
  if (unmapped.length) {
    throw new Error(`Unmapped Odoo companies: ${unmapped.map((x) => JSON.stringify(x.name)).join(', ')}. ` +
      'Edit CONFIG.companyNameToCode with the exact printed names; the exporter will not guess.');
  }
  const duplicateCodes = mapped.map((x) => x.code).filter((code, i, all) => all.indexOf(code) !== i);
  if (duplicateCodes.length) throw new Error(`More than one company maps to code(s): ${[...new Set(duplicateCodes)].join(', ')}`);
  const actual = new Set(mapped.map((x) => x.code));
  const missing = CONFIG.requiredCompanyCodes.filter((code) => !actual.has(code));
  const extra = [...actual].filter((code) => !CONFIG.requiredCompanyCodes.includes(code));
  if (missing.length || extra.length || mapped.length !== CONFIG.requiredCompanyCodes.length) {
    throw new Error(`Company mapping must resolve exactly the six required codes. Missing: ${missing.join(', ') || 'none'}; ` +
      `unexpected: ${extra.join(', ') || 'none'}; discovered records: ${mapped.length}.`);
  }
  return mapped;
}

function companyContext(companyId) {
  return { allowed_company_ids: [companyId], company_id: companyId, active_test: false };
}

async function fieldsFor(rpc, model, requested, required, context) {
  const metadata = await rpc.execute(model, 'fields_get', [], { attributes: ['type'], context });
  const available = new Set(Object.keys(metadata));
  const missing = required.filter((field) => !available.has(field));
  if (missing.length) {
    throw new Error(`${model} is missing required field(s): ${missing.join(', ')}. ` +
      'This Odoo version is not compatible with the requested lossless accounting schema; no silent omission was made.');
  }
  return {
    fields: requested.filter((field) => available.has(field)),
    omittedFields: requested.filter((field) => !available.has(field)),
    fieldTypes: Object.fromEntries(requested
      .filter((field) => available.has(field))
      .map((field) => [field, metadata[field].type])),
  };
}

function normalizeOdooString(value) {
  return value === false ? null : value;
}

function normalizeOdooRecord(row, fieldTypes = null) {
  let normalized = row;
  for (const [field, value] of Object.entries(row)) {
    const type = fieldTypes?.[field];
    const isKnownString = ODOO_STRING_TYPES.has(type) || (!fieldTypes && STORED_STRING_FIELDS.has(field));
    let next = value;
    if (isKnownString) next = normalizeOdooString(value);
    else if ((type === 'many2one' || !fieldTypes) && Array.isArray(value) && value.length > 1 && value[1] === false) {
      next = [value[0], null, ...value.slice(2)];
    }
    if (next !== value) {
      if (normalized === row) normalized = { ...row };
      normalized[field] = next;
    }
  }
  return normalized;
}

async function companyDomain(rpc, model, companyId, context) {
  const metadata = await rpc.execute(model, 'fields_get', [], { attributes: ['type'], context });
  if (metadata.company_id) return [['company_id', '=', companyId]];
  if (model === 'account.account' && metadata.company_ids) return [['company_ids', 'in', [companyId]]];
  throw new Error(`${model} has neither company_id nor a supported company_ids field; refusing an unscoped export.`);
}

function checkpointName(scope, model) {
  return `${scope}--${model.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  const handle = await fsp.open(temp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFile(temp, file);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read checkpoint ${file}: ${error.message}`);
  }
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function extractModel({
  rpc, runDir, scope, outDir, modelSpec, domain, context, batchSize, transform, afterBatchAppend,
}) {
  const started = Date.now();
  await fsp.mkdir(outDir, { recursive: true });
  const jsonlFile = path.join(outDir, `${modelSpec.model}.jsonl`);
  const checkpointFile = path.join(runDir, '.checkpoints', checkpointName(scope, modelSpec.model));
  const { fields, omittedFields, fieldTypes } = await fieldsFor(
    rpc, modelSpec.model, modelSpec.fields, modelSpec.required, context
  );
  const serverCountBefore = await rpc.execute(modelSpec.model, 'search_count', [domain], { context });
  let checkpoint = await readJsonIfExists(checkpointFile);

  if (checkpoint?.complete) {
    const fileStats = await scanJsonl(jsonlFile);
    const serverCountAfter = await rpc.execute(modelSpec.model, 'search_count', [domain], { context });
    if (fileStats.rows !== serverCountAfter) {
      throw new Error(`${scope}/${modelSpec.model}: completed checkpoint has ${fileStats.rows} rows but Odoo now has ` +
        `${serverCountAfter}. Start a new run; a completed snapshot cannot safely absorb later edits/deletions.`);
    }
    return manifestEntry(scope, modelSpec.model, jsonlFile, fields, omittedFields, serverCountBefore,
      serverCountAfter, fileStats, Date.now() - started, true);
  }

  if (!checkpoint) {
    checkpoint = { version: 1, model: modelSpec.model, scope, lastId: 0, rows: 0, bytes: 0, complete: false };
    if (await fileExists(jsonlFile)) await fsp.truncate(jsonlFile, 0);
  } else {
    if (checkpoint.model !== modelSpec.model || checkpoint.scope !== scope ||
        !Number.isInteger(checkpoint.lastId) || !Number.isInteger(checkpoint.rows) ||
        !Number.isInteger(checkpoint.bytes) || checkpoint.bytes < 0) {
      throw new Error(`Invalid checkpoint contents: ${checkpointFile}`);
    }
    if (!(await fileExists(jsonlFile))) {
      if (checkpoint.rows !== 0) throw new Error(`Checkpoint exists but data file is missing: ${jsonlFile}`);
      await fsp.writeFile(jsonlFile, '');
    }
    const stat = await fsp.stat(jsonlFile);
    if (stat.size < checkpoint.bytes) throw new Error(`Data file is shorter than its checkpoint: ${jsonlFile}`);
    await fsp.truncate(jsonlFile, checkpoint.bytes);
  }
  if (!(await fileExists(jsonlFile))) await fsp.writeFile(jsonlFile, '');

  while (true) {
    const cursorDomain = [...domain, ['id', '>', checkpoint.lastId]];
    const batch = await rpc.execute(modelSpec.model, 'search_read', [cursorDomain], {
      fields, limit: batchSize, order: 'id asc', context,
    });
    if (!Array.isArray(batch)) throw new Error(`${modelSpec.model}.search_read did not return an array`);
    if (!batch.length) break;
    let previous = checkpoint.lastId;
    for (const row of batch) {
      if (!Number.isInteger(row.id) || row.id <= previous) {
        throw new Error(`${scope}/${modelSpec.model}: non-increasing or invalid id ${row.id}`);
      }
      previous = row.id;
    }
    const ingested = batch.map((row) => normalizeOdooRecord(row, fieldTypes));
    const exported = transform ? ingested.map(transform) : ingested;
    const chunk = `${exported.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const handle = await fsp.open(jsonlFile, 'a');
    try {
      await handle.write(chunk, null, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (afterBatchAppend) await afterBatchAppend({ batch: ingested, chunk, checkpoint: { ...checkpoint } });
    checkpoint.lastId = previous;
    checkpoint.rows += batch.length;
    checkpoint.bytes += Buffer.byteLength(chunk, 'utf8');
    checkpoint.updatedAt = new Date().toISOString();
    await atomicWriteJson(checkpointFile, checkpoint);
  }

  checkpoint.complete = true;
  checkpoint.completedAt = new Date().toISOString();
  await atomicWriteJson(checkpointFile, checkpoint);
  const fileStats = await scanJsonl(jsonlFile);
  const serverCountAfter = await rpc.execute(modelSpec.model, 'search_count', [domain], { context });
  if (fileStats.rows !== serverCountAfter || checkpoint.rows !== fileStats.rows) {
    throw new Error(`${scope}/${modelSpec.model}: count check failed; file=${fileStats.rows}, ` +
      `checkpoint=${checkpoint.rows}, server=${serverCountAfter}.`);
  }
  return manifestEntry(scope, modelSpec.model, jsonlFile, fields, omittedFields, serverCountBefore,
    serverCountAfter, fileStats, Date.now() - started, false);
}

function manifestEntry(
  scope, model, file, fields, omittedFields, serverCountBefore, serverCountAfter, stats, durationMs, resumedComplete
) {
  return {
    scope, model, file: path.basename(file), fields, omittedFields, fileRows: stats.rows,
    serverSearchCountBefore: serverCountBefore, serverSearchCountAfter: serverCountAfter,
    sumDebit: stats.sumDebit, sumCredit: stats.sumCredit,
    postedSumDebit: stats.postedSumDebit, postedSumCredit: stats.postedSumCredit,
    minDate: stats.minDate, maxDate: stats.maxDate, durationMs, resumedComplete,
  };
}

async function* jsonlRecords(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      yield normalizeOdooRecord(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSONL at ${file}:${lineNo}: ${error.message}`);
    }
  }
}

async function scanJsonl(file) {
  const stats = {
    rows: 0, sumDebit: 0, sumCredit: 0, postedSumDebit: 0, postedSumCredit: 0,
    minDate: null, maxDate: null, beYearFlags: [],
  };
  for await (const row of jsonlRecords(file)) {
    stats.rows += 1;
    if (typeof row.debit === 'number') stats.sumDebit += row.debit;
    if (typeof row.credit === 'number') stats.sumCredit += row.credit;
    if (row.parent_state === 'posted') {
      stats.postedSumDebit += Number(row.debit || 0);
      stats.postedSumCredit += Number(row.credit || 0);
    }
    const date = typeof row.date === 'string' ? row.date.slice(0, 10) : null;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (!stats.minDate || date < stats.minDate) stats.minDate = date;
      if (!stats.maxDate || date > stats.maxDate) stats.maxDate = date;
    }
    for (const [field, value] of Object.entries(row)) {
      if (!/(^|_)date($|_)/i.test(field) || typeof value !== 'string') continue;
      const match = /^(\d{4})-\d{2}-\d{2}/.exec(value);
      if (match && Number(match[1]) >= 2400) {
        stats.beYearFlags.push({ id: row.id, field, value });
      }
    }
  }
  for (const key of ['sumDebit', 'sumCredit', 'postedSumDebit', 'postedSumCredit']) {
    stats[key] = normalizeNumber(stats[key]);
  }
  return stats;
}

function normalizeNumber(value) {
  return Number(Number(value).toFixed(9));
}

function relationId(value) {
  return Array.isArray(value) ? value[0] : (Number.isInteger(value) ? value : null);
}

function relationName(value) {
  return Array.isArray(value) ? normalizeOdooString(value[1]) : null;
}

function enrichMoveLine(row, accounts) {
  const accountId = relationId(row.account_id);
  const account = accounts.get(accountId);
  return {
    ...row,
    export_account_code: normalizeOdooString(account?.code),
    export_account_name: normalizeOdooString(account?.name) ?? relationName(row.account_id),
    export_partner_name: relationName(row.partner_id),
    export_journal_name: relationName(row.journal_id),
    export_move_name: normalizeOdooString(row.move_name) ?? relationName(row.move_id),
  };
}

async function loadAccountMap(file) {
  const map = new Map();
  for await (const row of jsonlRecords(file)) map.set(row.id, row);
  return map;
}

function pow10BigInt(precision) {
  return BigInt(10 ** precision);
}

function toUnits(value, precision) {
  const factor = 10 ** precision;
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw new Error(`Non-finite monetary value: ${value}`);
  return BigInt(Math.round(number * factor));
}

function fromUnits(value, precision) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const factor = pow10BigInt(precision);
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(precision, '0');
  return `${negative ? '-' : ''}${whole}${precision ? `.${fraction}` : ''}`;
}

function addTbLine(groups, line, precision) {
  if (line.parent_state !== 'posted') return;
  const accountId = relationId(line.account_id);
  if (!accountId) throw new Error(`Posted journal item ${line.id} has no account_id`);
  let group = groups.get(accountId);
  if (!group) {
    group = {
      accountId, accountCode: normalizeOdooString(line.export_account_code),
      accountName: normalizeOdooString(line.export_account_name) ?? relationName(line.account_id),
      debit: 0n, credit: 0n, balance: 0n, lineCount: 0,
    };
    groups.set(accountId, group);
  }
  group.debit += toUnits(line.debit, precision);
  group.credit += toUnits(line.credit, precision);
  group.balance += toUnits(line.balance, precision);
  group.lineCount += 1;
}

function compareNullableStrings(left, right, locale) {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  return String(left).localeCompare(String(right), locale);
}

function tbRows(groups, precision) {
  return [...groups.values()].sort((a, b) =>
    compareNullableStrings(a.accountCode, b.accountCode, 'en') || a.accountId - b.accountId
  ).map((g) => ({
    account_id: g.accountId, account_code: g.accountCode, account_name: g.accountName,
    debit: fromUnits(g.debit, precision), credit: fromUnits(g.credit, precision),
    balance: fromUnits(g.balance, precision), line_count: g.lineCount,
  }));
}

function trialBalanceDiffRows(clientGroups, serverGroups, accounts, precision) {
  const ids = [...new Set([...clientGroups.keys(), ...serverGroups.keys()])].sort((a, b) => a - b);
  return ids.map((id) => {
    const client = clientGroups.get(id) || { debit: 0n, credit: 0n, balance: 0n };
    const server = serverGroups.get(id) || { debit: 0n, credit: 0n, balance: 0n };
    const account = accounts.get(id);
    return {
      account_id: id, account_code: normalizeOdooString(account?.code),
      account_name: normalizeOdooString(account?.name),
      client_debit: fromUnits(client.debit, precision), server_debit: fromUnits(server.debit, precision),
      diff_debit: fromUnits(client.debit - server.debit, precision),
      client_credit: fromUnits(client.credit, precision), server_credit: fromUnits(server.credit, precision),
      diff_credit: fromUnits(client.credit - server.credit, precision),
      client_balance: fromUnits(client.balance, precision), server_balance: fromUnits(server.balance, precision),
      diff_balance: fromUnits(client.balance - server.balance, precision),
    };
  });
}

function nonzeroTrialBalanceDiffs(diffRows, precision) {
  const zero = fromUnits(0n, precision);
  return diffRows.filter((row) =>
    row.diff_debit !== zero || row.diff_credit !== zero || row.diff_balance !== zero
  );
}

function trialBalanceDiffFailure(nonzeroDiffs) {
  return nonzeroDiffs.length ? `${nonzeroDiffs.length} trial-balance account diff(s) are nonzero` : null;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) || (typeof value === 'object') ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function writeChunk(stream, text) {
  if (!stream.write(text, 'utf8')) await once(stream, 'drain');
}

async function replaceFile(temp, target) {
  try {
    await fsp.rename(temp, target);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fsp.unlink(target);
    await fsp.rename(temp, target);
  }
}

async function writeCsv(file, headers, rows) {
  const temp = `${file}.tmp-${process.pid}`;
  const stream = fs.createWriteStream(temp, { encoding: 'utf8' });
  try {
    await writeChunk(stream, `\uFEFF${headers.map(csvCell).join(',')}\r\n`);
    for await (const row of rows) {
      await writeChunk(stream, `${headers.map((header) => csvCell(row[header])).join(',')}\r\n`);
    }
    stream.end();
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw error;
  }
  await replaceFile(temp, file);
}

async function writeJsonl(file, rows) {
  const temp = `${file}.tmp-${process.pid}`;
  const stream = fs.createWriteStream(temp, { encoding: 'utf8' });
  try {
    for await (const row of rows) await writeChunk(stream, `${JSON.stringify(row)}\n`);
    stream.end();
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw error;
  }
  await replaceFile(temp, file);
}

async function currencyPrecision(rpc, company, context) {
  const currencyId = relationId(company.currency_id);
  if (!currencyId) throw new Error(`${company.code}: res.company has no currency_id`);
  const rows = await rpc.execute('res.currency', 'read', [[currencyId], ['decimal_places', 'rounding']], { context });
  const currency = rows[0];
  if (!currency) throw new Error(`${company.code}: cannot read company currency ${currencyId}`);
  if (Number.isInteger(currency.decimal_places)) return currency.decimal_places;
  const rounding = Number(currency.rounding);
  if (!(rounding > 0)) throw new Error(`${company.code}: currency has no usable decimal precision`);
  return Math.max(0, Math.round(-Math.log10(rounding)));
}

const GL_HEADERS = [
  'id', 'date', 'export_move_name', 'ref', 'journal_id', 'export_journal_name',
  'account_id', 'export_account_code', 'export_account_name', 'partner_id',
  'export_partner_name', 'name', 'debit', 'credit', 'balance', 'amount_currency',
  'currency_id', 'tax_ids', 'tax_line_id', 'reconciled', 'full_reconcile_id',
  'matching_number', 'parent_state', 'date_maturity', 'amount_residual',
  'amount_residual_currency', 'display_type', 'analytic_distribution', 'product_id',
  'quantity', 'price_unit', 'move_id', 'company_id', 'create_date', 'write_date',
];

const TB_HEADERS = ['account_id', 'account_code', 'account_name', 'debit', 'credit', 'balance', 'line_count'];
const TB_DIFF_HEADERS = [
  'account_id', 'account_code', 'account_name', 'client_debit', 'server_debit', 'diff_debit',
  'client_credit', 'server_credit', 'diff_credit', 'client_balance', 'server_balance', 'diff_balance',
];
const LEDGER_HEADERS = [
  'row_type', 'partner_id', 'partner_name', 'date', 'move_name', 'ref', 'journal_name',
  'account_code', 'account_name', 'account_type', 'label', 'debit', 'credit', 'balance',
  'line_id', 'parent_state',
];

async function deriveCompany({ rpc, runDir, company, accounts, precision }) {
  const context = companyContext(company.id);
  const dir = path.join(runDir, company.code);
  const linesFile = path.join(dir, 'account.move.line.jsonl');
  const clientGroups = new Map();
  let totalDebit = 0n;
  let totalCredit = 0n;
  const warnings = new Map();
  for await (const line of jsonlRecords(linesFile)) {
    addTbLine(clientGroups, line, precision);
    noteMissingPostedAccountCode(warnings, line, accounts, company.code);
    if (line.parent_state === 'posted') {
      totalDebit += toUnits(line.debit, precision);
      totalCredit += toUnits(line.credit, precision);
    }
  }
  const clientRows = tbRows(clientGroups, precision);
  await writeJsonl(path.join(dir, 'trial_balance_client.jsonl'), clientRows);
  await writeCsv(path.join(dir, 'trial_balance_client.csv'), TB_HEADERS, clientRows);

  const domain = [['company_id', '=', company.id], ['parent_state', '=', 'posted']];
  const grouped = await groupSums(
    rpc, 'account.move.line', domain, 'account_id', ['debit', 'credit', 'balance'], context
  );
  const serverGroups = new Map();
  for (const row of grouped) {
    const accountId = relationId(row.account_id);
    if (!accountId) continue;
    const account = accounts.get(accountId);
    serverGroups.set(accountId, {
      accountId, accountCode: normalizeOdooString(account?.code),
      accountName: normalizeOdooString(account?.name) ?? relationName(row.account_id),
      debit: toUnits(row.debit, precision), credit: toUnits(row.credit, precision),
      balance: toUnits(row.balance, precision), lineCount: row.__count || row.account_id_count || 0,
    });
  }
  const serverRows = tbRows(serverGroups, precision);
  await writeJsonl(path.join(dir, 'trial_balance_server.jsonl'), serverRows);
  await writeCsv(path.join(dir, 'trial_balance_server.csv'), TB_HEADERS, serverRows);

  const diffRows = trialBalanceDiffRows(clientGroups, serverGroups, accounts, precision);
  await writeJsonl(path.join(dir, 'trial_balance_diff.jsonl'), diffRows);
  await writeCsv(path.join(dir, 'trial_balance_diff.csv'), TB_DIFF_HEADERS, diffRows);

  await writeCsv(path.join(dir, 'gl.csv'), GL_HEADERS, jsonlRecords(linesFile));
  const ledgerResult = await writePartnerLedger(dir, linesFile, accounts, precision);
  const nonzeroDiffs = nonzeroTrialBalanceDiffs(diffRows, precision);
  const failures = [];
  if (totalDebit !== totalCredit) {
    failures.push(`posted debit ${fromUnits(totalDebit, precision)} != credit ${fromUnits(totalCredit, precision)}`);
  }
  const tbDiffFailure = trialBalanceDiffFailure(nonzeroDiffs);
  if (tbDiffFailure) failures.push(tbDiffFailure);
  return {
    company: company.code, currencyPrecision: precision,
    postedDebit: fromUnits(totalDebit, precision), postedCredit: fromUnits(totalCredit, precision),
    trialBalanceAccounts: clientRows.length, trialBalanceNonzeroDiffs: nonzeroDiffs.length,
    partnerLedgerLines: ledgerResult.detailRows, partnerLedgerPartners: ledgerResult.partnerCount,
    failures, warnings: [...warnings.values()].sort((a, b) => a.accountId - b.accountId),
  };
}

function noteMissingPostedAccountCode(warnings, line, accounts, companyCode) {
  if (line.parent_state !== 'posted') return;
  const accountId = relationId(line.account_id);
  const account = accounts.get(accountId);
  if (!account || normalizeOdooString(account.code) !== null || warnings.has(accountId)) return;
  warnings.set(accountId, {
    type: MISSING_POSTED_ACCOUNT_CODE_WARNING,
    company: companyCode,
    accountId,
    accountName: normalizeOdooString(account.name) ?? relationName(line.account_id),
  });
}

function replaceCompanyWarnings(manifest, companyCode, warnings) {
  manifest.warnings = [
    ...(Array.isArray(manifest.warnings) ? manifest.warnings : []).filter((warning) =>
      warning.type !== MISSING_POSTED_ACCOUNT_CODE_WARNING || warning.company !== companyCode
    ),
    ...warnings,
  ];
}

async function writePartnerLedger(dir, linesFile, accounts, precision) {
  const eligible = new Set([...accounts.values()]
    .filter((a) => a.account_type === 'asset_receivable' || a.account_type === 'liability_payable')
    .map((a) => a.id));
  const totals = new Map();
  let detailRows = 0;

  const jsonTarget = path.join(dir, 'partner_ledger.jsonl');
  const csvTarget = path.join(dir, 'partner_ledger.csv');
  const jsonTemp = `${jsonTarget}.tmp-${process.pid}`;
  const csvTemp = `${csvTarget}.tmp-${process.pid}`;
  const jsonStream = fs.createWriteStream(jsonTemp, { encoding: 'utf8' });
  const csvStream = fs.createWriteStream(csvTemp, { encoding: 'utf8' });
  const emit = async (row) => {
    await writeChunk(jsonStream, `${JSON.stringify(row)}\n`);
    await writeChunk(csvStream, `${LEDGER_HEADERS.map((header) => csvCell(row[header])).join(',')}\r\n`);
  };
  try {
    await writeChunk(csvStream, `\uFEFF${LEDGER_HEADERS.map(csvCell).join(',')}\r\n`);
    for await (const line of jsonlRecords(linesFile)) {
      const accountId = relationId(line.account_id);
      if (line.parent_state !== 'posted' || !eligible.has(accountId)) continue;
      const partnerId = relationId(line.partner_id) || 0;
      const partnerName = partnerId
        ? normalizeOdooString(line.export_partner_name) ?? relationName(line.partner_id)
        : '(No partner)';
      const account = accounts.get(accountId);
      let total = totals.get(partnerId);
      if (!total) total = { partnerId, partnerName, debit: 0n, credit: 0n, balance: 0n, lines: 0 };
      total.debit += toUnits(line.debit, precision);
      total.credit += toUnits(line.credit, precision);
      total.balance += toUnits(line.balance, precision);
      total.lines += 1;
      totals.set(partnerId, total);
      detailRows += 1;
      await emit({
        row_type: 'detail', partner_id: partnerId || '', partner_name: partnerName,
        date: line.date, move_name: line.export_move_name, ref: line.ref,
        journal_name: normalizeOdooString(line.export_journal_name),
        account_code: normalizeOdooString(account?.code),
        account_name: normalizeOdooString(account?.name), account_type: account?.account_type ?? '',
        label: normalizeOdooString(line.name),
        debit: line.debit, credit: line.credit, balance: line.balance, line_id: line.id,
        parent_state: line.parent_state,
      });
    }
    for (const total of [...totals.values()].sort((a, b) =>
      compareNullableStrings(a.partnerName, b.partnerName, 'th') || a.partnerId - b.partnerId
    )) {
      await emit({
        row_type: 'partner_total', partner_id: total.partnerId || '', partner_name: total.partnerName,
        label: `${total.lines} line(s)`, debit: fromUnits(total.debit, precision),
        credit: fromUnits(total.credit, precision), balance: fromUnits(total.balance, precision),
        parent_state: 'posted',
      });
    }
    jsonStream.end();
    csvStream.end();
    await Promise.all([once(jsonStream, 'finish'), once(csvStream, 'finish')]);
  } catch (error) {
    jsonStream.destroy();
    csvStream.destroy();
    throw error;
  }
  await replaceFile(jsonTemp, jsonTarget);
  await replaceFile(csvTemp, csvTarget);
  return { detailRows, partnerCount: totals.size };
}

async function smoke(rpc, companies) {
  const allIds = companies.map((x) => x.id);
  const keyModels = ['account.account', 'account.journal', 'account.tax', 'account.move', 'account.move.line'];
  const rows = [];
  const globalPartners = await rpc.execute('res.partner', 'search_count', [[]], {
    context: { allowed_company_ids: allIds, active_test: false },
  });
  console.log(`Visible partners (global): ${globalPartners}`);
  for (const company of companies) {
    const context = companyContext(company.id);
    for (const model of keyModels) {
      const domain = await companyDomain(rpc, model, company.id, context);
      const count = await rpc.execute(model, 'search_count', [domain], { context });
      rows.push({ company: company.code, model, count });
    }
  }
  console.table(rows);
  try {
    const attachmentGroups = await groupSums(
      rpc, 'ir.attachment', [], 'res_model', [],
      { allowed_company_ids: allIds, active_test: false }
    );
    console.log('Attachment metadata counts by res_model (files are not downloaded):');
    console.table(attachmentGroups.map((row) => ({
      res_model: row.res_model || '(none)', count: row.__count || 0,
    })));
  } catch (error) {
    console.warn(`WARNING: attachment metadata check skipped: ${safeRpcMessage(error)}`);
  }
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function runFull(rpc, companies, args) {
  const allIds = companies.map((x) => x.id);
  const runDir = args.resume || args.output || path.join(os.homedir(), 'OdooRescue', timestampForPath());
  if (args.resume && !(await fileExists(runDir))) {
    throw new Error(`--resume directory does not exist: ${runDir}`);
  }
  if (args.output && await fileExists(runDir)) {
    const contents = await fsp.readdir(runDir);
    if (contents.length) throw new Error(`--output directory already exists and is not empty: ${runDir}`);
  }
  await fsp.mkdir(path.join(runDir, '_global'), { recursive: true });
  for (const company of companies) await fsp.mkdir(path.join(runDir, company.code), { recursive: true });
  const manifestFile = path.join(runDir, 'manifest.json');
  let manifest = await readJsonIfExists(manifestFile);
  if (args.resume && !manifest) {
    throw new Error(`--resume directory has no manifest.json: ${runDir}`);
  }
  if (!manifest) {
    manifest = {
      schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), outputDirectory: runDir,
      companies: companies.map(({ id, name, code, active }) => ({ id, name, code, active })),
      entries: [], beYearFlags: [], verification: [], warnings: [], errors: [],
    };
  } else {
    const prior = JSON.stringify(manifest.companies.map((x) => [x.id, x.name, x.code]));
    const current = JSON.stringify(companies.map((x) => [x.id, x.name, x.code]));
    if (prior !== current) throw new Error('The discovered company mapping differs from the resumed run manifest.');
    manifest.status = 'running';
    manifest.resumedAt = new Date().toISOString();
  }
  if (!Array.isArray(manifest.warnings)) manifest.warnings = [];
  await atomicWriteJson(manifestFile, manifest);

  const upsertEntry = async (entry, stats) => {
    const index = manifest.entries.findIndex((x) => x.scope === entry.scope && x.model === entry.model);
    if (index >= 0) manifest.entries[index] = entry;
    else manifest.entries.push(entry);
    for (const flag of stats.beYearFlags) {
      manifest.beYearFlags.push({ scope: entry.scope, model: entry.model, ...flag });
    }
    await atomicWriteJson(manifestFile, manifest);
  };

  try {
    const globalContext = { allowed_company_ids: allIds, active_test: false };
    for (const modelSpec of GLOBAL_SPECS) {
      console.log(`Exporting _global/${modelSpec.model} ...`);
      const entry = await extractModel({
        rpc, runDir, scope: '_global', outDir: path.join(runDir, '_global'), modelSpec,
        domain: [], context: globalContext, batchSize: CONFIG.batchSize,
      });
      const stats = await scanJsonl(path.join(runDir, '_global', `${modelSpec.model}.jsonl`));
      await upsertEntry(entry, stats);
    }

    for (const company of companies) {
      const context = companyContext(company.id);
      const accountsFile = path.join(runDir, company.code, 'account.account.jsonl');
      let accounts = new Map();
      for (const modelSpec of COMPANY_SPECS) {
        console.log(`Exporting ${company.code}/${modelSpec.model} ...`);
        const domain = await companyDomain(rpc, modelSpec.model, company.id, context);
        const transform = modelSpec.model === 'account.move.line'
          ? (row) => enrichMoveLine(row, accounts) : null;
        const entry = await extractModel({
          rpc, runDir, scope: company.code, outDir: path.join(runDir, company.code), modelSpec,
          domain, context, batchSize: CONFIG.batchSize, transform,
        });
        const dataFile = path.join(runDir, company.code, `${modelSpec.model}.jsonl`);
        const stats = await scanJsonl(dataFile);
        await upsertEntry(entry, stats);
        if (modelSpec.model === 'account.account') accounts = await loadAccountMap(accountsFile);
      }
      const precision = await currencyPrecision(rpc, company, context);
      console.log(`Building and verifying ${company.code} ledgers ...`);
      const verification = await deriveCompany({ rpc, runDir, company, accounts, precision });
      const index = manifest.verification.findIndex((x) => x.company === company.code);
      if (index >= 0) manifest.verification[index] = verification;
      else manifest.verification.push(verification);
      replaceCompanyWarnings(manifest, company.code, verification.warnings);
      await atomicWriteJson(manifestFile, manifest);
    }

    // Rebuild BE flags deterministically so resume does not duplicate alerts.
    manifest.beYearFlags = [];
    for (const entry of manifest.entries) {
      const file = path.join(runDir, entry.scope, entry.file);
      const stats = await scanJsonl(file);
      for (const flag of stats.beYearFlags) manifest.beYearFlags.push({ scope: entry.scope, model: entry.model, ...flag });
    }
    const failures = manifest.verification.flatMap((x) => x.failures.map((message) => `${x.company}: ${message}`));
    if (manifest.beYearFlags.length) {
      failures.push(`BUDDHIST-ERA DATE ALERT: ${manifest.beYearFlags.length} extracted date value(s) have year >= 2400`);
    }
    manifest.status = failures.length ? 'failed' : 'complete';
    manifest.completedAt = new Date().toISOString();
    manifest.errors = failures;
    await atomicWriteJson(manifestFile, manifest);
    if (failures.length) throw new Error(`Post-checks failed:\n- ${failures.join('\n- ')}`);
    console.log(`Rescue complete and verified: ${runDir}`);
    return runDir;
  } catch (error) {
    manifest.status = 'failed';
    manifest.errors = [...new Set([
      ...(manifest.errors || []), safeRpcMessage(error, process.env.ODOO_API_KEY),
    ])];
    manifest.failedAt = new Date().toISOString();
    await atomicWriteJson(manifestFile, manifest);
    throw error;
  }
}

class FakeRpc {
  constructor(rows, {
    failOnSearchRead = null, groupMethod = null, groupRows = [], expectedCompanyId = null,
    fieldsByModel = {},
  } = {}) {
    this.rows = rows;
    this.failOnSearchRead = failOnSearchRead;
    this.groupMethod = groupMethod;
    this.groupRows = groupRows;
    this.expectedCompanyId = expectedCompanyId;
    this.fieldsByModel = fieldsByModel;
    this.searchReadCalls = 0;
  }

  async execute(model, method, args, kwargs) {
    if (this.expectedCompanyId !== null) {
      const context = kwargs?.context;
      assert(Array.isArray(context?.allowed_company_ids) && context.allowed_company_ids.length === 1 &&
        context.allowed_company_ids[0] === this.expectedCompanyId && context.company_id === this.expectedCompanyId,
      `${model}.${method} must use only company ${this.expectedCompanyId} in its context`);
    }
    if (method === 'fields_get') {
      return this.fieldsByModel[model] || {
        id: { type: 'integer' }, date: { type: 'date' }, account_id: { type: 'many2one' },
        parent_state: { type: 'selection' }, debit: { type: 'monetary' }, credit: { type: 'monetary' },
        balance: { type: 'monetary' },
      };
    }
    if (method === 'search_count') return this.rows.length;
    if (method === 'search_read') {
      this.searchReadCalls += 1;
      if (this.searchReadCalls === this.failOnSearchRead) throw new Error('fixture crash');
      const domain = args[0];
      const cursor = domain.find((term) => term[0] === 'id' && term[1] === '>')?.[2] || 0;
      return this.rows.filter((row) => row.id > cursor).slice(0, kwargs.limit);
    }
    if (method === 'formatted_read_group' || method === 'read_group') {
      if (method === this.groupMethod) return this.groupRows;
      throw new Error(`The method '${model}.${method}' does not exist`);
    }
    throw new Error(`FakeRpc does not implement ${model}.${method}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`SELFTEST ASSERTION FAILED: ${message}`);
}

async function selftest() {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'odoo-rescue-selftest-'));
  try {
    const rows = [
      { id: 1, date: '2025-01-01', account_id: [10, '1000 Cash'], parent_state: 'posted', debit: 100, credit: 0, balance: 100 },
      { id: 2, date: '2025-01-01', account_id: [20, '2000 Equity'], parent_state: 'posted', debit: 0, credit: 100, balance: -100 },
      { id: 3, date: '2025-01-02', account_id: [10, '1000 Cash'], parent_state: 'draft', debit: 5, credit: 0, balance: 5 },
      { id: 4, date: '2025-01-03', account_id: [10, '1000 Cash'], parent_state: 'posted', debit: 25.25, credit: 0, balance: 25.25 },
      { id: 5, date: '2025-01-03', account_id: [20, '2000 Equity'], parent_state: 'posted', debit: 0, credit: 25.25, balance: -25.25 },
    ];
    const fixtureSpec = spec('fixture.line', [
      'id', 'date', 'account_id', 'parent_state', 'debit', 'credit', 'balance', 'optional_note',
    ],
      ['id', 'date', 'account_id', 'parent_state', 'debit', 'credit', 'balance']);

    const expectedCompanyId = 37;
    const scopedContext = companyContext(expectedCompanyId);
    const fieldsByModel = Object.fromEntries(COMPANY_SPECS.map((modelSpec) => [
      modelSpec.model,
      Object.fromEntries(modelSpec.fields
        .filter((field) => modelSpec.model !== 'account.account' || field !== 'company_id')
        .map((field) => [field, { type: field === 'id' ? 'integer' :
          field === 'company_ids' ? 'many2many' : field === 'company_id' ? 'many2one' : 'char' }])),
    ]));
    for (const modelSpec of COMPANY_SPECS) {
      const scopedRpc = new FakeRpc([], { expectedCompanyId, fieldsByModel });
      const domain = await companyDomain(scopedRpc, modelSpec.model, expectedCompanyId, scopedContext);
      const expectedDomainField = modelSpec.model === 'account.account' ? 'company_ids' : 'company_id';
      const domainCompanyId = Array.isArray(domain[0][2]) ? domain[0][2][0] : domain[0][2];
      assert(domain[0][0] === expectedDomainField && domainCompanyId === expectedCompanyId,
        `${modelSpec.model} must retain its company domain`);
      await extractModel({
        rpc: scopedRpc, runDir: scratch, scope: 'COMPANY_CONTEXT',
        outDir: path.join(scratch, 'COMPANY_CONTEXT'), modelSpec, domain,
        context: scopedContext, batchSize: 2,
      });
    }

    const outDir = path.join(scratch, 'TEST');
    const firstRpc = new FakeRpc(rows, { failOnSearchRead: 2 });
    let crashed = false;
    try {
      await extractModel({ rpc: firstRpc, runDir: scratch, scope: 'TEST', outDir, modelSpec: fixtureSpec,
        domain: [], context: {}, batchSize: 2 });
    } catch (error) {
      crashed = error.message === 'fixture crash';
    }
    assert(crashed, 'fixture must simulate a crash after the first checkpoint');
    const recoveredEntry = await extractModel({
      rpc: new FakeRpc(rows), runDir: scratch, scope: 'TEST', outDir, modelSpec: fixtureSpec,
      domain: [], context: {}, batchSize: 2 });
    const dataFile = path.join(outDir, 'fixture.line.jsonl');
    const recovered = [];
    for await (const row of jsonlRecords(dataFile)) recovered.push(row);
    assert(recovered.length === 5, 'resume must produce five rows without duplicates');
    assert(new Set(recovered.map((x) => x.id)).size === 5, 'resume ids must be unique');
    assert(JSON.stringify(recoveredEntry.omittedFields) === JSON.stringify(['optional_note']),
      'manifest entry must report requested fields omitted by the live model');

    const appendCrashOutDir = path.join(scratch, 'APPEND_CRASH');
    let appendedBatches = 0;
    let appendCrash = false;
    try {
      await extractModel({
        rpc: new FakeRpc(rows), runDir: scratch, scope: 'APPEND_CRASH', outDir: appendCrashOutDir,
        modelSpec: fixtureSpec, domain: [], context: {}, batchSize: 2,
        afterBatchAppend: () => {
          appendedBatches += 1;
          if (appendedBatches === 2) throw new Error('fixture post-append crash');
        },
      });
    } catch (error) {
      appendCrash = error.message === 'fixture post-append crash';
    }
    assert(appendCrash, 'fixture must crash after appending a batch but before its checkpoint');
    const appendCrashFile = path.join(appendCrashOutDir, 'fixture.line.jsonl');
    const appendCrashCheckpointFile = path.join(
      scratch, '.checkpoints', checkpointName('APPEND_CRASH', 'fixture.line')
    );
    const appendCrashCheckpoint = await readJsonIfExists(appendCrashCheckpointFile);
    const excessSize = (await fsp.stat(appendCrashFile)).size;
    assert(excessSize > appendCrashCheckpoint.bytes, 'crashed data file must contain uncheckpointed excess bytes');
    await extractModel({
      rpc: new FakeRpc(rows), runDir: scratch, scope: 'APPEND_CRASH', outDir: appendCrashOutDir,
      modelSpec: fixtureSpec, domain: [], context: {}, batchSize: 2,
    });
    const appendCrashRecovered = [];
    for await (const row of jsonlRecords(appendCrashFile)) appendCrashRecovered.push(row);
    assert(JSON.stringify(appendCrashRecovered) === JSON.stringify(rows),
      'resume must truncate excess bytes and produce the exact expected row set');
    assert(new Set(appendCrashRecovered.map((x) => x.id)).size === rows.length,
      'post-append crash recovery must not duplicate ids');

    const groups = new Map();
    for (const row of recovered) {
      const accountDisplayName = relationName(row.account_id);
      row.export_account_code = String(accountDisplayName ?? '').split(' ')[0] || null;
      row.export_account_name = accountDisplayName;
      addTbLine(groups, row, 2);
    }
    const grouped = tbRows(groups, 2);
    assert(grouped.length === 2, 'TB must contain two posted accounts');
    assert(grouped.find((x) => x.account_id === 10).debit === '125.25', 'TB debit grouping');
    assert(grouped.find((x) => x.account_id === 20).credit === '125.25', 'TB credit grouping');

    const falseScalarAccounts = new Map([
      [30, { id: 30, code: false, name: 'Receivable Without Code', account_type: 'asset_receivable' }],
      [40, { id: 40, code: '4000', name: 'Named Account', account_type: 'asset_receivable' }],
    ]);
    const falseScalarLines = [
      { id: 30, date: false, account_id: [30, 'Receivable Without Code'], partner_id: [300, false],
        name: false, move_name: false, export_move_name: false, ref: false, export_journal_name: false,
        export_account_code: false, export_account_name: 'Receivable Without Code',
        export_partner_name: false, parent_state: 'posted', debit: 1, credit: 0, balance: 1 },
      { id: 40, date: '2025-01-04', account_id: [40, '4000 Named Account'], partner_id: [400, 'Named Partner'],
        name: 'Named line', export_move_name: 'MOVE/40', ref: 'REF/40', export_journal_name: 'Journal',
        export_account_code: '4000', export_account_name: 'Named Account',
        export_partner_name: 'Named Partner', parent_state: 'posted', debit: 0, credit: 1, balance: -1 },
    ];
    const falseScalarLinesFile = path.join(scratch, 'false-scalars.jsonl');
    await writeJsonl(falseScalarLinesFile, falseScalarLines);
    const falseScalarGroups = new Map();
    const warningMap = new Map();
    for await (const line of jsonlRecords(falseScalarLinesFile)) {
      addTbLine(falseScalarGroups, line, 2);
      noteMissingPostedAccountCode(warningMap, line, falseScalarAccounts, 'TEST');
    }
    const falseScalarTb = tbRows(falseScalarGroups, 2);
    assert(falseScalarTb.length === 2 && falseScalarTb[1].account_id === 30 &&
      falseScalarTb[1].account_code === null, 'TB must sort a false/null account code last');
    const falseScalarTbCsv = path.join(scratch, 'false-scalar-tb.csv');
    await writeCsv(falseScalarTbCsv, TB_HEADERS, falseScalarTb);
    assert(!(await fsp.readFile(falseScalarTbCsv, 'utf8')).includes('false'),
      'TB CSV must render normalized false string fields as empty');
    await writePartnerLedger(scratch, falseScalarLinesFile, falseScalarAccounts, 2);
    const ledgerRows = [];
    for await (const row of jsonlRecords(path.join(scratch, 'partner_ledger.jsonl'))) ledgerRows.push(row);
    const ledgerTotals = ledgerRows.filter((row) => row.row_type === 'partner_total');
    assert(ledgerTotals.length === 2 && ledgerTotals[1].partner_id === 300 &&
      ledgerTotals[1].partner_name === null, 'partner ledger must sort a false/null partner name last');
    assert(!(await fsp.readFile(path.join(scratch, 'partner_ledger.csv'), 'utf8')).includes('false'),
      'partner-ledger CSV must render normalized false string fields as empty');
    const warningManifest = { warnings: [] };
    replaceCompanyWarnings(warningManifest, 'TEST', [...warningMap.values()]);
    const warningManifestFile = path.join(scratch, 'warning-manifest.json');
    await atomicWriteJson(warningManifestFile, warningManifest);
    const writtenWarningManifest = await readJsonIfExists(warningManifestFile);
    assert(writtenWarningManifest.warnings.length === 1 &&
      writtenWarningManifest.warnings[0].accountId === 30 &&
      writtenWarningManifest.warnings[0].accountName === 'Receivable Without Code',
    'manifest must warn with the id and name of a posted-line account whose code was false');

    const formattedGroupRows = [
      { account_id: [10, '1000 Cash'], 'debit:sum': 125.25, 'credit:sum': 0, 'balance:sum': 125.25, __count: 2 },
      { account_id: [20, '2000 Equity'], 'debit:sum': 0, 'credit:sum': 125.25, 'balance:sum': -125.25, __count: 2 },
    ];
    const legacyGroupRows = [
      { account_id: [10, '1000 Cash'], debit: 125.25, credit: 0, balance: 125.25, account_id_count: 2 },
      { account_id: [20, '2000 Equity'], debit: 0, credit: 125.25, balance: -125.25, account_id_count: 2 },
    ];
    const groupArgs = ['fixture.line', [], 'account_id', ['debit', 'credit', 'balance'], {}];
    const formattedSums = await groupSums(
      new FakeRpc(rows, { groupMethod: 'formatted_read_group', groupRows: formattedGroupRows }), ...groupArgs
    );
    const legacySums = await groupSums(
      new FakeRpc(rows, { groupMethod: 'read_group', groupRows: legacyGroupRows }), ...groupArgs
    );
    assert(JSON.stringify(formattedSums) === JSON.stringify(legacySums),
      'formatted_read_group and read_group must normalize to identical sums');
    const serverGroups = new Map([...groups].map(([id, group]) => [id, { ...group }]));
    serverGroups.get(10).debit -= 1n;
    serverGroups.get(10).balance -= 1n;
    const accounts = new Map([
      [10, { code: '1000', name: 'Cash' }],
      [20, { code: '2000', name: 'Equity' }],
    ]);
    const deliberateDiffs = nonzeroTrialBalanceDiffs(
      trialBalanceDiffRows(groups, serverGroups, accounts, 2), 2
    );
    assert(deliberateDiffs.length === 1 && deliberateDiffs[0].diff_debit === '0.01',
      'client-vs-server TB mismatch must be detected');
    assert(trialBalanceDiffFailure(deliberateDiffs) === '1 trial-balance account diff(s) are nonzero',
      'client-vs-server TB mismatch must be reported as a verification failure');

    const csvFile = path.join(scratch, 'writer.csv');
    const jsonFile = path.join(scratch, 'writer.jsonl');
    const writerRows = [{ name: 'ภาษาไทย, "quoted"', amount: '125.25' }];
    await writeCsv(csvFile, ['name', 'amount'], writerRows);
    await writeJsonl(jsonFile, writerRows);
    const csv = await fsp.readFile(csvFile);
    assert(csv.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'CSV must start with UTF-8 BOM');
    assert((await scanJsonl(jsonFile)).rows === 1, 'JSONL writer must round-trip one row');

    const checkpoint = await readJsonIfExists(path.join(scratch, '.checkpoints', checkpointName('TEST', 'fixture.line')));
    assert(checkpoint.complete && checkpoint.rows === 5 && checkpoint.lastId === 5, 'checkpoint must finish at id 5');
    console.log('SELFTEST PASS: single-company contexts/domains, pager, both crash/resume paths, field omissions, both group APIs, TB grouping/diffs, ' +
      'false-string normalization/warnings, partner ledger, JSONL writer, CSV BOM/escaping, and checkpoints.');
  } finally {
    const resolved = path.resolve(scratch);
    const tempRoot = path.resolve(os.tmpdir());
    if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith('odoo-rescue-selftest-')) {
      throw new Error(`Refusing to remove unexpected selftest path: ${resolved}`);
    }
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log(usage());
    return;
  }
  if (args.mode === 'selftest') {
    await selftest();
    return;
  }
  const url = process.env.ODOO_URL || 'https://appoint.odoo.com';
  const db = process.env.ODOO_DB || 'appoint';
  const login = process.env.ODOO_LOGIN;
  const apiKey = process.env.ODOO_API_KEY;
  if (!login || !apiKey) {
    throw new Error('Set ODOO_LOGIN and ODOO_API_KEY in the environment. The API key is never printed.');
  }
  const rpc = new RpcClient({
    url, db, login, apiKey, maxRetries: CONFIG.maxRetries, timeoutMs: CONFIG.requestTimeoutMs,
  });
  await rpc.authenticate();
  console.log('Authenticated. Discovering companies (credentials are not displayed) ...');
  const companies = await discoverCompanies(rpc);
  if (args.mode === 'smoke') {
    await smoke(rpc, companies);
    console.log('SMOKE PASS: authentication, company mapping, counts, and attachment metadata completed; no files were written.');
    return;
  }
  await runFull(rpc, companies, args);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${safeRpcMessage(error, process.env.ODOO_API_KEY)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIG, RpcClient, groupSums, extractModel, addTbLine, tbRows, writeCsv, writeJsonl, selftest,
};
