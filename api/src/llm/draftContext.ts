import type { ProductMatch } from '../catalog/match.js';

export interface DraftHistoryMessage {
  role: string;
  text: string;
  attachmentType?: string | null;
  attachmentRef?: string | null;
  aiCaption?: string | null;
}

type PhotoProduct = ProductMatch & { photoSku: string | null };

export function collectProductPhotoSkus(messages: DraftHistoryMessage[]): string[] {
  const seen = new Set<string>();
  const photoSkus: string[] = [];
  for (const message of messages) {
    if (message.role !== 'agent' || message.attachmentType !== 'product') continue;
    for (const photoSku of (message.attachmentRef ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
      if (!seen.has(photoSku)) {
        seen.add(photoSku);
        photoSkus.push(photoSku);
      }
    }
  }
  return photoSkus;
}

export function productNamesByPhotoSku(products: PhotoProduct[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const product of products) {
    if (!product.photoSku || names.has(product.photoSku)) continue;
    const name = product.nameEn || product.nameTh;
    if (name) names.set(product.photoSku, name);
  }
  return names;
}

export function renderHistoryLine(
  message: DraftHistoryMessage,
  productNames: ReadonlyMap<string, string> = new Map(),
): string {
  const label = message.role === 'customer' ? 'ลูกค้า' : 'ร้าน';
  const text = message.text.trim();
  let content = text;

  if (message.attachmentType === 'image') {
    const caption = message.aiCaption?.trim();
    if (caption) {
      content = text && text !== '[รูปภาพ]' ? `${text} [รูปภาพ: ${caption}]` : `[รูปภาพ: ${caption}]`;
    } else if (!text) {
      content = '[รูปภาพ]';
    }
  } else if (message.attachmentType === 'product') {
    const names = (message.attachmentRef ?? '')
      .split(',')
      .map((photoSku) => productNames.get(photoSku.trim()))
      .filter((name): name is string => !!name);
    const productLabel = names.length ? `[ส่งรูปสินค้า: ${names.join(', ')}]` : '[ส่งรูปสินค้า]';
    content = text ? `${text} ${productLabel}` : productLabel;
  }

  return `${label}: ${content}`;
}

export function selectShownProducts(
  newestFirstMessages: DraftHistoryMessage[],
  products: PhotoProduct[],
  limit = 8,
): ProductMatch[] {
  const byPhotoSku = new Map<string, PhotoProduct[]>();
  for (const product of products) {
    if (!product.photoSku) continue;
    const matches = byPhotoSku.get(product.photoSku) ?? [];
    matches.push(product);
    byPhotoSku.set(product.photoSku, matches);
  }

  const shown: ProductMatch[] = [];
  const seenSkus = new Set<string>();
  for (const message of newestFirstMessages) {
    if (message.role !== 'agent' || message.attachmentType !== 'product') continue;
    for (const photoSku of (message.attachmentRef ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
      for (const product of byPhotoSku.get(photoSku) ?? []) {
        if (seenSkus.has(product.sku)) continue;
        seenSkus.add(product.sku);
        shown.push(product);
        if (shown.length >= limit) return shown;
      }
    }
  }
  return shown;
}

export function selectCandidateSkus(
  products: ProductMatch[],
  shownSkus: ReadonlySet<string>,
  limit = 6,
): string[] {
  return products
    .filter((product) => product.photoSku && !shownSkus.has(product.sku))
    .slice(0, limit)
    .map((product) => product.sku);
}
