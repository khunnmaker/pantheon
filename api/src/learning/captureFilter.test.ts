import { describe, expect, it } from 'vitest';
import { learningCaptureDecision } from './captureFilter.js';

describe('learning capture noise filter', () => {
  it('skips a transactional order summary with a bullet-like list', () => {
    const finalAnswer = `ขอบคุณค่ะ ขอสรุปรายการตามนี้
- หน้ากากอนามัย 2 กล่อง
- ถุงมือไซซ์ M 3 กล่อง
ได้รับเรียบร้อยค่ะ`;

    expect(learningCaptureDecision('รับทราบค่ะ ต้องการให้ช่วยอะไรเพิ่มเติมไหมคะ', finalAnswer)).toEqual({
      capture: false,
      reason: 'transactional_ack',
    });
  });

  it('retains an order-shaped reply when staff added a reusable product or policy fact', () => {
    const finalAnswer = `ขอสรุปรายการตามนี้
- ซีเมนต์ 2 ถุง
สินค้านำเข้าจากญี่ปุ่นและรับประกัน 1 ปีค่ะ`;

    expect(learningCaptureDecision('ขอสรุปรายการ ซีเมนต์ 2 ถุงค่ะ', finalAnswer)).toEqual({ capture: true });
  });

  it('skips an edit that only removes emoji, polite particles, and extra wording', () => {
    const aiDraft = 'สินค้ารุ่นนี้มีพร้อมจัดส่งค่ะ 😊 หากสนใจแจ้งจำนวนได้เลยนะคะ';
    const finalAnswer = 'สินค้ารุ่นนี้มีพร้อมจัดส่งครับ';

    expect(learningCaptureDecision(aiDraft, finalAnswer)).toEqual({ capture: false, reason: 'tone_only' });
  });

  it('retains edits that add a new fact or change a number', () => {
    expect(learningCaptureDecision('สินค้าพร้อมส่งค่ะ', 'สินค้านำเข้าจากเยอรมนี พร้อมส่งค่ะ')).toEqual({ capture: true });
    expect(learningCaptureDecision('ในกล่องมี 10 ชิ้นค่ะ', 'ในกล่องมี 12 ชิ้นค่ะ')).toEqual({ capture: true });
  });
});
