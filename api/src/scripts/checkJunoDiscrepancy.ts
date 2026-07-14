// Pure-logic verification for Juno's payment discrepancy ledger.
// Run with: npx tsx src/scripts/checkJunoDiscrepancy.ts
import {
  buildDiscrepancyComponents,
  expectedForPayment,
  grossSatang,
  mismatchedMultiPaymentComponentCount,
} from '../finance/discrepancy.js';
import { computeReRow } from '../finance/reRecon.js';

let failed = 0;
function check(condition: boolean, label: string): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failed++;
}

const receipt = (reNumber: string, amount: string) => ({ reNumber, amount });
const payment = (
  id: string,
  amount: string,
  reNumbers: string[],
  whtAmount = '',
  discExpected = '',
) => ({ id, amount, reNumbers, whtAmount, discExpected, status: 'verified' });

for (const [label, amount, expectedDiff] of [
  ['over', '120.00', 2_000],
  ['under', '80.00', -2_000],
  ['equal', '100.00', 0],
] as const) {
  const components = buildDiscrepancyComponents(
    [payment(`one-${label}`, amount, ['6900001'])],
    [receipt('6900001', '100.00')],
  );
  check(components.length === 1 && components[0].diffSatang === expectedDiff, `1 payment ↔ 1 RE ${label}`);
}

{
  const p = payment('multi-re', '300.00', ['6900001', '6900002']);
  const receipts = [receipt('6900001', '200.00'), receipt('6900002', '100.00')];
  const [component] = buildDiscrepancyComponents([p], receipts);
  check(component.diffSatang === 0, '1 payment ↔ 2 REs balanced is not a ledger discrepancy');

  // GET /re already apportions this case in the current branch; the conditional route change was
  // therefore refuted and left untouched. Guard that observed behavior here.
  const amounts = new Map(receipts.map((row) => [row.reNumber, row.amount]));
  const rePayment = { amount: p.amount, whtAmount: p.whtAmount, reNumbers: p.reNumbers };
  check(
    computeReRow('200.00', [rePayment], amounts).status === 'matched' &&
      computeReRow('100.00', [rePayment], amounts).status === 'matched',
    'GET /re helper marks both members of balanced 1-payment/2-RE coverage matched',
  );
}

for (const [label, secondAmount, expectedHint] of [
  ['balanced', '60.00', 0],
  ['unbalanced', '50.00', 1],
] as const) {
  const components = buildDiscrepancyComponents(
    [payment(`split-a-${label}`, '40.00', ['6900003']), payment(`split-b-${label}`, secondAmount, ['6900003'])],
    [receipt('6900003', '100.00')],
  );
  check(components[0].payments.length === 2, `2 payments ↔ 1 RE ${label} forms one multi-payment component`);
  check(
    expectedForPayment(components[0].payments[0], components[0]) === undefined,
    `2 payments ↔ 1 RE ${label} skips ledger auto-candidates`,
  );
  check(
    mismatchedMultiPaymentComponentCount(components) === expectedHint,
    `2 payments ↔ 1 RE ${label} group hint count is ${expectedHint}`,
  );
}

{
  const p = payment('wht', '97.00', ['6900004'], '3.00');
  const [component] = buildDiscrepancyComponents([p], [receipt('6900004', '100.00')]);
  check(grossSatang(p) === 10_000 && component.diffSatang === 0, 'WHT 97 + 3 versus RE 100 is balanced');
}

{
  const p = payment('typed', '120.00', ['6900005'], '', '110.00');
  const [component] = buildDiscrepancyComponents([p], [receipt('6900005', '100.00')]);
  const expected = expectedForPayment(p, component);
  check(expected?.source === 'typed' && expected.expectedSatang === 11_000, 'typed discExpected overrides RE-derived expected');
  check(grossSatang(p) - (expected?.expectedSatang ?? 0) === 1_000, 'typed override drives the live signed diff');
}

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Juno discrepancy checks PASSED');
