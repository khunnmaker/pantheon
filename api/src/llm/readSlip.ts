import { callClaudeWithImage, llmAvailable } from './anthropic.js';
import { readImageContent } from '../line/contentStore.js';
import { normalizeSlipDate, normalizeAmount } from '../finance/normalize.js';

export interface SlipFields {
  amount: string;
  bank: string;
  transferAt: string;
  ref: string;
  senderName: string;
}

const EMPTY: SlipFields = { amount: '', bank: '', transferAt: '', ref: '', senderName: '' };

const SLIP_SYSTEM = `คุณคือผู้ช่วยอ่าน "สลิปโอนเงิน/หลักฐานการชำระเงิน" จากธนาคารในประเทศไทย
ดูรูปสลิปที่แนบมา แล้วดึงข้อมูลออกมาเป็น JSON เท่านั้น:
{"senderName":"ชื่อผู้โอน/เจ้าของบัญชีต้นทางที่ปรากฏบนสลิป (เช่น นาย/นาง/น.ส. ... หรือชื่อบัญชี — ผู้ที่ส่งเงินมา ไม่ใช่ผู้รับ)","amount":"จำนวนเงินเป็นตัวเลข เช่น 1500.00 (ไม่มีสัญลักษณ์/คอมมา)","bank":"ธนาคาร/เลขบัญชีปลายทางที่รับเงิน","transferAt":"วันที่และเวลาที่โอน รูปแบบ วว/ดด/ปปปป ชช:นน ใช้ปี ค.ศ. เท่านั้น (ถ้าสลิปเป็น พ.ศ. ให้ลบ 543) เช่น 27/06/2026 14:30","ref":"เลขที่อ้างอิง/รหัสรายการ"}
ถ้าหาค่าใดไม่เจอให้ใส่ "" ห้ามเดา ตอบ JSON อย่างเดียว`;

// Best-effort OCR of a payment slip image → structured fields. Returns all-empty on
// any failure (no LLM credits, unreadable image, bad JSON) so staff can fill manually.
export async function readSlip(messageId: string, contentType: string): Promise<SlipFields> {
  if (!llmAvailable()) return EMPTY;
  try {
    const buf = await readImageContent(messageId);
    if (!buf) return EMPTY;
    const raw = await callClaudeWithImage('อ่านสลิปนี้แล้วตอบ JSON ตามรูปแบบที่กำหนด', SLIP_SYSTEM, {
      base64: buf.toString('base64'),
      mediaType: contentType || 'image/jpeg',
    });
    const obj = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim()) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    return {
      amount: normalizeAmount(s(obj.amount)),
      bank: s(obj.bank),
      transferAt: normalizeSlipDate(s(obj.transferAt)),
      ref: s(obj.ref),
      senderName: s(obj.senderName),
    };
  } catch {
    return EMPTY;
  }
}
