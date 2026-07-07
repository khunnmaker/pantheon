// Regression tests for the money-lane bank parsers (parseKbiz / parseKshop / dedupe).
// Converted verbatim from src/scripts/checkBankParsers.ts — SAME committed sanitized
// fixtures, SAME assertions. The script's real-file section (checks against the owner's
// private C:\Users\khunn\Downloads\Bank\*.csv exports) is intentionally NOT ported here:
// those files are never committed and their counts drift per statement, so they cannot be
// a deterministic test. The build-machine script still covers them ad hoc.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseKbiz } from '../src/bank/parseKbiz.js';
import { parseKshop } from '../src/bank/parseKshop.js';
import { computeDedupeKey, makeUniqueDedupeKeys } from '../src/bank/dedupe.js';

const FIXTURES_DIR = new URL('../src/bank/fixtures/', import.meta.url);

describe('parseKshop — K SHOP fixture', () => {
  const buf = readFileSync(new URL('kshop.sample.csv', FIXTURES_DIR));
  const text = buf.toString('utf8');
  const result = parseKshop(text);

  it('reports source, parsed, excluded and row counts', () => {
    expect(result.source).toBe('kshop');
    expect(result.parsed).toBe(8);
    expect(result.excluded).toBe(1); // the Void row
    expect(result.rows.length).toBe(7);
  });

  it('every row is an inbound K SHOP payment', () => {
    expect(result.rows.every((r) => r.direction === 'in')).toBe(true);
    expect(result.rows.every((r) => r.channel === 'K SHOP')).toBe(true);
  });

  it('parses payer + bank on the K PLUS row', () => {
    const kplusRow = result.rows.find((r) => r.amount === '3230.00');
    expect(kplusRow).toBeTruthy();
    expect(kplusRow?.payerBank).toBe('K PLUS');
    expect(kplusRow?.payerName.includes('ตัวอย่างสี่')).toBe(true);
  });

  it('lets an identical-duplicate pair through the parser (dedup is import-time)', () => {
    const dupRows = result.rows.filter((r) => r.amount === '6072.00');
    expect(dupRows.length).toBe(2);
    expect(dupRows[0].txnAt.getTime()).toBe(dupRows[1].txnAt.getTime());
    expect(dupRows[0].details).toBe(dupRows[1].details);
  });

  it('excludes the Void row from output', () => {
    expect(result.rows.some((r) => r.details.includes('ยกเลิก'))).toBe(false);
  });
});

describe('parseKbiz — KBIZ fixture', () => {
  const buf = readFileSync(new URL('kbiz.sample.csv', FIXTURES_DIR));
  const result = parseKbiz(buf);

  it('reports source, parsed, excluded and row counts', () => {
    expect(result.source).toBe('kbiz');
    expect(result.parsed).toBe(10);
    expect(result.excluded).toBe(3); // Beginning Balance + 2 EDC lumps
    expect(result.rows.length).toBe(7);
  });

  it('splits in/out rows correctly', () => {
    const inRows = result.rows.filter((r) => r.direction === 'in');
    const outRows = result.rows.filter((r) => r.direction === 'out');
    expect(inRows.length).toBe(5);
    expect(outRows.length).toBe(2); // Fee + Transfer Withdrawal
  });

  it('drops EDC lumps and the Beginning Balance from output', () => {
    expect(result.rows.some((r) => r.channel === 'EDC/K SHOP/MYQR')).toBe(false);
    expect(result.rows.some((r) => r.description === 'Beginning Balance')).toBe(false);
  });

  it('handles a plain deposit row with no bank code in Details', () => {
    const noBankRow = result.rows.find((r) => r.amount === '1593.00');
    expect(noBankRow).toBeTruthy();
    expect(noBankRow?.payerBank).toBe('');
    expect(noBankRow?.payerName).toBeTruthy();
  });

  it('extracts the bank code on a "From BBL X0824 ..." row', () => {
    const bblRow = result.rows.find((r) => r.amount === '2627.00');
    expect(bblRow?.payerBank).toBe('BBL');
    expect(bblRow?.payerName.includes('TESTNAME')).toBe(true);
  });

  it('does not leak the SMART marker into payerBank on an Automatic Deposit', () => {
    const smartRow = result.rows.find((r) => r.amount === '16404.24');
    expect(smartRow).toBeTruthy();
    expect(smartRow?.payerBank).toBe('SCB'); // not "SMART"
    expect(!!smartRow?.payerName && !smartRow.payerName.includes('SMART')).toBe(true);
  });

  it('retains the cheque number verbatim on a Cheque Deposit row', () => {
    const chequeRow = result.rows.find((r) => r.amount === '1165.00');
    expect(chequeRow).toBeTruthy();
    expect(chequeRow?.details.includes('26488913')).toBe(true);
  });

  it('reads a Fee withdrawal amount from the Withdrawal column', () => {
    const feeRow = result.rows.find((r) => r.description === 'Fee');
    expect(feeRow).toBeTruthy();
    expect(feeRow?.direction).toBe('out');
    expect(feeRow?.amount).toBe('16.83');
  });

  it('strips thousands commas so every amount is a clean N.NN string', () => {
    expect(result.rows.every((r) => /^\d+\.\d{2}$/.test(r.amount))).toBe(true);
  });
});

describe('parseKbiz — Excel-mangled fixture matches the pristine one row-for-row', () => {
  const pristine = parseKbiz(readFileSync(new URL('kbiz.sample.csv', FIXTURES_DIR)));
  const result = parseKbiz(readFileSync(new URL('kbiz.excel.sample.csv', FIXTURES_DIR)));

  it('parses to the same source and counts as the pristine fixture', () => {
    expect(result.source).toBe('kbiz');
    expect(result.parsed).toBe(pristine.parsed);
    expect(result.excluded).toBe(pristine.excluded);
    expect(result.rows.length).toBe(pristine.rows.length);
    expect(result.rows.length).toBe(7);
  });

  it('parses the first-row datetime identically (01-07-26 02:24 == 1/7/2026 2:24)', () => {
    expect(result.rows[0]?.txnAt.getTime()).toBe(pristine.rows[0]?.txnAt.getTime());
    expect(result.rows[0]?.txnAt.toISOString()).toBe(
      new Date('2026-07-01T02:24:00+07:00').toISOString(),
    );
  });

  it('parses a single-digit-hour "3:07" as 03:07', () => {
    const smartRow = result.rows.find((r) => r.amount === '16404.24');
    expect(smartRow?.txnAt.toISOString()).toBe(
      new Date('2026-07-02T03:07:00+07:00').toISOString(),
    );
  });

  it('lines every row up 1:1 with the pristine fixture (txnAt + amount + direction)', () => {
    expect(result.rows.every((r, i) => r.txnAt.getTime() === pristine.rows[i]?.txnAt.getTime())).toBe(
      true,
    );
    expect(
      result.rows.every(
        (r, i) => r.amount === pristine.rows[i]?.amount && r.direction === pristine.rows[i]?.direction,
      ),
    ).toBe(true);
  });
});

describe('parseKshop — Excel-mangled datetime tolerance', () => {
  const pristineText = readFileSync(new URL('kshop.sample.csv', FIXTURES_DIR), 'utf8');
  const mangledText = pristineText
    .replace(/(\d{2})-(\d{2})-(\d{4}) 09:21:29/, '1/7/2026 9:21:29') // strip leading zeros, "-" -> "/"
    .replace(/(\d{2})-(\d{2})-(\d{4}) 09:32:15/, '1/7/2026 9:32') // also drop seconds (short datetime format)
    .replace(/(\d{2})-(\d{2})-(\d{4}) 10:10:44/, '1/7/2026 10:10:44'); // double-digit hour unaffected

  const pristine = parseKshop(pristineText);
  const result = parseKshop(mangledText);

  it('parses to the same counts as the pristine fixture', () => {
    expect(result.rows.length).toBe(pristine.rows.length);
    expect(result.parsed).toBe(pristine.parsed);
  });

  it('parses "1/7/2026 9:21:29" to 2026-07-01T09:21:29 +07:00', () => {
    const row1 = result.rows.find((r) => r.amount === '8820.00');
    expect(row1?.txnAt.toISOString()).toBe(new Date('2026-07-01T09:21:29+07:00').toISOString());
  });

  it('parses "1/7/2026 9:32" (no seconds) to 2026-07-01T09:32:00 +07:00', () => {
    const row2 = result.rows.find((r) => r.amount === '720.00');
    expect(row2?.txnAt.toISOString()).toBe(new Date('2026-07-01T09:32:00+07:00').toISOString());
  });
});

describe('dedupeKey behavior', () => {
  it('hashes identical inputs identically and a 1-satang change differently', () => {
    const a = computeDedupeKey('kshop', new Date('2026-07-02T17:08:29+07:00'), '6072.00', 'x');
    const b = computeDedupeKey('kshop', new Date('2026-07-02T17:08:29+07:00'), '6072.00', 'x');
    const c = computeDedupeKey('kshop', new Date('2026-07-02T17:08:29+07:00'), '6072.01', 'x');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('disambiguates a within-file collision with a "|n" suffix', () => {
    const rows = [
      { source: 'kshop' as const, txnAt: new Date('2026-07-02T17:08:29+07:00'), amount: '6072.00', details: 'dup' },
      { source: 'kshop' as const, txnAt: new Date('2026-07-02T17:08:29+07:00'), amount: '6072.00', details: 'dup' },
      { source: 'kshop' as const, txnAt: new Date('2026-07-01T09:00:00+07:00'), amount: '100.00', details: 'unique' },
    ];
    const keys = makeUniqueDedupeKeys(rows);
    expect(new Set(keys).size).toBe(3);
    expect(keys[1].endsWith('|2')).toBe(true);
    expect(keys[0].includes('|')).toBe(false);
  });
});

describe('auto-detect — parsers reject unknown content', () => {
  it('parseKshop throws on non-kshop text', () => {
    expect(() => parseKshop('not a bank file at all')).toThrow();
  });

  it('parseKbiz throws on non-kbiz content', () => {
    expect(() => parseKbiz(Buffer.from('not a bank file at all', 'utf8'))).toThrow();
  });
});
