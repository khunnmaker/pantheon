import { prisma } from '../db/prisma.js';
import { findProducts, type ProductMatch } from './match.js';

const DEMOTE_AT = -3; // score at/below which a cross-sell is hidden (regularly skipped)
const PROMOTE_AT = 1; // score at/above which a learned pairing is shown first
const TARGET = 5; // aim for ~5 cross-sell options

// Build the cross-sell list for an anchor product: learned-good pairings first
// (high score), then fresh AI-suggested terms resolved to real photo'd products —
// excluding the direct matches and any demoted (regularly-skipped) pairings.
export async function buildCrossSell(
  anchorSku: string | null,
  aiTerms: string[],
  excludeSkus: Set<string>,
): Promise<string[]> {
  // No AI terms = the model judged this isn't a product question → no cross-sell
  // (don't pad billing/greeting/address questions with catalog neighbors).
  if (!aiTerms.length) return [];
  const out: string[] = [];
  const demoted = new Set<string>();
  const seenNames = new Set<string>(); // avoid several variants of the same product
  const nameKey = (en: string, th: string, sku: string) => (en || th || sku).trim().toLowerCase();

  if (anchorSku) {
    const links = await prisma.crossSellLink.findMany({ where: { anchorSku }, orderBy: { score: 'desc' } });
    for (const l of links) if (l.score <= DEMOTE_AT) demoted.add(l.crossSku);
    for (const l of links) {
      if (out.length >= TARGET) break;
      if (l.score >= PROMOTE_AT && !excludeSkus.has(l.crossSku) && !out.includes(l.crossSku)) {
        const p = await prisma.product.findUnique({ where: { sku: l.crossSku } });
        if (p?.photoSku && p.status === 'active' && (p.nameEn || p.nameTh)) {
          const k = nameKey(p.nameEn, p.nameTh, p.sku);
          if (!seenNames.has(k)) {
            out.push(l.crossSku);
            seenNames.add(k);
          }
        }
      }
    }
  }

  const tryAdd = (h: ProductMatch): boolean => {
    if (out.length >= TARGET) return false;
    if (!h.photoSku || !(h.nameEn || h.nameTh)) return false; // need a photo + a name
    if (excludeSkus.has(h.sku) || out.includes(h.sku) || demoted.has(h.sku)) return false;
    const k = nameKey(h.nameEn, h.nameTh, h.sku);
    if (seenNames.has(k)) return false;
    out.push(h.sku);
    seenNames.add(k);
    return true;
  };

  // First pass: one product per term (variety).
  for (const term of aiTerms) {
    if (out.length >= TARGET) break;
    for (const h of await findProducts(term, 5)) {
      if (tryAdd(h)) break;
    }
  }
  // Second pass: top up toward TARGET with more products from each AI term.
  if (out.length < TARGET) {
    for (const term of aiTerms) {
      if (out.length >= TARGET) break;
      for (const h of await findProducts(term, 8)) {
        if (out.length >= TARGET) break;
        tryAdd(h);
      }
    }
  }
  // Final fallback to reach TARGET: catalog-page neighbors of the anchor — products
  // printed on the same page are usually the same family / complementary.
  if (out.length < TARGET && anchorSku) {
    const anchor = await prisma.product.findUnique({ where: { sku: anchorSku } });
    if (anchor?.page != null) {
      const neighbors = await prisma.product.findMany({
        where: { page: anchor.page, status: 'active', photoSku: { not: null } },
        orderBy: { sku: 'asc' },
        take: 60,
      });
      for (const p of neighbors) {
        if (out.length >= TARGET) break;
        tryAdd(p);
      }
    }
  }
  return out;
}

// Record the staff's choice for learning: strengthen cross-sells they attached,
// demote ones that were shown but skipped. Only called when staff engaged the
// picker (attached >=1 catalog photo), so a text-only reply isn't a signal.
export async function recordCrossSellOutcome(
  anchorSku: string,
  shownSkus: string[],
  chosenSkus: string[],
): Promise<void> {
  const chosen = new Set(chosenSkus);
  for (const crossSku of shownSkus) {
    const wasChosen = chosen.has(crossSku);
    await prisma.crossSellLink.upsert({
      where: { anchorSku_crossSku: { anchorSku, crossSku } },
      create: {
        anchorSku,
        crossSku,
        score: wasChosen ? 2 : -1,
        shownCount: 1,
        chosenCount: wasChosen ? 1 : 0,
      },
      update: {
        score: { increment: wasChosen ? 2 : -1 },
        shownCount: { increment: 1 },
        chosenCount: { increment: wasChosen ? 1 : 0 },
      },
    });
  }
}
