// Pure-logic verification for Juno's payment discrepancy ledger.
// Run with: npx tsx src/scripts/checkJunoDiscrepancy.ts
import {
  buildDiscrepancyComponents,
  expectedForPayment,
  effectivePaidSatang,
  grossSatang,
  mismatchedMultiPaymentComponentCount,
  normalizeReCore,
} from '../finance/discrepancy.js';
import { computeReRow } from '../finance/reRecon.js';
import { displayReceiptReference, normalizeReceiptReference } from '../finance/receiptReferences.js';

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
  creditUsed = '',
) => ({ id, amount, reNumbers, whtAmount, creditUsed, discExpected, status: 'verified' });

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
  const p = payment('credit-shortfall', '2000.00', ['6900010'], '', '', '3000.00');
  const [component] = buildDiscrepancyComponents([p], [receipt('6900010', '5000.00')]);
  check(component.diffSatang === 0, '2,000 cash + 3,000 credit settles a 5,000 RE');
  check(grossSatang(p) === 200_000 && effectivePaidSatang(p) === 500_000, 'credit changes effective paid but preserves raw gross');
  check(computeReRow('5000.00', [p], new Map([['6900010', '5000.00']])).status === 'matched', 'GET /re helper matches cash plus credit');
}

{
  const p = payment('wht-credit', '1900.00', ['6900011'], '100.00', '', '3000.00');
  const [component] = buildDiscrepancyComponents([p], [receipt('6900011', '5000.00')]);
  check(component.diffSatang === 0 && grossSatang(p) === 200_000, 'cash + WHT + credit settles exactly while raw gross excludes credit');
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

{
  const compact = normalizeReceiptReference('0');
  const long = normalizeReceiptReference('0000000');
  check(JSON.stringify(compact) === JSON.stringify(long), '0 and 0000000 are equivalent wrong-transfer sentinels');
  check(compact?.kind === 'wrong_transfer' && displayReceiptReference(compact) === 'โอนเงินผิด 0000000', 'compact sentinel displays with the canonical 0000000 label');
  check(normalizeReCore('0') === null && normalizeReCore('0000000') === null, 'both wrong-transfer sentinels are rejected as RE cores');
}

{
  const p = payment('credit-only', '0', ['6900012'], '', '', '5000.00');
  const [component] = buildDiscrepancyComponents([p], [receipt('6900012', '5000.00')]);
  check(component.diffSatang === 0, 'credit-only payment settles its RE with no new money');
  check(grossSatang(p) === 0 && effectivePaidSatang(p) === 500_000, 'credit-only spend stays out of income/WHT totals while covering the sale');
}

{
  const wrong = { ...payment('wrong-transfer', '725.50', [], '', '0', '900.00'), wrongTransferAt: new Date() };
  const expected = expectedForPayment(wrong);
  check(expected?.expectedSatang === 0, 'wrong transfer uses typed expected zero without an RE');
  check(grossSatang(wrong) - (expected?.expectedSatang ?? 0) === 72_550, 'wrong-transfer refund equals the whole incoming gross');
  check(effectivePaidSatang(wrong) === 72_550, 'wrong transfer always ignores customer credit');
  check(normalizeReCore('0000000') === null, 'wrong-transfer sentinel is excluded from RE components');
  check(buildDiscrepancyComponents([payment('legacy', '10', ['0000000'])], []).length === 0, 'legacy sentinel cannot enter RE reconciliation');
  check(buildDiscrepancyComponents([{ ...payment('void', '10', ['6900099']), status: 'void' }], [receipt('6900099', '10')]).length === 0, 'void payments stay outside active discrepancy components');
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
