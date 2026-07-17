import { describe, expect, it } from 'vitest';
import { hasPriceContent } from './policy.js';

describe('learned-KB price policy', () => {
  it('detects Thai-baht price formats that must not enter learned knowledge', () => {
    expect(hasPriceContent('ปูน ราคา 625 บาท ต่อถุง')).toBe(true);
    expect(hasPriceContent('โปรโมชั่น ฿ 1,250 วันนี้')).toBe(true);
    expect(hasPriceContent('ราคา 55บาท')).toBe(true);
  });

  it('allows non-price numeric facts', () => {
    expect(hasPriceContent('บรรจุ 50 ชิ้น ผลิตในญี่ปุ่น รับประกัน 1 ปี')).toBe(false);
  });
});
