// Regression test for parseOeson — no test framework exists in this repo (see
// test-parse-armast.ts precedent), so this is a plain script: exits 1 on any failure,
// prints PASS/FAIL per case.
//
//   npx tsx src/scripts/test-parse-oeson.ts
//
// The fixture below is hand-authored in the shape verified against the real OESON.TXT
// export (doc header + line-item regexes; see parseOeson.ts's field-order comments). It
// never embeds real customer/order data — Prominent's actual export (28.8k real docs) is
// NOT committed to the repo.
import { parseOeson } from '../venus/parseOeson.js';

const FF = '\x0c';

const lines: string[] = [];

// Page 1 furniture: banner, ESC W-bracketed title, filter lines, dashed separators, the
// two column-header rows.
function pageHeader(pageNo: number, withFF: boolean): void {
  lines.push(
    (withFF ? FF : '') + 'บริษัท พรอมมิเน้นท์ จำกัด' + ' '.repeat(80) + `หน้า   :        ${pageNo}`,
  );
  lines.push('\x1bW\x01รายงานใบสั่งขาย เรียงตามเลขที่\x1bW\x00');
  lines.push(
    'วันที่จาก      1 ม.ค. 2568    ถึง  6 ก.ค. 2569                                                                                                วันที่ : 06/07/69',
  );
  if (pageNo === 1) {
    lines.push('เลขที่จาก                     ถึง  ๙๙๙๙๙๙๙๙๙๙๙๙');
    lines.push('รหัสลูกค้าจาก                 ถึง  ๙๙0000007');
    lines.push('พนักงานขายจาก                 ถึง  แลป                 เลือกแผนก      *');
  }
  lines.push('-'.repeat(163));
  lines.push(
    '   เลขที่       วันที่  ลูกค้า                        พนักงานขาย  ส่งของวันที่ เครดิต V ส่วนลด    มูลค่าสินค้า     VAT.     รวมทั้งสิ้น ส่งหมด อ้างอิง',
  );
  lines.push(
    '     รายละเอียด                                        จำนวน          ราคาต่อหน่วย   ส่วนลด     จำนวนเงิน  วันที่ส่งของ',
  );
  lines.push('-'.repeat(163));
}

pageHeader(1, false);

// Doc 1: void (leading "*"), zero totals, reference text contains a literal "*" that must
// NOT be mistaken for the void flag (only the LEADING "*" counts).
lines.push(
  ' *RG6800012    13/01/68 บี อาร์ สไมล์ เดนทัล          C4         13/01/68       1                     0.00         0.00          0.00  N NO.9415650*คืนแล้ว',
);

// Doc 2: clean multi-line order, self-certifies (sum of line amounts == total).
lines.push(
  '  SO6800002    03/01/68 ที. เอส. เอ็ม. เด็นตอลแลป     03         03/01/68       1                   463.55        32.45        496.00  Y',
);
lines.push(
  '      1 08-04-24 BALL BEARING 10-4                    1.00ชิ้น            390.00                   390.00',
);
lines.push(
  '      2 08-29-04 ค่าบริการ                            1.00ครั้ง           106.00                   106.00',
);

// Doc 3: has a "หมายเหตุ:" note block after its line items, plus a blank-price line
// (warranty / in-guarantee — 0 trailing numbers) that must be KEPT, not dropped.
lines.push(
  '  RG6800005    08/01/68 อาร์ดีแอล เดนทัล แลบ จำกัด    แลป        08/01/68   30  1                     0.00         0.00          0.00  Y AA22070447 อยู่ในประกัน',
);
lines.push('      1 08-04-20 BALL BEARING 12-6                    1.00ชิ้น');
lines.push('     หมายเหตุ:');
lines.push('     -ทำความสะอาดค่ะ');
lines.push('');

// Page break splitting doc 4's line items from its header block: page 2 furniture lands
// mid-document (with a leading form-feed), and doc 4's remaining lines resume after it.
lines.push(
  '  SO6800006    03/01/68 อาซีเยาะ สาและ                06         03/01/68       1                11,000.00       770.00     11,770.00  Y',
);
lines.push(
  '      1 09-10-08 2L 8U                               18.00แผง              86.00                 1,548.00',
);
pageHeader(2, true);
lines.push(
  '      2 09-10-19 2L 19U                              18.00แผง              86.00                 1,548.00',
);
// Deliberate self-certify MISMATCH: only 2 of what should be several lines are present in
// this fixture (goodsValue/total imply more items), so sum(lines) != total — this must be
// FLAGGED, not silently dropped or corrected.

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

const result = parseOeson(fixtureText);

check(result.docs.length === 4, `docs.length === 4 (got ${result.docs.length})`);
check(result.voids === 1, `voids === 1 (got ${result.voids})`);
check(result.lineItems === 5, `lineItems === 5 (got ${result.lineItems})`);
check(result.distinctSkus === 5, `distinctSkus === 5 (got ${result.distinctSkus})`);
check(result.unresolved === 0, `unresolved === 0 (got ${result.unresolved})`);

const d1 = result.docs.find((d) => d.docNo === 'RG6800012');
check(!!d1, 'RG6800012 found');
check(d1?.void === true, 'RG6800012 void flag === true (leading "*")');
check(
  d1?.reference === 'NO.9415650*คืนแล้ว',
  `RG6800012 reference keeps its embedded literal "*" (got ${JSON.stringify(d1?.reference)})`,
);
check(d1?.delivered === false, 'RG6800012 delivered === false (N)');
check(d1?.docType === 'RG', `RG6800012 docType === RG (got ${d1?.docType})`);

const d2 = result.docs.find((d) => d.docNo === 'SO6800002');
check(!!d2, 'SO6800002 found');
check(d2?.void === false, 'SO6800002 void === false');
check(d2?.lines.length === 2, `SO6800002 has 2 lines (got ${d2?.lines.length})`);
check(d2?.repCode === '03', `SO6800002 repCode === "03" (got ${JSON.stringify(d2?.repCode)})`);
check(d2?.total === 496, `SO6800002 total === 496 (got ${d2?.total})`);
check(d2?.delivered === true, 'SO6800002 delivered === true (Y)');
const d2l1 = d2?.lines.find((l) => l.lineNo === 1);
check(d2l1?.sku === '08-04-24', `SO6800002 line1 sku extracted (got ${d2l1?.sku})`);
check(d2l1?.qty === 1, `SO6800002 line1 qty === 1 (got ${d2l1?.qty})`);
check(d2l1?.unit === 'ชิ้น', `SO6800002 line1 unit === ชิ้น (got ${d2l1?.unit})`);
check(d2l1?.unitPrice === 390, `SO6800002 line1 unitPrice === 390 (got ${d2l1?.unitPrice})`);
check(d2l1?.amount === 390, `SO6800002 line1 amount === 390 (got ${d2l1?.amount})`);

const d3 = result.docs.find((d) => d.docNo === 'RG6800005');
check(!!d3, 'RG6800005 found');
check(d3?.lines.length === 1, `RG6800005 has 1 line (blank-price line kept, got ${d3?.lines.length})`);
const d3l1 = d3?.lines[0];
check(d3l1?.qty === 1, `RG6800005 blank-price line qty extracted (got ${d3l1?.qty})`);
check(d3l1?.unit === 'ชิ้น', `RG6800005 blank-price line unit extracted (got ${d3l1?.unit})`);
check(d3l1?.unitPrice === null, `RG6800005 blank-price line unitPrice === null (got ${d3l1?.unitPrice})`);
check(d3l1?.amount === null, `RG6800005 blank-price line amount === null (got ${d3l1?.amount})`);
check(
  d3?.notes.some((n) => n.includes('ทำความสะอาดค่ะ')) ?? false,
  `RG6800005 หมายเหตุ note captured (got ${JSON.stringify(d3?.notes)})`,
);

const d4 = result.docs.find((d) => d.docNo === 'SO6800006');
check(!!d4, 'SO6800006 found (survived the mid-doc page break)');
check(
  d4?.lines.length === 2,
  `SO6800006 has both lines from before AND after the page break (got ${d4?.lines.length})`,
);
check(d4?.lines[0]?.sku === '09-10-08', 'SO6800006 line1 (before page break) extracted');
check(d4?.lines[1]?.sku === '09-10-19', 'SO6800006 line2 (after page break) extracted');

// Self-certify: doc 1 (void) excluded from the check; doc 2 matches exactly; doc 3's total
// is 0 with a null-amount line (0 == 0, matches); doc 4 is a deliberate mismatch (fixture
// only carries 2 of the doc's real line items against an 11,770 total).
check(result.selfCertify.checked === 3, `selfCertify.checked === 3 (got ${result.selfCertify.checked})`);
check(result.selfCertify.ok === 2, `selfCertify.ok === 2 (got ${result.selfCertify.ok})`);
check(
  result.selfCertify.mismatches.length === 1,
  `selfCertify has exactly 1 mismatch (got ${result.selfCertify.mismatches.length})`,
);
check(
  result.selfCertify.mismatches[0]?.docNo === 'SO6800006',
  `the flagged mismatch is SO6800006 (got ${result.selfCertify.mismatches[0]?.docNo})`,
);

// Date span sanity: 03/01/68 -> 2025-01-03, 13/01/68 -> 2025-01-13.
check(
  result.dateSpan.min?.getUTCFullYear() === 2025,
  `dateSpan.min year === 2025 (got ${result.dateSpan.min?.getUTCFullYear()})`,
);
check(
  result.dateSpan.max?.getUTCFullYear() === 2025,
  `dateSpan.max year === 2025 (got ${result.dateSpan.max?.getUTCFullYear()})`,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
}
