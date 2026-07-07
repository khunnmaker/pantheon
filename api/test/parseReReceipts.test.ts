// Regression tests for parseReReceipts (the RE-reconciliation money lane).
// Converted verbatim from src/scripts/test-parse-rereceipts.ts — SAME hand-authored
// fixture (shaped against the real ARRCPDAT.TXT export: RE fixed-column headers, IV/SR
// detail lines, page headers, notPosted "***", a cancelled '*' receipt, and the
// "รวม <n> ใบ" footer self-check), SAME assertions. No real customer/receipt data is
// embedded. Fully deterministic — the fixture is synthesized in-process, no file/DB/network.
import { describe, it, expect } from 'vitest';
import { parseReReceipts } from '../src/finance/parseReReceipts.js';

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
// columns [23:64), then salesName + amount(s) in the tail.
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
// Footer: 5 non-cancelled receipts printed — sum: 848 + 5536 + 480 + 7413 + 1408 = 15,685.00.
// (The cancelled receipt's 999.00 is NOT part of Express's own total.)
lines.push(
  `                                                         รวม 5 ใบ        ${ESC}E          0.00      15,685.00      14,277.00           0.00       0.00       0.00       0.00  ${ESC}F`,
);
lines.push('                                                                           ============== ============== ============== ============== ========== ========== ==========');
lines.push('');
lines.push("  ใบเสร็จที่มีเครื่องหมาย '*'   หน้าเลขที่เอกสาร  หมายถึงใบเสร็จถูกยกเลิก");
lines.push("  ใบเสร็จที่มีเครื่องหมาย '***' ในช่องหมายเหตุ  หมายถึงทำรายการรับชำระหนี้ไม่เรียบร้อย");
lines.push('>>>> จบรายงาน <<<<');

const fixtureText = lines.join('\n');
const result = parseReReceipts(fixtureText);

describe('parseReReceipts — top-level counts', () => {
  it('parses 5 receipts, skips 1 cancelled, leaves 0 unresolved', () => {
    expect(result.parsedCount).toBe(5);
    expect(result.cancelledSkipped).toBe(1);
    expect(result.unresolved).toBe(0);
  });

  it('extracts the correct RE numbers and excludes the cancelled 6907999', () => {
    const reNums = result.receipts.map((r) => r.reNumber).sort();
    expect(reNums).toEqual(['6907402', '6907404', '6907467', '6907468', '6907477']);
  });
});

describe('parseReReceipts — per-receipt shape', () => {
  it('Receipt 1: clean single invoice', () => {
    const r1 = result.receipts.find((r) => r.reNumber === '6907402');
    expect(r1).toBeTruthy();
    expect(r1?.amount).toBe(848);
    expect(r1?.customerName).toBe('ตั้งจี้เว้ง');
    expect(r1?.salesName).toBe('แลป');
    expect(r1?.notPosted).toBe(false);
    expect(r1?.invoices.length).toBe(1);
  });

  it('Receipt 2: multi-invoice + negative credit-note lines survive', () => {
    const r2 = result.receipts.find((r) => r.reNumber === '6907404');
    expect(r2).toBeTruthy();
    expect(r2?.invoices.length).toBe(4); // 2 IV + 2 SR
    const srLine = r2?.invoices.find((iv) => iv.docNo === 'SR6900178');
    expect(srLine).toBeTruthy();
    expect(srLine?.amount).toBe(-2408); // negative preserved
  });

  it('Receipt 3: long name abutting the salesName column still resolves fixed columns', () => {
    const r3 = result.receipts.find((r) => r.reNumber === '6907467');
    expect(r3).toBeTruthy();
    expect(r3?.salesName).toBe('C4');
    expect(r3?.amount).toBe(480);
  });

  it('Receipt 4: notPosted flag set (***) but still imported', () => {
    const r4 = result.receipts.find((r) => r.reNumber === '6907477');
    expect(r4).toBeTruthy();
    expect(r4?.notPosted).toBe(true);
    expect(r4?.amount).toBe(7413);
  });

  it('cancelled receipt is absent and does not leak its invoice onto the next receipt', () => {
    const cancelled = result.receipts.find((r) => r.reNumber === '6907999');
    expect(cancelled).toBeFalsy();
    const r6 = result.receipts.find((r) => r.reNumber === '6907468');
    expect(r6).toBeTruthy();
    expect(r6?.invoices.length).toBe(1);
  });
});

describe('parseReReceipts — footer self-check', () => {
  it('reconciles the parsed sum against the report footer total (15,685.00)', () => {
    expect(result.fileTotal).toBe(15685);
    expect(Math.abs(result.totalAmount - 15685)).toBeLessThan(0.005);
    expect(result.totalsMatch).toBe(true);
  });
});
