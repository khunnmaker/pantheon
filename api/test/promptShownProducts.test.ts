import { describe, expect, it } from 'vitest';
import type { ProductMatch } from '../src/catalog/match.js';
import { buildDraftPrompt, buildImagePrompt } from '../src/llm/prompt.js';

const shownProduct: ProductMatch = {
  sku: 'SKU-SHOWN',
  nameEn: 'Shown Product',
  nameTh: 'สินค้าที่เพิ่งส่ง',
  price: 1250,
  promo: '',
  note: '',
  photoSku: 'PHOTO-SHOWN',
  stock: 3,
  stockAt: null,
};

describe('recently shown product prompt context', () => {
  it.each([
    ['text', buildDraftPrompt],
    ['vision', buildImagePrompt],
  ] as const)('adds shown products only to the dynamic %s prompt', (_name, buildPrompt) => {
    const base = buildPrompt({ question: 'อันนี้ราคาเท่าไหร่', kb: [] });
    const withShown = buildPrompt({ question: 'อันนี้ราคาเท่าไหร่', kb: [], shownProducts: [shownProduct] });

    expect(withShown.system.cached).toEqual(base.system.cached);
    expect(withShown.user).toContain('สินค้าที่ร้านเพิ่งส่งรูปให้ลูกค้า');
    expect(withShown.user).toContain('[SKU-SHOWN] Shown Product / สินค้าที่เพิ่งส่ง — 1250 บาท');
  });
});
