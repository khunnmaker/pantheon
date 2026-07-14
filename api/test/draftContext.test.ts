import { describe, expect, it } from 'vitest';
import type { ProductMatch } from '../src/catalog/match.js';
import {
  productNamesByPhotoSku,
  renderHistoryLine,
  selectCandidateSkus,
  selectShownProducts,
} from '../src/llm/draftContext.js';

const product = (sku: string, photoSku: string | null = sku): ProductMatch => ({
  sku,
  nameEn: `Product ${sku}`,
  nameTh: `สินค้า ${sku}`,
  price: 100,
  promo: '',
  note: '',
  photoSku,
  stock: 5,
  stockAt: null,
});

describe('draft history context', () => {
  it('preserves the existing customer image-caption rendering', () => {
    expect(renderHistoryLine({
      role: 'customer', text: '[รูปภาพ]', attachmentType: 'image', aiCaption: 'กล่องสินค้า',
    })).toBe('ลูกค้า: [รูปภาพ: กล่องสินค้า]');
  });

  it('keeps agent text and appends its image caption', () => {
    expect(renderHistoryLine({
      role: 'agent', text: 'รุ่นนี้ค่ะ', attachmentType: 'image', aiCaption: 'ด้ามกรอสีเงิน',
    })).toBe('ร้าน: รุ่นนี้ค่ะ [รูปภาพ: ด้ามกรอสีเงิน]');
  });

  it('renders an uncaptained empty agent image instead of a blank history line', () => {
    expect(renderHistoryLine({
      role: 'agent', text: '', attachmentType: 'image', aiCaption: null,
    })).toBe('ร้าน: [รูปภาพ]');
  });

  it('renders product-photo names in attachment order using the first product per photo SKU', () => {
    const names = productNamesByPhotoSku([
      product('SKU-1', 'PHOTO-1'),
      { ...product('SKU-1B', 'PHOTO-1'), nameEn: 'Duplicate name' },
      { ...product('SKU-2', 'PHOTO-2'), nameEn: '', nameTh: 'สินค้าไทย' },
    ]);

    expect(renderHistoryLine({
      role: 'agent', text: 'ส่งรูปให้ดูค่ะ', attachmentType: 'product', attachmentRef: 'PHOTO-2,PHOTO-1',
    }, names)).toBe('ร้าน: ส่งรูปให้ดูค่ะ [ส่งรูปสินค้า: สินค้าไทย, Product SKU-1]');
  });

  it('gracefully labels a product-photo message whose names cannot be resolved', () => {
    expect(renderHistoryLine({
      role: 'agent', text: '', attachmentType: 'product', attachmentRef: 'MISSING',
    })).toBe('ร้าน: [ส่งรูปสินค้า]');
  });
});

describe('recently shown products', () => {
  it('deduplicates by SKU newest-first and caps the result at eight', () => {
    const products = [
      product('SKU-1', 'PHOTO-1'),
      product('SKU-1', 'PHOTO-DUPLICATE'),
      ...Array.from({ length: 9 }, (_, index) => product(`SKU-${index + 2}`, `PHOTO-${index + 2}`)),
    ];
    const messages = [
      { role: 'agent', text: '', attachmentType: 'product', attachmentRef: 'PHOTO-1,PHOTO-2,PHOTO-3,PHOTO-4' },
      { role: 'customer', text: 'อันนี้ราคาเท่าไหร่', attachmentType: null, attachmentRef: null },
      { role: 'agent', text: '', attachmentType: 'product', attachmentRef: 'PHOTO-DUPLICATE,PHOTO-5,PHOTO-6,PHOTO-7,PHOTO-8,PHOTO-9,PHOTO-10' },
    ];

    expect(selectShownProducts(messages, products).map((item) => item.sku)).toEqual([
      'SKU-1', 'SKU-2', 'SKU-3', 'SKU-4', 'SKU-5', 'SKU-6', 'SKU-7', 'SKU-8',
    ]);
  });

  it('excludes recently shown SKUs from new photo candidates', () => {
    const products = [product('SKU-1'), product('SKU-2'), product('SKU-3', null)];

    expect(selectCandidateSkus(products, new Set(['SKU-1']))).toEqual(['SKU-2']);
  });
});
