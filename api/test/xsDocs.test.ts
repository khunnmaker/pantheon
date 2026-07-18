import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { parseXsDocs } from '../src/finance/parseXsDocs.js';

// Synthetic STTRNR6.TXT mirroring the real export's shapes (verified against the real file
// 2026-07-19: 343/343 docs, grand total to the satang, 0 unresolved): ESC-bracketed bold, page
// banner repeating mid-doc, docs with no item lines (amount 0), multi-line docs, grand footer.
const ESC = '\x1b';
const FIXTURE = [
  'บริษัท พรอมมิเน้นท์ จำกัด                                หน้า   :        1',
  `${ESC}Wxรายงานจ่ายสินค้าภายใน${ESC}Wx `,
  'วันที่จาก  1 ม.ค. 2569     ถึง 19 ก.ค. 2569              วันที่ : 19/07/69',
  'เลขที่จาก  XS0000000       ถึง XS99999999      เลือกแผนก  *',
  '----------------------------------------------------------------------',
  'ลำดับ  รหัสสินค้า           รายละเอียด        คลังที่    จำนวน          ราคาต่อหน่วย      มูลค่ารวม',
  '----------------------------------------------------------------------',
  `${ESC}EXS6900001${ESC}F    05/01/69 ${ESC}E${ESC}F       เบิกไปให้คุณหมอดูตัวอย่าง`,
  `${ESC}EXS6900002${ESC}F    06/01/69 ${ESC}E${ESC}F`,
  `${ESC}EXS6900342${ESC}F    15/07/69 ${ESC}E${ESC}F       R022`,
  '   1   07-01-03  GELMAX                       02           5.00 ถุง           90.00        450.00',
  'บริษัท พรอมมิเน้นท์ จำกัด                                หน้า   :        2',
  `${ESC}Wxรายงานจ่ายสินค้าภายใน${ESC}Wx `,
  '----------------------------------------------------------------------',
  '   2   07-01-03  GELMAX                       02           2.00 ถุง           90.00        180.00',
  `                                              รวม        ${ESC}E       630.00${ESC}F`,
  `${ESC}EXS6900343${ESC}F    15/07/69 ${ESC}E${ESC}F       AQ045`,
  '   1   07-01-07  CROMAX                       02           7.00 ถุง           95.00        665.00',
  `                                              รวม        ${ESC}E       665.00${ESC}F`,
  '                                                          --------------',
  `                     เอกสาร      4 ใบ     รวมทั้งสิ้น   ${ESC}E      1,295.00${ESC}F`,
  '                                                          ==============',
  '>>>>  จบรายงาน  <<<<',
  '',
].join('\r\n');

const buf = () => iconv.encode(FIXTURE, 'win874');

describe('parseXsDocs (STTRNR6.TXT — Express XS internal goods-issue report)', () => {
  it('parses docs incl. zero-line ones, survives a mid-doc page break, self-checks totals', () => {
    const r = parseXsDocs(buf());
    expect(r.docs.map((d) => d.xsNo)).toEqual(['XS6900001', 'XS6900002', 'XS6900342', 'XS6900343']);
    expect(r.unresolved).toBe(0);

    const byNo = new Map(r.docs.map((d) => [d.xsNo, d]));
    expect(byNo.get('XS6900001')!.amount).toBe(0); // items never priced in the report
    expect(byNo.get('XS6900001')!.note).toBe('เบิกไปให้คุณหมอดูตัวอย่าง');
    expect(byNo.get('XS6900002')!.amount).toBe(0); // no item lines at all
    expect(byNo.get('XS6900342')!.amount).toBe(630); // items split across the page break
    expect(byNo.get('XS6900342')!.note).toBe('R022'); // sales-era docs carry the customer code
    expect(byNo.get('XS6900342')!.itemCount).toBe(2);
    expect(byNo.get('XS6900343')!.amount).toBe(665);

    expect(r.fileCount).toBe(4);
    expect(r.fileTotal).toBe(1295);
    expect(r.totalAmount).toBe(1295);
    expect(r.totalsMatch).toBe(true);
  });

  it('flags a doc-count / grand-total mismatch instead of passing silently', () => {
    const tampered = iconv.encode(FIXTURE.replace('1,295.00', '9,999.00'), 'win874');
    const r = parseXsDocs(tampered);
    expect(r.totalsMatch).toBe(false);
  });
});
