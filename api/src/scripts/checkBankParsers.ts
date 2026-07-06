// Regression + real-file check for the bank parsers (parseKbiz / parseKshop / dedupe).
// No test framework exists in this repo (see test-parse-stock.ts) — plain script, exits 1
// on any failure, prints PASS/FAIL per case.
//
//   npx tsx src/scripts/checkBankParsers.ts
//
// Runs against the committed sanitized fixtures (always), AND against the owner's real
// exports at C:\Users\khunn\Downloads\Bank\*.csv when present on the build machine (never
// committed — silently skipped if absent, e.g. in CI).
import { readFileSync, existsSync } from 'node:fs';
import { parseKbiz } from '../bank/parseKbiz.js';
import { parseKshop } from '../bank/parseKshop.js';
import { computeDedupeKey, makeUniqueDedupeKeys } from '../bank/dedupe.js';

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    failed++;
  }
}

const FIXTURES_DIR = new URL('../bank/fixtures/', import.meta.url);

// ── Fixture: K SHOP ──────────────────────────────────────────────────────────
{
  const buf = readFileSync(new URL('kshop.sample.csv', FIXTURES_DIR));
  const text = buf.toString('utf8');
  const result = parseKshop(text);

  check(result.source === 'kshop', 'kshop fixture: source === kshop');
  check(result.parsed === 8, `kshop fixture: parsed === 8 (got ${result.parsed})`);
  check(result.excluded === 1, `kshop fixture: excluded === 1, the Void row (got ${result.excluded})`);
  check(result.rows.length === 7, `kshop fixture: rows.length === 7 (got ${result.rows.length})`);
  check(result.rows.every((r) => r.direction === 'in'), 'kshop fixture: every row direction === in');
  check(result.rows.every((r) => r.channel === 'K SHOP'), 'kshop fixture: every row channel === K SHOP');

  // K PLUS row (no quoted bank field variance) still parses payer + bank.
  const kplusRow = result.rows.find((r) => r.amount === '3230.00');
  check(!!kplusRow, 'kshop fixture: K PLUS row (3230.00) present');
  check(kplusRow?.payerBank === 'K PLUS', `kshop fixture: K PLUS row payerBank === "K PLUS" (got ${kplusRow?.payerBank})`);
  check(!!kplusRow?.payerName.includes('ตัวอย่างสี่'), 'kshop fixture: K PLUS row payerName captured');

  // The identical-duplicate pair (rows 6 and 8 in the CSV) both come through the parser
  // (dedup is an import-time concern, not a parse-time one) with identical txnAt/amount/details.
  const dupRows = result.rows.filter((r) => r.amount === '6072.00');
  check(dupRows.length === 2, `kshop fixture: duplicate pair both parsed (got ${dupRows.length})`);
  check(
    dupRows.length === 2 && dupRows[0].txnAt.getTime() === dupRows[1].txnAt.getTime() && dupRows[0].details === dupRows[1].details,
    'kshop fixture: duplicate pair has identical txnAt + details (would collide on dedupeKey)',
  );

  // Void row must not appear anywhere in rows.
  check(!result.rows.some((r) => r.details.includes('ยกเลิก')), 'kshop fixture: Void row excluded from output');
}

// ── Fixture: KBIZ ────────────────────────────────────────────────────────────
{
  const buf = readFileSync(new URL('kbiz.sample.csv', FIXTURES_DIR));
  const result = parseKbiz(buf);

  check(result.source === 'kbiz', 'kbiz fixture: source === kbiz');
  check(result.parsed === 10, `kbiz fixture: parsed === 10 (got ${result.parsed})`);
  check(result.excluded === 3, `kbiz fixture: excluded === 3 — Beginning Balance + 2 EDC lumps (got ${result.excluded})`);
  check(result.rows.length === 7, `kbiz fixture: rows.length === 7 (got ${result.rows.length})`);

  const inRows = result.rows.filter((r) => r.direction === 'in');
  const outRows = result.rows.filter((r) => r.direction === 'out');
  check(inRows.length === 5, `kbiz fixture: 5 "in" rows (got ${inRows.length})`);
  check(outRows.length === 2, `kbiz fixture: 2 "out" rows — Fee + Transfer Withdrawal (got ${outRows.length})`);

  check(!result.rows.some((r) => r.channel === 'EDC/K SHOP/MYQR'), 'kbiz fixture: no EDC/K SHOP/MYQR row in output');
  check(!result.rows.some((r) => r.description === 'Beginning Balance'), 'kbiz fixture: no Beginning Balance row in output');

  // Plain K PLUS/K BIZ row, no bank-code prefix in Details ("From X7375 ...").
  const noBankRow = result.rows.find((r) => r.amount === '1593.00');
  check(!!noBankRow, 'kbiz fixture: no-bank-code deposit row (1593.00) present');
  check(noBankRow?.payerBank === '', `kbiz fixture: no-bank-code row has payerBank === "" (got "${noBankRow?.payerBank}")`);
  check(!!noBankRow?.payerName, 'kbiz fixture: no-bank-code row has a non-empty payerName');

  // "From BBL X0824 ..." — bank code present.
  const bblRow = result.rows.find((r) => r.amount === '2627.00');
  check(bblRow?.payerBank === 'BBL', `kbiz fixture: BBL row payerBank === "BBL" (got "${bblRow?.payerBank}")`);
  check(!!bblRow?.payerName.includes('TESTNAME'), 'kbiz fixture: BBL row payerName captured');

  // Automatic Deposit ("From SMART SCB X9447 ...") — SMART marker must not leak into payerBank.
  const smartRow = result.rows.find((r) => r.amount === '16404.24');
  check(!!smartRow, 'kbiz fixture: Automatic SMART deposit row present');
  check(smartRow?.payerBank === 'SCB', `kbiz fixture: SMART row payerBank === "SCB", not "SMART" (got "${smartRow?.payerBank}")`);
  check(!!smartRow?.payerName && !smartRow.payerName.includes('SMART'), 'kbiz fixture: SMART row payerName excludes the SMART marker');

  // Cheque Deposit ("KBANK 0721 Cheque No. 26488913") — no "From", details preserved verbatim.
  const chequeRow = result.rows.find((r) => r.amount === '1165.00');
  check(!!chequeRow, 'kbiz fixture: Cheque Deposit row present');
  check(!!chequeRow?.details.includes('26488913'), 'kbiz fixture: Cheque Deposit row details retains the cheque number');

  // Fee row — a withdrawal-side row, amount comes from the Withdrawal column.
  const feeRow = result.rows.find((r) => r.description === 'Fee');
  check(!!feeRow, 'kbiz fixture: Fee row present');
  check(feeRow?.direction === 'out', 'kbiz fixture: Fee row direction === out');
  check(feeRow?.amount === '16.83', `kbiz fixture: Fee row amount === "16.83" (got ${feeRow?.amount})`);

  // Amounts with thousands commas parsed correctly (no stray comma/garbage in the numeric string).
  check(result.rows.every((r) => /^\d+\.\d{2}$/.test(r.amount)), 'kbiz fixture: every amount is a clean "N.NN" string (commas stripped)');
}

// ── Fixture: KBIZ, Excel-mangled ────────────────────────────────────────────
// Same rows as kbiz.sample.csv, but as if the file had been opened + re-saved in Excel:
// dates reformatted to the machine locale with leading zeros stripped ("01-07-26" ->
// "1/7/2026"), times with a stripped leading zero on the hour ("02:24" -> "2:24"), and the
// long reference code turned into scientific notation ("26070308150301530998" ->
// "2.60703E+19", untouched by the parser either way since that column isn't read). Must
// parse to the SAME transaction count and SAME first-row txnAt as the pristine fixture —
// this is the whole point of the hardening.
{
  const pristineBuf = readFileSync(new URL('kbiz.sample.csv', FIXTURES_DIR));
  const pristine = parseKbiz(pristineBuf);

  const buf = readFileSync(new URL('kbiz.excel.sample.csv', FIXTURES_DIR));
  const result = parseKbiz(buf);

  check(result.source === 'kbiz', 'kbiz excel-mangled fixture: source === kbiz');
  check(result.parsed === pristine.parsed, `kbiz excel-mangled fixture: parsed === pristine.parsed (${pristine.parsed}) (got ${result.parsed})`);
  check(result.excluded === pristine.excluded, `kbiz excel-mangled fixture: excluded === pristine.excluded (${pristine.excluded}) (got ${result.excluded})`);
  check(result.rows.length === pristine.rows.length, `kbiz excel-mangled fixture: rows.length === pristine.rows.length (${pristine.rows.length}) (got ${result.rows.length})`);
  check(result.rows.length === 7, `kbiz excel-mangled fixture: rows.length === 7 (got ${result.rows.length})`);

  // Same first-row txnAt as the pristine fixture (01-07-26 02:24 == 1/7/2026 2:24).
  check(
    result.rows[0]?.txnAt.getTime() === pristine.rows[0]?.txnAt.getTime(),
    `kbiz excel-mangled fixture: first-row txnAt matches pristine fixture (pristine=${pristine.rows[0]?.txnAt.toISOString()}, got=${result.rows[0]?.txnAt.toISOString()})`,
  );
  check(
    result.rows[0]?.txnAt.toISOString() === new Date('2026-07-01T02:24:00+07:00').toISOString(),
    `kbiz excel-mangled fixture: first-row txnAt === 2026-07-01T02:24 +07:00 (got ${result.rows[0]?.txnAt.toISOString()})`,
  );

  // Single-digit hour with no leading zero (Automatic Deposit row "3:07", was "03:07").
  const smartRow = result.rows.find((r) => r.amount === '16404.24');
  check(
    smartRow?.txnAt.toISOString() === new Date('2026-07-02T03:07:00+07:00').toISOString(),
    `kbiz excel-mangled fixture: single-digit-hour "3:07" parses to 03:07 (got ${smartRow?.txnAt.toISOString()})`,
  );

  // Every row's txnAt lines up 1:1 with the pristine fixture's (same order, same rows).
  check(
    result.rows.every((r, i) => r.txnAt.getTime() === pristine.rows[i]?.txnAt.getTime()),
    'kbiz excel-mangled fixture: every row txnAt matches the pristine fixture row-for-row',
  );
  check(
    result.rows.every((r, i) => r.amount === pristine.rows[i]?.amount && r.direction === pristine.rows[i]?.direction),
    'kbiz excel-mangled fixture: every row amount + direction matches the pristine fixture row-for-row',
  );
}

// ── parseKshopDateTime tolerance (Excel-mangled datetime) ───────────────────
// K SHOP applies the same day-first tolerance as KBIZ. Exercised directly against a
// synthetic K SHOP buffer (rather than a checked-in fixture file) since the shape of the
// change is identical to KBIZ's and is already covered end-to-end there.
{
  const pristineText = readFileSync(new URL('kshop.sample.csv', FIXTURES_DIR), 'utf8');
  const mangledText = pristineText
    .replace(/(\d{2})-(\d{2})-(\d{4}) 09:21:29/, '1/7/2026 9:21:29') // strip leading zeros, "-" -> "/"
    .replace(/(\d{2})-(\d{2})-(\d{4}) 09:32:15/, '1/7/2026 9:32') // also drop seconds (short datetime format)
    .replace(/(\d{2})-(\d{2})-(\d{4}) 10:10:44/, '1/7/2026 10:10:44'); // double-digit hour unaffected

  const pristine = parseKshop(pristineText);
  const result = parseKshop(mangledText);

  check(result.rows.length === pristine.rows.length, `kshop excel-mangled: rows.length === pristine.rows.length (${pristine.rows.length}) (got ${result.rows.length})`);
  check(result.parsed === pristine.parsed, `kshop excel-mangled: parsed === pristine.parsed (${pristine.parsed}) (got ${result.parsed})`);

  const row1 = result.rows.find((r) => r.amount === '8820.00');
  check(
    row1?.txnAt.toISOString() === new Date('2026-07-01T09:21:29+07:00').toISOString(),
    `kshop excel-mangled: "1/7/2026 9:21:29" parses to 2026-07-01T09:21:29 +07:00 (got ${row1?.txnAt.toISOString()})`,
  );
  const row2 = result.rows.find((r) => r.amount === '720.00');
  check(
    row2?.txnAt.toISOString() === new Date('2026-07-01T09:32:00+07:00').toISOString(),
    `kshop excel-mangled: "1/7/2026 9:32" (no seconds) parses to 2026-07-01T09:32:00 +07:00 (got ${row2?.txnAt.toISOString()})`,
  );
}

// ── dedupeKey behavior ───────────────────────────────────────────────────────
{
  const a = computeDedupeKey('kshop', new Date('2026-07-02T17:08:29+07:00'), '6072.00', 'x');
  const b = computeDedupeKey('kshop', new Date('2026-07-02T17:08:29+07:00'), '6072.00', 'x');
  const c = computeDedupeKey('kshop', new Date('2026-07-02T17:08:29+07:00'), '6072.01', 'x');
  check(a === b, 'dedupeKey: identical inputs hash identically (re-import of an overlapping export is a no-op)');
  check(a !== c, 'dedupeKey: a 1-satang amount difference changes the hash');

  const rows = [
    { source: 'kshop' as const, txnAt: new Date('2026-07-02T17:08:29+07:00'), amount: '6072.00', details: 'dup' },
    { source: 'kshop' as const, txnAt: new Date('2026-07-02T17:08:29+07:00'), amount: '6072.00', details: 'dup' },
    { source: 'kshop' as const, txnAt: new Date('2026-07-01T09:00:00+07:00'), amount: '100.00', details: 'unique' },
  ];
  const keys = makeUniqueDedupeKeys(rows);
  check(new Set(keys).size === 3, `dedupeKey: makeUniqueDedupeKeys disambiguates a within-file collision (got ${new Set(keys).size} distinct of 3)`);
  check(keys[1].endsWith('|2'), `dedupeKey: second colliding row gets a "|2" suffix (got "${keys[1]}")`);
  check(!keys[0].includes('|'), 'dedupeKey: first occurrence of a collision keeps the bare hash');
}

// ── Auto-detect + reject-unknown ─────────────────────────────────────────────
{
  try {
    parseKshop('not a bank file at all');
    check(false, 'auto-detect: unknown text thrown for kshop parser');
  } catch {
    check(true, 'auto-detect: parseKshop rejects non-kshop content');
  }
  try {
    parseKbiz(Buffer.from('not a bank file at all', 'utf8'));
    check(false, 'auto-detect: unknown text thrown for kbiz parser');
  } catch {
    check(true, 'auto-detect: parseKbiz rejects non-kbiz content');
  }
}

// ── Real files (build machine only — never committed, silently skipped elsewhere) ──
const REAL_KSHOP = 'C:\\Users\\khunn\\Downloads\\Bank\\KShop.csv';
const REAL_KBIZ = 'C:\\Users\\khunn\\Downloads\\Bank\\KBiz.csv';

if (existsSync(REAL_KSHOP)) {
  const text = readFileSync(REAL_KSHOP, 'utf8');
  const result = parseKshop(text);
  check(result.rows.length === 23, `REAL KShop.csv: 23 payment rows (got ${result.rows.length})`);
  check(result.excluded === 0, `REAL KShop.csv: 0 void rows excluded (got ${result.excluded})`);
  check(result.parsed === 23, `REAL KShop.csv: 23 total data rows parsed (got ${result.parsed})`);
} else {
  console.log('SKIP: real KShop.csv not found on this machine — fixture checks only');
}

if (existsSync(REAL_KBIZ)) {
  const buf = readFileSync(REAL_KBIZ);
  const result = parseKbiz(buf);
  const inRows = result.rows.filter((r) => r.direction === 'in');
  const outRows = result.rows.filter((r) => r.direction === 'out');
  // The file's own header declares TOTAL DEPOSIT 59 ITEMS (incl. the 2 EDC/K SHOP/MYQR
  // lumps we exclude) and TOTAL WITHDRAWAL 6 ITEMS. parsed - excluded(BeginningBalance=1)
  // must equal 59(deposits)+6(withdrawals) = 65, i.e. parsed === 66 (+1 for Beginning Balance).
  check(result.parsed === 66, `REAL KBiz.csv: parsed === 66 — 59 deposit rows + 6 withdrawal rows + 1 Beginning Balance (got ${result.parsed})`);
  check(result.excluded === 3, `REAL KBiz.csv: excluded === 3 — Beginning Balance + 2 EDC/K SHOP/MYQR lumps (got ${result.excluded})`);
  check(inRows.length === 57, `REAL KBiz.csv: 57 "in" rows — the 59 declared deposits minus the 2 excluded EDC lumps (got ${inRows.length})`);
  check(outRows.length === 6, `REAL KBiz.csv: 6 "out" rows, matching the file's own TOTAL WITHDRAWAL 6 ITEMS (got ${outRows.length})`);
  check(
    result.rows.length === inRows.length + outRows.length,
    'REAL KBiz.csv: rows.length === in + out',
  );
} else {
  console.log('SKIP: real KBiz.csv not found on this machine — fixture checks only');
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
}
