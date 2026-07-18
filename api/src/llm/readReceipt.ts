import { callClaudeWithImage, llmAvailable } from './anthropic.js';
import { normalizeAmount } from '../finance/normalize.js';

export interface ReceiptFields {
  amount: string;
  vendor: string;
  dateText: string;
}

const EMPTY: ReceiptFields = { amount: '', vendor: '', dateText: '' };

const RECEIPT_SYSTEM = `คุณคือผู้ช่วยอ่าน "บิลเงินสด/ใบเสร็จ" (receipt) จากการซื้อของ/จ่ายค่าบริการทั่วไปในประเทศไทย
รูปที่แนบมาอาจไม่ชัด เขียนด้วยลายมือ หรือเป็นบิลง่ายๆ จากร้านค้า/ปั๊มน้ำมัน/ทางด่วน ก็ได้
ดึงข้อมูลออกมาเป็น JSON เท่านั้น:
{"amount":"จำนวนเงินที่จ่ายทั้งหมด เป็นตัวเลข เช่น 150.00 (ไม่มีสัญลักษณ์/คอมมา)","vendor":"ชื่อร้านค้า/ผู้ให้บริการที่ปรากฏบนบิล","dateText":"วันที่ตามที่ปรากฏบนบิล (ตามรูปแบบเดิม ไม่ต้องแปลง)"}
ถ้าหาค่าใดไม่เจอให้ใส่ "" ห้ามเดา ตอบ JSON อย่างเดียว`;

// Best-effort OCR of a purchase receipt image → structured fields for prefilling a
// messenger's expense form (editable — receipts are messier than bank slips, see
// CERES_BRIEF §4/§7). Returns all-empty on any failure (no LLM credits, unreadable
// image, bad JSON) so the messenger can still fill the form manually.
export async function readReceiptImage(buf: Buffer, contentType: string): Promise<ReceiptFields> {
  if (!llmAvailable()) return EMPTY;
  try {
    const raw = await callClaudeWithImage('อ่านใบเสร็จนี้แล้วตอบ JSON ตามรูปแบบที่กำหนด', RECEIPT_SYSTEM, {
      base64: buf.toString('base64'),
      mediaType: contentType || 'image/jpeg',
    }, undefined, { app: 'ceres', feature: 'receipt-ocr' });
    const obj = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim()) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    return {
      amount: normalizeAmount(s(obj.amount)),
      vendor: s(obj.vendor),
      dateText: s(obj.dateText),
    };
  } catch {
    return EMPTY;
  }
}
