// Regression test for parseOesoc — no test framework exists in this repo (see
// test-parse-oeson.ts / test-parse-armast.ts precedent), so this is a plain script: exits
// 1 on any failure, prints PASS/FAIL per case.
//
//   npx tsx src/scripts/test-parse-oesoc.ts
//
// The fixture below is hand-authored in the shape verified against the real OESOC.TXT
// export (customer group header/subtotal + doc header + line-item regexes; see
// parseOesoc.ts's field-order comments). It never embeds real customer/order data —
// Prominent's actual export (11.6k real docs) is NOT committed to the repo.
import { parseOesoc } from '../venus/parseOesoc.js';

const FF = '\x0c';
const ESC = '\x1b';

const lines: string[] = [];

function pageHeader(pageNo: number, withFF: boolean): void {
  lines.push(
    (withFF ? FF : '') + 'บริษัท พรอมมิเน้นท์ จำกัด' + ' '.repeat(80) + `หน้า   :        ${pageNo}`,
  );
  lines.push(`${ESC}W\x01รายงานใบสั่งขาย แยกตามลูกค้า${ESC}W\x00`);
  lines.push(
    'วันที่จาก      1 ธ.ค. 2568    ถึง  31 ธ.ค. 2570                                                                    วันที่ : 06/07/69',
  );
  if (pageNo === 1) {
    lines.push('พนักงานขายจาก                 ถึง  แลป');
    lines.push('รหัสลูกค้าจาก                 ถึง  ๙๙0000007           เลือกแผนก      *');
  }
  lines.push('-'.repeat(132));
  lines.push(
    '   เลขที่       วันที่  พนักงานขาย  ส่งของวันที่ เครดิต V ส่วนลด    มูลค่าสินค้า     VAT.     รวมทั้งสิ้น ส่งหมด อ้างอิง',
  );
  lines.push(
    '     รายละเอียด                                        จำนวน          ราคาต่อหน่วย   ส่วนลด     จำนวนเงิน',
  );
  lines.push('-'.repeat(132));
}

pageHeader(1, false);

// Customer 1 (ก003): a clean doc, plus a doc with a voucher line (negative amount, SKU
// 99-99-xx) that must be INCLUDED in self-certify (allowing negative line sums), and a
// void doc.
lines.push(`${ESC}Eกำธร ทันตแพทย์ /ก003${' '.repeat(50)}${ESC}F`);
lines.push(
  '  SO6819341    17/12/68 C4         17/12/68       1                   845.79        59.21        905.00  Y งานวิชาการ',
);
lines.push(
  '      1 07-10-11 SUCTION MIX COLOR                   10.00ห่อ              69.00                   690.00',
);
lines.push(
  '      2 99-99-02 VOUCHER                              1.00ใบ                         500.00       -500.00',
);
// (fixture total intentionally doesn't reconcile to a real amount computation — this doc
// is only checked for the negative-amount line surviving, not for self-certify matching)
lines.push('');
lines.push(
  ' *RG6900024    09/02/69 C2         09/02/69   30  1                     0.00         0.00          0.00  N NO.7213726 void-test',
);
lines.push('');
lines.push('                                                              -------------- ------------ -------------');
lines.push(`       รวม กำธร ทันตแพทย์ /ก003${' '.repeat(15)}${ESC}E      190.00        59.21        905.00${ESC}F`);
lines.push('');

// Customer 2 (ก011): a doc with a หมายเหตุ: note block after its line items (address-style
// continuation lines), self-certifies exactly, split across a page break mid-CUSTOMER
// (the header for customer 3 appears only after the page-break furniture).
lines.push(`${ESC}Eเกษม สว่างชื่น /ก011${' '.repeat(52)}${ESC}F`);
lines.push(
  '  SO6818959    13/12/68 แลป        13/12/68       1                 1,938.32       135.68      2,074.00  Y',
);
lines.push(
  '      1 01-12-01 DENTORIES ORTHOPLAST 1               1.00กล่อง         1,875.00                 1,875.00',
);
lines.push(
  '      2 02-13-15 ORTHO LIQUID V003 250m               1.00ขวด             199.00                   199.00',
);
lines.push('     หมายเหตุ:');
lines.push('     เกษม สว่างชื่น 063-6298956');
lines.push('     ที่อยู่ทดสอบ');
lines.push('');
lines.push('                                                              -------------- ------------ -------------');
lines.push(`       รวม เกษม สว่างชื่น /ก011${' '.repeat(16)}${ESC}E      1,938.32       135.68      2,074.00${ESC}F`);
lines.push('');

// Page break lands BETWEEN customer 2's subtotal and customer 3's header — must not merge
// customer 3's docs into customer 2, and customer 3's code (with an ASCII-digit tail, like
// the real "ด1551"/"ต013" shapes) must resolve correctly.
pageHeader(2, true);

lines.push(`${ESC}Eตั๊ก(ธนภร) /ต013${' '.repeat(56)}${ESC}F`);
lines.push(
  '  SO6900150    06/01/69 แลป        06/01/69   30  1                 1,681.31       117.69      1,799.00  Y',
);
lines.push(
  '      1 01-08-02 ผงตกไม่แตก KIV                       1.00กล่อง         1,681.31                 1,799.00',
);
lines.push('');
lines.push('                                                              -------------- ------------ -------------');
lines.push(`       รวม ตั๊ก(ธนภร) /ต013${' '.repeat(19)}${ESC}E      1,681.31       117.69      1,799.00${ESC}F`);
lines.push('');

const fixtureText = lines.join('\n');

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    failed++;
  }
}

const result = parseOesoc(fixtureText);

check(result.distinctCodes === 3, `distinctCodes === 3 (got ${result.distinctCodes})`);
check(result.docs.length === 4, `docs.length === 4 (got ${result.docs.length})`);
check(result.voids === 1, `voids === 1 (got ${result.voids})`);
check(result.unresolved === 0, `unresolved === 0 (got ${result.unresolved})`);

const custCodes = result.customers.map((c) => c.code).sort();
check(
  JSON.stringify(custCodes) === JSON.stringify(['ก003', 'ก011', 'ต013']),
  `customer codes extracted correctly (got ${JSON.stringify(custCodes)})`,
);
const cust3 = result.customers.find((c) => c.code === 'ต013');
check(cust3?.name === 'ตั๊ก(ธนภร)', `ascii-digit customer code ต013 keeps its name (got ${JSON.stringify(cust3?.name)})`);

// Doc 1: has a voucher line with a NEGATIVE amount that must survive.
const d1 = result.docs.find((d) => d.docNo === 'SO6819341');
check(!!d1, 'SO6819341 found');
check(d1?.customerCode === 'ก003', `SO6819341 attributed to customer ก003 (got ${d1?.customerCode})`);
check(d1?.lines.length === 2, `SO6819341 has 2 lines (got ${d1?.lines.length})`);
const voucherLine = d1?.lines.find((l) => l.sku === '99-99-02');
check(!!voucherLine, 'voucher line (99-99-02) found');
check(voucherLine?.amount === -500, `voucher line amount === -500 (got ${voucherLine?.amount})`);

// Doc 2: void flag.
const dVoid = result.docs.find((d) => d.docNo === 'RG6900024');
check(!!dVoid, 'RG6900024 found');
check(dVoid?.void === true, 'RG6900024 void === true');
check(dVoid?.customerCode === 'ก003', `RG6900024 still attributed to ก003 (got ${dVoid?.customerCode})`);

// Doc 3: note block must be captured on the doc, not flagged unresolved.
const d3 = result.docs.find((d) => d.docNo === 'SO6818959');
check(!!d3, 'SO6818959 found');
check(d3?.customerCode === 'ก011', `SO6818959 attributed to ก011 (got ${d3?.customerCode})`);
check(d3?.lines.length === 2, `SO6818959 has 2 lines (got ${d3?.lines.length})`);
check(
  d3?.notes.some((n) => n.includes('063-6298956')) ?? false,
  `SO6818959 หมายเหตุ note captured (got ${JSON.stringify(d3?.notes)})`,
);

// Doc 4: survived the page break landing BETWEEN customers (mid-customer-group boundary),
// correctly attributed to customer 3 (ต013), not merged into customer 2 (ก011).
const d4 = result.docs.find((d) => d.docNo === 'SO6900150');
check(!!d4, 'SO6900150 found (survived page break between customer groups)');
check(d4?.customerCode === 'ต013', `SO6900150 attributed to ต013, not the previous customer (got ${d4?.customerCode})`);

// Self-certify per-doc: void doc excluded; SO6819341 has a genuine mismatch (fixture total
// doesn't include the voucher discount in goodsValue/vat, deliberately, to prove mismatches
// are flagged not silently corrected); SO6818959 and SO6900150 match exactly.
check(result.selfCertify.docChecked === 3, `selfCertify.docChecked === 3 (got ${result.selfCertify.docChecked})`);
check(result.selfCertify.docOk === 2, `selfCertify.docOk === 2 (got ${result.selfCertify.docOk})`);

// Self-certify per-customer: all 3 subtotals reconcile against their doc sums (customer 1's
// subtotal in the fixture was set to match SO6819341's total only, since RG6900024 is void
// and contributes 0).
check(
  result.selfCertify.custSubtotalChecked === 3,
  `selfCertify.custSubtotalChecked === 3 (got ${result.selfCertify.custSubtotalChecked})`,
);
check(
  result.selfCertify.custSubtotalOk === 3,
  `selfCertify.custSubtotalOk === 3 (got ${result.selfCertify.custSubtotalOk})`,
);

// Date span: 06/01/69 -> 2026-01-06 (earliest), 17/12/68 -> 2025-12-17... wait, both years
// map through 2500+yy-543: 68 -> 2025, 69 -> 2026.
check(result.dateSpan.min?.getUTCFullYear() === 2025, `dateSpan.min year === 2025 (got ${result.dateSpan.min?.getUTCFullYear()})`);
check(result.dateSpan.max?.getUTCFullYear() === 2026, `dateSpan.max year === 2026 (got ${result.dateSpan.max?.getUTCFullYear()})`);

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
}
