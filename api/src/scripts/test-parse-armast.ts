// Regression test for parseArmast — no test framework exists in this repo (see
// test-parse-stock.ts precedent), so this is a plain script: exits 1 on any failure,
// prints PASS/FAIL per case.
//
//   npx tsx src/scripts/test-parse-armast.ts
//
// The fixture below is hand-authored in the EXACT column layout verified against the
// real ARMAST.TXT export (header line = 98 chars; see parseArmast.ts's column-boundary
// comment). It never embeds real customer data — Prominent's actual export (10.5k real
// people) is NOT committed to the repo.
import { parseArmast, normalizeCreditTerms } from '../venus/parseArmast.js';

const ESC = '\x1b';
const FF = '\x0c';

function pad(s: string, len: number): string {
  return (s + ' '.repeat(len)).slice(0, len);
}

// Builds one 98-char customer HEADER line matching the real report's fixed columns:
// code (2sp-leading, 2+sp-terminated) + name (to col 76) + repCode[76:88) + zone[88:94)
// + priceType[94:98).
function headerLine(code: string, name: string, repCode: string, zone: string, priceType: string): string {
  let line = '  ' + code;
  line = pad(line, 14);
  line = line + name;
  line = pad(line, 76);
  line = line + pad(repCode, 12) + pad(zone, 6) + pad(priceType, 4);
  return line;
}

const lines: string[] = [];

// Page 1 furniture: banner, ESC W-bracketed title, filter lines, dashed separators, column header.
lines.push('บริษัท พรอมมิเน้นท์ จำกัด' + ' '.repeat(80) + 'หน้า   :        1');
lines.push(`${ESC}W\x01รายละเอียดลูกค้า แยกตามประเภทลูกค้า${ESC}W\x00`);
lines.push('ประเภทลูกค้าจาก                  ถึง  ๙๙                                                                 วันที่ : 01/01/70');
lines.push('ลูกค้าจาก                        ถึง  ๙๙0000007');
lines.push('เขตการขายจาก                     ถึง  78');
lines.push('พนักงานขายจาก                    ถึง  แลป');
lines.push('-'.repeat(122));
lines.push('  รหัส       คำนำหน้า+ชื่อลูกค้า                                            พนักงานขาย  เขต   ประเภทราคา     ส่วนลด');
lines.push('-'.repeat(122));

// ESC E ... ESC F brackets the section header — this is a distinct ESC shape from ESC W.
lines.push(`${ESC}Eประเภท : ลูกค้าประจำ${' '.repeat(40)}${ESC}F`);

// Customer 1: clean record, cash terms.
lines.push(headerLine('T001', 'TEST DENTAL LAB', 'C1', '78', '1'));
lines.push('      ที่อยู่  : 123 ถนนทดสอบ                                        ผู้ติดต่อ : คุณทดสอบ');
lines.push('               : ตำบลทดสอบ อำเภอทดสอบ                                เลขที่บ/ช : 112110          ขนส่งโดย  : 05');
lines.push('               : จังหวัดทดสอบ            10100                       เครดิต    :   0  วัน        วงเงิน    :          0.00');
lines.push('      โทร.     : 02-1234567                                          เงื่อนไข  : เงินสด');

// Customer 2: credit terms + a trailing ragged free-note line.
lines.push(headerLine('T002', 'คลินิกทดสอบสอง', 'C2', '28', '1'));
lines.push('      ที่อยู่  : 456 ถนนสมมติ                                        ผู้ติดต่อ :');
lines.push('               : ตำบลสมมติ                                           เลขที่บ/ช : 112110          ขนส่งโดย  : 02');
lines.push('               :                        10200                       เครดิต    :  30  วัน        วงเงิน    :     50,000.00');
lines.push('      โทร.     : 081-9998888                                         เงื่อนไข  : เครดิต 30 วัน');
lines.push('                     +เพิ่มยอด 0.25% ค่าธรรมเนียม');

// Mid-file page break: a full page-header block (with a leading form-feed) interrupts the
// line stream between customer 2 and customer 3 — this must be stripped, not misread as data.
lines.push(FF + 'บริษัท พรอมมิเน้นท์ จำกัด' + ' '.repeat(80) + 'หน้า   :        2');
lines.push(`${ESC}W\x01รายละเอียดลูกค้า แยกตามประเภทลูกค้า${ESC}W\x00`);
lines.push('ประเภทลูกค้าจาก                  ถึง  ๙๙                                                                 วันที่ : 01/01/70');
lines.push('-'.repeat(122));
lines.push('  รหัส       คำนำหน้า+ชื่อลูกค้า                                            พนักงานขาย  เขต   ประเภทราคา     ส่วนลด');
lines.push('-'.repeat(122));

// Customer 3: prepay terms, blank repCode/zone/shipBy (ragged columns).
lines.push(headerLine('Cก003', 'คลีนิคทดสอบสาม', '', '', '1'));
lines.push('      ที่อยู่  : 789 ถนนตัวอย่าง                                      ผู้ติดต่อ : คุณตัวอย่าง');
lines.push('               : ตำบลตัวอย่าง                                         เลขที่บ/ช : 112110          ขนส่งโดย  :');
lines.push('               :                        10300                       เครดิต    :   0  วัน        วงเงิน    :          1.00');
lines.push('      โทร.     : 02-5556666                                          เงื่อนไข  : โอนเงินก่อนส่ง');

// Customer 4: Thai-numeral-prefixed code (lab entries in the real file use "๙๙NNNNNNN").
lines.push(headerLine('๙๙0000001', 'แลปทดสอบสี่', '', '4', '1'));
lines.push('      ที่อยู่  : 12 ถนนตัวอย่างสี่                                    ผู้ติดต่อ :');
lines.push('               : ตำบลตัวอย่างสี่                                      เลขที่บ/ช :                 ขนส่งโดย  : 03');
lines.push('               :                        10400                       เครดิต    :   0  วัน        วงเงิน    :          1.00');
lines.push('      โทร.     : (038)111-2222                                       เงื่อนไข  :');

// Customer 5: DELIBERATELY MALFORMED — header present, but the addr2/addr3/phone block
// never follows (report cuts straight to the footer). Must be flagged unresolved, not
// silently dropped and not guessed into a partial record.
lines.push(headerLine('BAD01', 'MALFORMED RECORD (missing block)', 'C9', '1', '1'));
lines.push('      ที่อยู่  : some address                                         ผู้ติดต่อ : someone');

lines.push('');
lines.push('>>>> จบรายงาน <<<<');
lines.push(FF);

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

const result = parseArmast(fixtureText);

check(result.parsedCount === 4, `parsedCount === 4 (got ${result.parsedCount})`);
check(result.customers.length === 4, `customers.length === 4 (got ${result.customers.length})`);
check(result.unresolved === 2, `unresolved === 2 (got ${result.unresolved})`); // BAD01 header + its orphan addr1 line
check(result.unresolvedSamples.length === 2, `unresolvedSamples has 2 entries (got ${result.unresolvedSamples.length})`);
check(result.unresolvedSamples.some((s) => s.includes('BAD01')), 'unresolved sample includes the malformed BAD01 header');
check(result.pageCount === 2, `pageCount === 2 (got ${result.pageCount})`);
check(Object.keys(result.typeGroups).length === 1, 'exactly one type group (ลูกค้าประจำ)');
check(result.typeGroups['ลูกค้าประจำ'] === 4, `typeGroups.ลูกค้าประจำ === 4 (got ${result.typeGroups['ลูกค้าประจำ']})`);

const c1 = result.customers.find((c) => c.code === 'T001');
check(!!c1, 'T001 found');
check(c1?.name === 'TEST DENTAL LAB', `T001 name extracted correctly (got ${JSON.stringify(c1?.name)})`);
check(c1?.repCode === 'C1', `T001 repCode === C1 (got ${c1?.repCode})`);
check(c1?.zone === '78', `T001 zone === 78 (got ${c1?.zone})`);
check(c1?.custType === 'ลูกค้าประจำ', `T001 custType extracted from ESC E/F section header (got ${c1?.custType})`);
check(c1?.creditDays === 0, `T001 creditDays === 0 (got ${c1?.creditDays})`);
check(c1?.creditTermsNorm === 'CASH', `T001 creditTermsNorm === CASH (got ${c1?.creditTermsNorm})`);
check(c1?.contact === 'คุณทดสอบ', `T001 contact extracted (got ${JSON.stringify(c1?.contact)})`);
check(c1?.acctNo === '112110', `T001 acctNo extracted (got ${c1?.acctNo})`);
check(c1?.shipBy === '05', `T001 shipBy extracted (got ${c1?.shipBy})`);
check(!!c1?.address?.includes('123 ถนนทดสอบ'), 'T001 address includes addr1');
check(!!c1?.address?.includes('จังหวัดทดสอบ'), 'T001 address includes addr3');

const c2 = result.customers.find((c) => c.code === 'T002');
check(!!c2, 'T002 found');
check(c2?.creditDays === 30, `T002 creditDays === 30 (got ${c2?.creditDays})`);
check(c2?.creditLimit === '50,000.00', `T002 creditLimit === 50,000.00 (got ${c2?.creditLimit})`);
check(c2?.creditTermsNorm === 'CREDIT', `T002 creditTermsNorm === CREDIT (got ${c2?.creditTermsNorm})`);
check(c2?.note === '+เพิ่มยอด 0.25% ค่าธรรมเนียม', `T002 trailing free-note captured (got ${JSON.stringify(c2?.note)})`);
check(c2?.contact === null, 'T002 blank contact -> null (not empty string)');

const c3 = result.customers.find((c) => c.code === 'Cก003');
check(!!c3, 'Cก003 found (survived the mid-file page break)');
check(c3?.repCode === null, 'Cก003 blank repCode -> null');
check(c3?.zone === null, 'Cก003 blank zone -> null');
check(c3?.shipBy === null, 'Cก003 blank shipBy -> null');
check(c3?.creditTermsNorm === 'PREPAY', `Cก003 creditTermsNorm === PREPAY (got ${c3?.creditTermsNorm})`);

const c4 = result.customers.find((c) => c.code === '๙๙0000001');
check(!!c4, 'Thai-numeral code ๙๙0000001 extracted correctly');
check(c4?.acctNo === null, '๙๙0000001 blank acctNo -> null');
check(c4?.creditTerms === null, '๙๙0000001 blank เงื่อนไข -> null creditTerms');
check(c4?.creditTermsNorm === 'OTHER', `๙๙0000001 blank terms + creditDays=0 -> OTHER (got ${c4?.creditTermsNorm})`);

// normalizeCreditTerms unit coverage for the typo/variant buckets seen in the real file.
check(normalizeCreditTerms('เงินสด', 0) === 'CASH', 'normalizeCreditTerms: เงินสด -> CASH');
check(normalizeCreditTerms('โอนเงินก่อนส่งของ', 0) === 'PREPAY', 'normalizeCreditTerms: โอนเงินก่อนส่งของ -> PREPAY');
check(normalizeCreditTerms('โอนก่อนส่ง', 0) === 'PREPAY', 'normalizeCreditTerms: โอนก่อนส่ง -> PREPAY');
check(normalizeCreditTerms('เคดิต', 0) === 'CREDIT', 'normalizeCreditTerms: typo เคดิต -> CREDIT');
check(normalizeCreditTerms('เครดิต30วัน', 0) === 'CREDIT', 'normalizeCreditTerms: เครดิต30วัน -> CREDIT');
check(normalizeCreditTerms('', 30) === 'CREDIT', 'normalizeCreditTerms: blank + creditDays>0 -> CREDIT');
check(normalizeCreditTerms('', 0) === 'OTHER', 'normalizeCreditTerms: blank + creditDays=0 -> OTHER');
check(normalizeCreditTerms('รพ.งานประมูล', 0) === 'OTHER', 'normalizeCreditTerms: unrelated free text -> OTHER');

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
}
