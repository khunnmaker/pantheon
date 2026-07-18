import { describe, expect, it } from 'vitest';
import { normalizeForSimilarity, textSimilarity } from './textSimilarity.js';

describe('textSimilarity', () => {
  it('returns one for identical Thai text', () => {
    expect(textSimilarity('ได้รับสลิปแล้วค่ะ', 'ได้รับสลิปแล้วค่ะ')).toBe(1);
  });

  it('ignores emoji, punctuation, zero-width characters, and whitespace', () => {
    const draft = 'ได้รับสลิปแล้วค่ะ 😊 เดี๋ยวเจ้าหน้าที่ตรวจสอบให้นะคะ';
    const sent = '  ได้รับสลิปแล้วค่ะ\u200b เดี๋ยวเจ้าหน้าที่ตรวจสอบให้นะคะ!  ';
    expect(textSimilarity(draft, sent)).toBeGreaterThan(0.95);
    expect(normalizeForSimilarity(draft)).toBe(normalizeForSimilarity(sent));
  });

  it('scores a genuine rewrite below 0.7', () => {
    expect(textSimilarity(
      'ได้รับสลิปแล้วค่ะ เดี๋ยวเจ้าหน้าที่ตรวจสอบให้นะคะ',
      'สินค้ายังไม่พร้อมส่ง กรุณาแจ้งชื่อและเบอร์โทรกลับด้วยค่ะ',
    )).toBeLessThan(0.7);
  });

  it('caps very large inputs without leaving the valid range', () => {
    expect(textSimilarity('ก'.repeat(5000), 'ก'.repeat(4999) + 'ข')).toBe(1);
  });
});
