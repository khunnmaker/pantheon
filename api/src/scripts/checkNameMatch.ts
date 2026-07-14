// Pure-logic verification for Juno's name-gated bank auto-matcher.
// Run with: npx tsx src/scripts/checkNameMatch.ts
import { nameAgreement, narrowByAgreement, normalizeNameCore } from '../bank/match.js';

let failed = 0;
let passed = 0;
function check(condition: boolean, label: string): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (condition) passed++;
  else failed++;
}

const verdict = (
  expected: ReturnType<typeof nameAgreement>,
  bankName: string,
  paymentNames: string[],
  label: string,
) => check(nameAgreement(bankName, paymentNames) === expected, label);

check(
  JSON.stringify(normalizeNameCore(' MS. Sample Payer (legacy)++ ')) ===
    JSON.stringify({ core: 'samplepayer', script: 'latin' }),
  'normalization strips parenthetical, defensive ++, punctuation, whitespace, and title',
);
check(normalizeNameCore('Coco').core === 'coco', 'normalization guard preserves short real name Coco');
check(
  normalizeNameCore('บริษัท Sample Co.,Ltd.').core === 'sample',
  'normalization strips mixed-script company affixes on both sides',
);

verdict('agree', 'MS. SAMPLE PAYER', ['Sample Payer'], 'Latin prefix title');
verdict('agree', 'SOMSAK TESTNAME MR', ['Somsak Testname'], 'Latin suffix title');
verdict('agree', 'SAMPLE SUSTAINABLE C', ['Sample Sustainable Co.,Ltd.'], 'truncated bank prefix');
verdict('agree', 'MISSSampleFive', ['sample five'], 'glued Latin title');
verdict('agree', 'นาง ตัวอย่างสี่', ['ตัวอย่างสี่ มีสุข'], 'Thai title and bank prefix');
verdict('agree', 'บจก. ตัวอย่างหนึ่ง', ['บริษัท ตัวอย่างหนึ่ง จำกัด'], 'Thai company affixes');
verdict('agree', 'SOMCHAI JAIDEE', ['SOMCHAI J****'], 'masked Latin payment prefix');
verdict('agree', 'สมชาย ใจดี', ['สมชายใ***'], 'masked Thai payment prefix');

verdict('conflict', 'SOMCHAI JAIDEE', ['SUDA MEEBOON'], 'different Latin names conflict');
verdict('conflict', 'นางสาว สมหญิง รักดี', ['สมชาย ใจดี'], 'different Thai names conflict');
verdict('conflict', 'SUDA MEEBOON', ['SOMCHAI J***'], 'masked mismatch conflicts');

verdict('unknown', 'SOMSAK TESTNAME', ['สมศักดิ์ ทดสอบ'], 'cross-script names are incomparable');
verdict('unknown', '', ['ใคร'], 'empty bank name');
verdict('unknown', 'SOMCHAI', [''], 'empty payment name');
verdict('unknown', 'AB', ['AB'], 'too-short names');

verdict('agree', 'SOMCHAI JAIDEE', ['SUDA MEEBOON', 'Somchai Jaidee'], 'agreement outranks another payment-side conflict');
verdict('conflict', 'SOMCHAI JAIDEE', ['SUDA MEEBOON', ''], 'conflict survives an empty alternate name');
verdict('unknown', 'SOMCHAI JAIDEE', ['', ''], 'all payment-side names empty');

check(
  JSON.stringify(narrowByAgreement([{ id: 'a', agree: false }, { id: 'b', agree: true }])) === JSON.stringify(['b']),
  'narrowByAgreement keeps only agree subset',
);
check(
  JSON.stringify(narrowByAgreement([{ id: 'a', agree: false }, { id: 'b', agree: false }])) === JSON.stringify(['a', 'b']),
  'narrowByAgreement passes through when none agree',
);
check(
  JSON.stringify(narrowByAgreement([{ id: 'a', agree: true }, { id: 'b', agree: true }])) === JSON.stringify(['a', 'b']),
  'narrowByAgreement leaves two agrees ambiguous',
);
check(narrowByAgreement([]).length === 0, 'narrowByAgreement handles empty input');

type Pair = { txnId: string; paymentId: string; agreement: 'agree' | 'conflict' | 'unknown' };
function simulatedLink(txnId: string, pairs: Pair[]): string | null {
  // Mirror Pass 2: conflicts never enter either map; agreement narrows each side symmetrically.
  const eligible = pairs.filter((pair) => pair.agreement !== 'conflict');
  const txnSide = eligible
    .filter((pair) => pair.txnId === txnId)
    .map((pair) => ({ id: pair.paymentId, agree: pair.agreement === 'agree' }));
  const effTxn = narrowByAgreement(txnSide);
  if (effTxn.length !== 1) return null;
  const paymentId = effTxn[0];
  const paymentSide = eligible
    .filter((pair) => pair.paymentId === paymentId)
    .map((pair) => ({ id: pair.txnId, agree: pair.agreement === 'agree' }));
  const effPay = narrowByAgreement(paymentSide);
  return effPay.length === 1 && effPay[0] === txnId ? paymentId : null;
}

check(
  simulatedLink('t1', [{ txnId: 't1', paymentId: 'p1', agreement: 'conflict' }]) === null,
  'pairing: sole amount+day candidate with name conflict does not link',
);
check(
  simulatedLink('t1', [
    { txnId: 't1', paymentId: 'p1', agreement: 'unknown' },
    { txnId: 't1', paymentId: 'p2', agreement: 'agree' },
  ]) === 'p2',
  'pairing: one agreement resolves an amount+day ambiguity',
);
check(
  simulatedLink('t1', [
    { txnId: 't1', paymentId: 'p1', agreement: 'unknown' },
    { txnId: 't1', paymentId: 'p2', agreement: 'unknown' },
  ]) === null,
  'pairing: two unknown candidates retain legacy ambiguity',
);
check(
  simulatedLink('t1', [
    { txnId: 't1', paymentId: 'p1', agreement: 'agree' },
    { txnId: 't2', paymentId: 'p1', agreement: 'agree' },
  ]) === null,
  'pairing: payment-side agreement ambiguity blocks the link symmetrically',
);

if (failed) {
  console.error(`\n${failed} check(s) FAILED; ${passed} passed`);
  process.exit(1);
}
console.log(`\nAll ${passed} Juno name-match checks PASSED`);
