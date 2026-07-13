import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductMatch } from '../src/catalog/match.js';

const { callClaudeWithImages, findProducts } = vi.hoisted(() => ({
  callClaudeWithImages: vi.fn(),
  findProducts: vi.fn(),
}));

vi.mock('../src/llm/anthropic.js', () => ({ callClaudeWithImages }));
vi.mock('../src/catalog/match.js', () => ({ findProducts }));

import { parseDraft } from '../src/llm/parser.js';
import { runVisionPasses } from '../src/llm/visionDraft.js';

const product = (sku: string): ProductMatch => ({
  sku,
  nameEn: `Product ${sku}`,
  nameTh: '',
  price: 100,
  promo: '',
  note: '',
  photoSku: sku,
  stock: 5,
  stockAt: null,
});

const context = {
  question: 'อันนี้ราคาเท่าไหร่คะ',
  kb: [],
  recentWindow: 'ลูกค้า: [รูปภาพ]\nลูกค้า: อันนี้ราคาเท่าไหร่คะ',
};
const images = [{ messageId: 'image-1', base64: 'cGhvdG8=', mediaType: 'image/jpeg' }];

describe('vision draft envelope and catalog enrichment', () => {
  beforeEach(() => {
    callClaudeWithImages.mockReset();
    findProducts.mockReset();
  });

  it('parses every new image envelope field', () => {
    const parsed = parseDraft(JSON.stringify({
      type: 'draft',
      draft: 'ได้ค่ะ',
      used_kb: ['KB-1'],
      used_products: ['SKU-1'],
      cross_sell_terms: ['mixing tips'],
      stage: 'ถาม',
      image_captions: ['กล่องวัสดุพิมพ์ปาก'],
      product_search_terms: ['วัสดุพิมพ์ปาก', 'impression material'],
      note: '',
    }));

    expect(parsed).toMatchObject({
      used_products: ['SKU-1'],
      cross_sell_terms: ['mixing tips'],
      stage: 'ถาม',
      image_captions: ['กล่องวัสดุพิมพ์ปาก'],
      product_search_terms: ['วัสดุพิมพ์ปาก', 'impression material'],
    });
  });

  it('sends all attached burst images oldest-first with the typed question context', async () => {
    const burstImages = [
      { messageId: 'image-1', base64: 'b2xk', mediaType: 'image/jpeg' },
      { messageId: 'image-2', base64: 'bmV3', mediaType: 'image/png' },
    ];
    callClaudeWithImages.mockResolvedValue(JSON.stringify({
      type: 'draft', draft: 'ได้ค่ะ', used_kb: [], note: '',
      image_captions: ['รูปเก่า', 'รูปใหม่'], product_search_terms: [],
    }));

    await runVisionPasses(context, [], burstImages);

    expect(callClaudeWithImages).toHaveBeenCalledTimes(1);
    expect(callClaudeWithImages.mock.calls[0][0]).toContain('อันนี้ราคาเท่าไหร่คะ');
    expect(callClaudeWithImages.mock.calls[0][2]).toEqual(burstImages);
  });

  it('runs one catalog second pass and never loops even if pass two asks again', async () => {
    callClaudeWithImages
      .mockResolvedValueOnce(JSON.stringify({
        type: 'needs_human', draft: '', used_kb: [], note: '',
        image_captions: ['กล่องสินค้าทันตกรรม'], product_search_terms: ['dental product'],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        type: 'draft', draft: 'สินค้านี้ราคา 100 บาทค่ะ', used_kb: [], note: '',
        used_products: ['SKU-NEW'], image_captions: ['กล่องสินค้า SKU-NEW'],
        product_search_terms: ['another search'],
      }));
    findProducts.mockResolvedValue([product('SKU-NEW')]);

    const outcome = await runVisionPasses(context, [], images);

    expect(findProducts).toHaveBeenCalledTimes(1);
    expect(callClaudeWithImages).toHaveBeenCalledTimes(2);
    expect(outcome.products.map((item) => item.sku)).toEqual(['SKU-NEW']);
    expect(outcome.result.used_products).toEqual(['SKU-NEW']);
  });

  it('keeps pass one when search returns only already-injected candidates', async () => {
    callClaudeWithImages.mockResolvedValue(JSON.stringify({
      type: 'needs_human', draft: '', used_kb: [], note: '',
      image_captions: ['สินค้าเดิม'], product_search_terms: ['same product'],
    }));
    findProducts.mockResolvedValue([product('SKU-OLD')]);

    await runVisionPasses(context, [product('SKU-OLD')], images);

    expect(callClaudeWithImages).toHaveBeenCalledTimes(1);
  });
});
