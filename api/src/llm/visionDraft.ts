import type { ProductMatch } from '../catalog/match.js';
import { findProducts } from '../catalog/match.js';
import { callClaudeWithImages } from './anthropic.js';
import { parseDraft, SAFE_DEFAULT, type DraftResult } from './parser.js';
import { buildImagePrompt, type PromptContext } from './prompt.js';
import type { AttachedDraftImage } from './draftImages.js';

export interface VisionPassOutcome {
  result: DraftResult;
  products: ProductMatch[];
  firstPassCaptions: string[];
}

// At most two model calls: one identification pass, then one final pass if the
// model requested catalog terms and those terms produced genuinely new products.
export async function runVisionPasses(
  context: Omit<PromptContext, 'products' | 'productSearchExpanded'>,
  initialProducts: ProductMatch[],
  images: AttachedDraftImage[],
): Promise<VisionPassOutcome> {
  let products = initialProducts;
  const call = async (productSearchExpanded: boolean): Promise<DraftResult> => {
    const { system, user } = buildImagePrompt({ ...context, products, productSearchExpanded });
    const parsed = parseDraft(await callClaudeWithImages(
      user,
      system,
      images,
      undefined,
      { app: 'minerva', feature: 'vision-draft' },
    ));
    if (parsed === SAFE_DEFAULT) throw new Error('invalid vision draft envelope');
    // Captions are best-effort history enrichment — a miscounted array must not
    // invalidate an otherwise good draft (persistence maps by index and skips gaps).
    return parsed;
  };

  let result = await call(false);
  const firstPassCaptions = result.image_captions ?? [];
  if (result.product_search_terms?.length) {
    const searched = await findProducts(result.product_search_terms.join(' '));
    const injectedSkus = new Set([
      ...products,
      ...(context.shownProducts ?? []),
      ...(context.suggestProducts ?? []),
      ...(context.confirmedProducts ?? []),
    ].map((product) => product.sku));
    const added = searched.filter((product) => !injectedSkus.has(product.sku));
    if (added.length) {
      products = [...products, ...added];
      try {
        result = await call(true);
      } catch {
        // Keep pass one when optional enrichment fails.
      }
    }
  }

  return { result, products, firstPassCaptions };
}
