// Regression + real-file check for the KBIZ bank parser (parseKbiz / csv tokenizer).
// K SHOP checks live with Juno Phase B, not here — K SHOP parsing is out of scope for
// this module; api/src/bank/ is structured so a K SHOP parser could slot in later
// alongside parseKbiz.ts, but it is not built here.
//
//   npx tsx src/scripts/checkBankParsers.ts
//
// Runs against the committed sanitized fixture (always), AND against the owner's real
// KBIZ export at C:\Users\khunn\Downloads\Bank\KBiz.csv when present on the build
// machine (never committed — silently skipped if absent, e.g. in CI).
import { readFileSync, existsSync } from 'node:fs';
import { parseKbiz } from '../bank/parseKbiz.js';

let failed = 0;
function check(cond: boolean, label: string, expected?: unknown, actual?: unknown) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    const detail = expected !== undefined || actual !== undefined ? ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})` : '';
    console.log(`FAIL: ${label}${detail}`);
    failed++;
  }
}

// ── Fixture: KBIZ ────────────────────────────────────────────────────────────
{
  const fixturePath = new URL('../bank/fixtures/kbiz.csv', import.meta.url);
  const buf = readFileSync(fixturePath);
  const result = parseKbiz(buf);

  check(result.counts.parsed === 10, 'kbiz fixture: counts.parsed === 10', 10, result.counts.parsed);
  check(result.counts.excluded === 1, 'kbiz fixture: counts.excluded === 1 (the EDC/K SHOP/MYQR lump)', 1, result.counts.excluded);
  check(result.rows.length === 9, 'kbiz fixture: rows.length === 9', 9, result.rows.length);

  const inRows = result.rows.filter((r) => r.direction === 'in');
  const outRows = result.rows.filter((r) => r.direction === 'out');
  check(inRows.length === 7, 'kbiz fixture: 7 "in" rows', 7, inRows.length);
  check(outRows.length === 2, 'kbiz fixture: 2 "out" rows (Transfer Withdrawal + Fee)', 2, outRows.length);

  check(!result.rows.some((r) => r.channel === 'EDC/K SHOP/MYQR'), 'kbiz fixture: no EDC/K SHOP/MYQR row in output');
  check(!result.rows.some((r) => r.description === 'Beginning Balance'), 'kbiz fixture: no Beginning Balance row in output');

  // SCB payer extraction ("From SCB X1234 สมชาย ใจดี++").
  const scbRow = result.rows.find((r) => r.amount === '2425.00');
  check(!!scbRow, 'kbiz fixture: SCB row (2425.00) present');
  check(scbRow?.payerBank === 'SCB', 'kbiz fixture: SCB row payerBank === "SCB"', 'SCB', scbRow?.payerBank);
  check(scbRow?.payerName === 'สมชาย ใจดี', 'kbiz fixture: SCB row payerName === "สมชาย ใจดี"', 'สมชาย ใจดี', scbRow?.payerName);

  // Automatic Deposit "From SMART BBL X5678 โรงพยาบาลทดสอบ++" — SMART marker must not
  // leak into payerBank; the code after SMART (BBL) is the bank.
  const smartRow = result.rows.find((r) => r.amount === '16404.24');
  check(!!smartRow, 'kbiz fixture: Automatic SMART BBL deposit row present');
  check(smartRow?.payerBank === 'BBL', 'kbiz fixture: SMART row payerBank === "BBL"', 'BBL', smartRow?.payerBank);
  check(smartRow?.payerName === 'โรงพยาบาลทดสอบ', 'kbiz fixture: SMART row payerName === "โรงพยาบาลทดสอบ"', 'โรงพยาบาลทดสอบ', smartRow?.payerName);

  // Duplicate pair (2 identical K PLUS 13,380.76 rows) — parser must not dedupe.
  const dupRows = result.rows.filter((r) => r.amount === '13380.76');
  check(dupRows.length === 2, 'kbiz fixture: duplicate pair both parsed (parser does not dedupe)', 2, dupRows.length);
  check(
    dupRows.length === 2 && dupRows[0].txnAt.getTime() === dupRows[1].txnAt.getTime() && dupRows[0].details === dupRows[1].details,
    'kbiz fixture: duplicate pair has identical txnAt + details',
  );

  // Fee row — a withdrawal-side row, amount from the Withdrawal column.
  const feeRow = result.rows.find((r) => r.description === 'Fee');
  check(!!feeRow, 'kbiz fixture: Fee row present');
  check(feeRow?.direction === 'out', 'kbiz fixture: Fee row direction === out');
  check(feeRow?.amount === '16.83', 'kbiz fixture: Fee row amount === "16.83"', '16.83', feeRow?.amount);

  // headerTotals opportunistically parsed from the header/footer summary lines.
  check(result.headerTotals.depositItems === 8, 'kbiz fixture: headerTotals.depositItems === 8', 8, result.headerTotals.depositItems);
  check(result.headerTotals.withdrawalItems === 2, 'kbiz fixture: headerTotals.withdrawalItems === 2', 2, result.headerTotals.withdrawalItems);

  // Cross-check: (in rows + excluded lumps) === headerTotals.depositItems.
  check(
    inRows.length + result.counts.excluded === result.headerTotals.depositItems,
    'kbiz fixture: (in rows + excluded) === headerTotals.depositItems',
    result.headerTotals.depositItems,
    inRows.length + result.counts.excluded,
  );
  check(
    outRows.length === result.headerTotals.withdrawalItems,
    'kbiz fixture: out rows === headerTotals.withdrawalItems',
    result.headerTotals.withdrawalItems,
    outRows.length,
  );

  check(result.periodFrom === '2026-07-01', 'kbiz fixture: periodFrom === "2026-07-01"', '2026-07-01', result.periodFrom);
  check(result.periodTo === '2026-07-02', 'kbiz fixture: periodTo === "2026-07-02"', '2026-07-02', result.periodTo);

  console.log(
    `SUMMARY fixture kbiz.csv: parsed=${result.counts.parsed} excluded=${result.counts.excluded} in=${inRows.length} out=${outRows.length} period=${result.periodFrom}..${result.periodTo} headerTotals=${JSON.stringify(result.headerTotals)}`,
  );
}

// ── Rejects non-KBIZ content ─────────────────────────────────────────────────
{
  try {
    parseKbiz(Buffer.from('not a bank file at all', 'utf8'));
    check(false, 'reject: parseKbiz throws not_kbiz on unrelated text');
  } catch (err) {
    check(err instanceof Error && err.message === 'not_kbiz', 'reject: parseKbiz throws not_kbiz on unrelated text');
  }
  try {
    parseKbiz(Buffer.from('TRANSACTION REPORT - payment,\nfoo,bar\n', 'utf8'));
    check(false, 'reject: parseKbiz throws not_kbiz on a K SHOP file (out of scope here)');
  } catch (err) {
    check(err instanceof Error && err.message === 'not_kbiz', 'reject: parseKbiz throws not_kbiz on a K SHOP file (out of scope here)');
  }
}

// ── Real file (build machine only — never committed, silently skipped elsewhere) ──
const REAL_KBIZ = 'C:\\Users\\khunn\\Downloads\\Bank\\KBiz.csv';

if (existsSync(REAL_KBIZ)) {
  const buf = readFileSync(REAL_KBIZ);
  const result = parseKbiz(buf);
  const inRows = result.rows.filter((r) => r.direction === 'in');
  const outRows = result.rows.filter((r) => r.direction === 'out');

  if (result.headerTotals.depositItems !== null) {
    check(
      inRows.length + result.counts.excluded === result.headerTotals.depositItems,
      'REAL KBiz.csv: (in rows + excluded) === headerTotals.depositItems',
      result.headerTotals.depositItems,
      inRows.length + result.counts.excluded,
    );
  }
  if (result.headerTotals.withdrawalItems !== null) {
    check(
      outRows.length === result.headerTotals.withdrawalItems,
      'REAL KBiz.csv: out rows === headerTotals.withdrawalItems',
      result.headerTotals.withdrawalItems,
      outRows.length,
    );
  }

  console.log(
    `SUMMARY REAL KBiz.csv: parsed=${result.counts.parsed} excluded=${result.counts.excluded} in=${inRows.length} out=${outRows.length} period=${result.periodFrom}..${result.periodTo} headerTotals=${JSON.stringify(result.headerTotals)}`,
  );
} else {
  console.log('SKIP: real KBiz.csv not found on this machine — fixture checks only');
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
  process.exit(0);
}
