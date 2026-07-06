// Regression test for parseReReceipts — no test framework exists in this repo (see
// test-parse-oesoc.ts / test-parse-armast.ts precedent), so this is a plain script: exits
// 1 on any failure, prints PASS/FAIL per case.
//
//   npx tsx src/scripts/test-parse-rereceipts.ts
//
// The fixture below is hand-authored in the shape verified against the real ARRCPDAT.TXT
// export (RE header fixed-column layout, IV/SR detail lines, page headers, notPosted "***",
// a cancelled '*' receipt, and the "รวม <n> ใบ" footer self-check). It never embeds real
// customer/receipt data — Prominent's actual export (234 real receipts) is NOT committed
// to the repo.
import { parseReReceipts } from '../finance/parseReReceipts.js';

const FF = '\x0c';
const ESC = '\x1b';

const lines: string[] = [];

function pageHeader(pageNo: number, withFF: boolean): void {
  lines.push(
    (withFF ? FF : '') + 'บริษัท พรอมมิเน้นท์ จำกัด' + ' '.repeat(80) + `หน้า   :        ${pageNo}`,
  );
  lines.push(`${ESC}W\x01รายงานการรับชำระหนี้ เรียงตามวันที่ของใบเสร็จ${ESC}W\x00`);
  lines.push(
    'วันที่จาก   1 ก.ค. 2569   ถึง  6 ก.ค. 2569                                                                             วันที่ : 06/07/69',
  );
  if (pageNo === 1) {
    lines.push('พนักงานขาย                ถึง  แลป');
  }
  lines.push('-'.repeat(132));
  lines.push(
    '  วันที่  เลขที่ใบเสร็จ  ชื่อลูกค้า                             พนักงานขาย     ตัดเงินมัดจำ ยอดตามใบกำกับ   ชำระเป็น ง/ส         เช็ครับ   ด/บ รับ   ส่วนลด        ภาษี  หมายเหตุ  รับชำระโดย  ลงวันที่  ธนาคาร   จำนวนเงิน  สถานะเช็ค',
  );
  lines.push('-'.repeat(132));
}

// Helper: build a fixed-column RE header line exactly like the real file — name occupies
// columns [23:64), then salesName + amount(s) in the tail. Mirrors the real
// column-position discovery (see parseReReceipts.ts's NAME_START/NAME_END comment).
function reHeader(opts: {
  date: string;
  reNumber: string;
  customerName: string;
  salesName: string;
  amount: string;
  paidAmount?: string; // blank -> notPosted ("***") row
  cancelled?: boolean;
}): string {
  const datePart = opts.date + '  ';
  const marker = opts.cancelled ? '*' : '';
  const rePart = `${marker}RE${opts.reNumber}`.padEnd(13, ' ');
  const namePart = opts.customerName.padEnd(64 - 23, ' ');
  const salesPart = opts.salesName.padEnd(28, ' ');
  const amountPart = opts.amount.padStart(14, ' ');
  if (opts.paidAmount === undefined) {
    // notPosted: blank ชำระเป็น column, trailing *** marker further right
    return `${datePart}${rePart}${namePart}${salesPart}${amountPart}` + ' '.repeat(65) + '***';
  }
  const paidPart = opts.paidAmount.padStart(15, ' ');
  return `${datePart}${rePart}${namePart}${salesPart}${amountPart}${paidPart}`;
}

function detailLine(docNo: string, date: string, amount: string): string {
  return `                             ${docNo}    ${date}    ${amount.padStart(11, ' ')}`;
}

pageHeader(1, false);

// Receipt 1: clean single-invoice receipt.
lines.push(reHeader({ date: '01/07/69', reNumber: '6907402', customerName: 'ตั้งจี้เว้ง', salesName: 'แลป', amount: '848.00', paidAmount: '848.00' }));
lines.push(detailLine('IV6909538', '01/07/69', '848.00'));

// Receipt 2: multi-invoice receipt (several IV lines under one RE), plus a credit-note (SR,
// negative) line — must be collected together, negative amount must survive.
lines.push(reHeader({ date: '01/07/69', reNumber: '6907404', customerName: 'อาร์ดีแอล เดนทัล แลบ จำกัด', salesName: 'แลป', amount: '5,536.00', paidAmount: '5,536.00' }));
lines.push(detailLine('IV6905135', '02/04/69', '5,943.60'));
lines.push(detailLine('IV6905152', '02/04/69', '1,880.60'));
lines.push(detailLine('SR6900178', '01/07/69', '-2,408.00'));
lines.push(detailLine('SR6900104', '22/04/69', '-199.00'));

// Receipt 3: a customer name LONG enough to run right up against the sales-code column
// (no double-space gap) — proves fixed-column extraction, not whitespace-token splitting.
// (63 chars + 1 more would truncate — this is exactly 41 chars, fits without truncation,
// but abuts the salesName column with only a single space, same shape as the real
// "สงขลานครินทร C4" case.)
lines.push(reHeader({ date: '02/07/69', reNumber: '6907467', customerName: 'ภาควิชาจักษุวิทยามหาวิทยาลัยสงขลานครินทร', salesName: 'C4', amount: '480.00', paidAmount: '480.00' }));
lines.push(detailLine('IV6909999', '02/07/69', '480.00'));

// Receipt 4: notPosted ("***" marker, blank ชำระเป็น column) — must still be imported
// (owner spec: reconcile ALL REs equally), flagged via notPosted.
lines.push(reHeader({ date: '02/07/69', reNumber: '6907477', customerName: 'แพทย์จัดฟัน จำกัด', salesName: 'C4', amount: '7,413.00' }));
lines.push(detailLine('IV6909998', '02/07/69', '7,413.00'));

// Page break mid-receipt-block: lands between receipt 4's invoice and receipt 5's header —
// must not merge receipt 5 into receipt 4, and receipt 5 must still resolve correctly.
pageHeader(2, true);

// Receipt 5: cancelled ('*' before the RE number, per the footer legend) — must be SKIPPED
// entirely (not imported, no invoices attached even though one follows in the raw stream).
lines.push(reHeader({ date: '02/07/69', reNumber: '6907999', customerName: 'ทดสอบยกเลิก', salesName: 'C1', amount: '999.00', paidAmount: '999.00', cancelled: true }));
lines.push(detailLine('IV6909997', '02/07/69', '999.00'));

// Receipt 6: normal receipt after the cancelled one — must resolve on its own, not attach
// to the (skipped) cancelled receipt's invoice list.
lines.push(reHeader({ date: '02/07/69', reNumber: '6907468', customerName: 'วีไวท์', salesName: 'C1', amount: '1,408.00', paidAmount: '1,408.00' }));
lines.push(detailLine('IV6909545', '02/07/69', '1,408.00'));

lines.push('                                                                           -------------- -------------- -------------- -------------- ---------- ---------- ----------');
// Footer: 6 receipts imported (5 real + 1 cancelled skipped) but the file's own printed
// count covers every non-cancelled row it printed (5) — sum: 848 + 5536 + 480 + 7413 + 1408
// = 15,685.00. (The cancelled receipt's 999.00 is NOT part of Express's own total either —
// cancelled receipts never count toward the report's footer, matching real-world behavior.)
lines.push(
  `                                                         รวม 5 ใบ        ${ESC}E          0.00      15,685.00      14,277.00           0.00       0.00       0.00       0.00  ${ESC}F`,
);
lines.push('                                                                           ============== ============== ============== ============== ========== ========== ==========');
lines.push('');
lines.push("  ใบเสร็จที่มีเครื่องหมาย '*'   หน้าเลขที่เอกสาร  หมายถึงใบเสร็จถูกยกเลิก");
lines.push("  ใบเสร็จที่มีเครื่องหมาย '***' ในช่องหมายเหตุ  หมายถึงทำรายการรับชำระหนี้ไม่เรียบร้อย");
lines.push('>>>> จบรายงาน <<<<');

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

const result = parseReReceipts(fixtureText);

check(result.parsedCount === 5, `parsedCount === 5 (got ${result.parsedCount})`);
check(result.cancelledSkipped === 1, `cancelledSkipped === 1 (got ${result.cancelledSkipped})`);
check(result.unresolved === 0, `unresolved === 0 (got ${JSON.stringify(result.unresolvedSamples)})`);

const reNums = result.receipts.map((r) => r.reNumber).sort();
check(
  JSON.stringify(reNums) === JSON.stringify(['6907402', '6907404', '6907467', '6907468', '6907477']),
  `receipt RE numbers extracted correctly, cancelled 6907999 excluded (got ${JSON.stringify(reNums)})`,
);

// Receipt 1: clean single invoice.
const r1 = result.receipts.find((r) => r.reNumber === '6907402');
check(!!r1, '6907402 found');
check(r1?.amount === 848, `6907402 amount === 848 (got ${r1?.amount})`);
check(r1?.customerName === 'ตั้งจี้เว้ง', `6907402 customerName trimmed correctly (got ${JSON.stringify(r1?.customerName)})`);
check(r1?.salesName === 'แลป', `6907402 salesName === 'แลป' (got ${JSON.stringify(r1?.salesName)})`);
check(r1?.notPosted === false, '6907402 notPosted === false');
check(r1?.invoices.length === 1, `6907402 has 1 invoice (got ${r1?.invoices.length})`);

// Receipt 2: multi-invoice + negative credit-note lines must survive.
const r2 = result.receipts.find((r) => r.reNumber === '6907404');
check(!!r2, '6907404 found');
check(r2?.invoices.length === 4, `6907404 has 4 detail lines (2 IV + 2 SR) (got ${r2?.invoices.length})`);
const srLine = r2?.invoices.find((iv) => iv.docNo === 'SR6900178');
check(!!srLine, '6907404 SR6900178 credit-note line found');
check(srLine?.amount === -2408, `SR6900178 amount === -2408 (negative preserved) (got ${srLine?.amount})`);

// Receipt 3: long customer name abutting the sales-code column (fixed-column extraction,
// not whitespace-token splitting) must still resolve the correct salesName + amount.
const r3 = result.receipts.find((r) => r.reNumber === '6907467');
check(!!r3, '6907467 found (long name abutting salesName column)');
check(r3?.salesName === 'C4', `6907467 salesName === 'C4' despite abutting long name (got ${JSON.stringify(r3?.salesName)})`);
check(r3?.amount === 480, `6907467 amount === 480 (got ${r3?.amount})`);

// Receipt 4: notPosted flag set (trailing ***), still imported (no special exclusion).
const r4 = result.receipts.find((r) => r.reNumber === '6907477');
check(!!r4, '6907477 found');
check(r4?.notPosted === true, '6907477 notPosted === true (*** marker)');
check(r4?.amount === 7413, `6907477 amount === 7413 (got ${r4?.amount})`);

// Receipt 5 (cancelled, RE6907999) must NOT appear at all, and its trailing invoice line
// must not have leaked onto any other receipt.
const cancelled = result.receipts.find((r) => r.reNumber === '6907999');
check(!cancelled, 'cancelled receipt 6907999 is absent from receipts[]');
const r6 = result.receipts.find((r) => r.reNumber === '6907468');
check(!!r6, '6907468 found (the receipt AFTER the cancelled one)');
check(r6?.invoices.length === 1, `6907468 has its own 1 invoice, not the cancelled receipt's (got ${r6?.invoices.length})`);

// Self-check against the file's own footer total (5 receipts, 15,685.00).
check(result.fileTotal === 15685, `fileTotal parsed from footer === 15685 (got ${result.fileTotal})`);
check(Math.abs(result.totalAmount - 15685) < 0.005, `totalAmount === 15685 (got ${result.totalAmount})`);
check(result.totalsMatch === true, `totalsMatch === true (parsed sum reconciles the footer)`);

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
}
