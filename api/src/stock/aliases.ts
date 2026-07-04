// Product alias generation. A product's canonical key is its dashed SKU ("07-10-09",
// shared with Express — never changed). An ALIAS is a short human code ("TR34") staff can
// type/read. Products in the same FAMILY (first two SKU segments, e.g. "01-01") share one
// alpha PREFIX, and alias = prefix + the item's third segment. Prefixes are globally
// unique, so aliases are too. buildAliases is PURE + deterministic (no DB) so it's testable.

export interface AliasAssignment {
  sku: string;
  alias: string;
  groupKey: string;
  prefix: string;
}

// The family a product belongs to: first two SKU segments, e.g. "07-10-09" → "07-10".
export function groupOf(sku: string): string {
  return sku.split('-').slice(0, 2).join('-');
}

function thirdOf(sku: string): string | null {
  const parts = sku.split('-');
  return parts.length >= 3 ? parts[2] : null;
}

// Candidate prefixes for a group, in priority order. Derived from the group's lead product
// name; falls back to a category-based code when the name has no Latin letters (Thai-only).
function prefixCandidates(name: string, groupKey: string): string[] {
  const letters = (name || '').toUpperCase().replace(/[^A-Z]/g, '');
  const out: string[] = [];
  if (letters.length >= 2) {
    const base2 = letters.slice(0, 2);
    out.push(base2);
    if (letters.length >= 3) out.push(letters.slice(0, 3));
    for (let d = 2; d <= 99; d++) out.push(base2 + d);
  } else {
    const cat = groupKey.split('-')[0] || 'X';
    const base = 'P' + cat; // e.g. group "07-10" → "P07"
    out.push(base);
    for (const s of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') out.push(base + s);
    for (let d = 2; d <= 99; d++) out.push(base + d);
  }
  return out;
}

// Assign a globally-unique alias to each product. Deterministic: same input → same output.
//   opts.existingPrefixByGroup — pin a group's prefix (manual edits / fill-only mode)
//   opts.keepAliases           — pin a product's existing alias (fill-only never reassigns it)
export function buildAliases(
  products: { sku: string; nameEn: string; nameTh: string }[],
  opts?: { existingPrefixByGroup?: Record<string, string>; keepAliases?: Record<string, string> },
): AliasAssignment[] {
  const existingPrefix = opts?.existingPrefixByGroup ?? {};
  const keep = opts?.keepAliases ?? {};

  const sorted = [...products].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const groups = new Map<string, typeof sorted>();
  for (const p of sorted) {
    const g = groupOf(p.sku);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }

  // Prefixes already spoken for (pinned groups) must not be re-derived onto another group.
  const usedPrefixes = new Set<string>();
  for (const g of Object.keys(existingPrefix)) usedPrefixes.add(existingPrefix[g].toUpperCase());

  const groupPrefix = new Map<string, string>();
  for (const g of [...groups.keys()].sort()) {
    if (existingPrefix[g]) {
      groupPrefix.set(g, existingPrefix[g].toUpperCase());
      continue;
    }
    const lead = groups.get(g)![0]; // smallest sku in the group
    const name = (lead.nameEn || '').trim() || (lead.nameTh || '').trim();
    const chosen =
      prefixCandidates(name, g).find((c) => !usedPrefixes.has(c)) ?? 'P' + g.replace(/-/g, '');
    usedPrefixes.add(chosen);
    groupPrefix.set(g, chosen);
  }

  const out: AliasAssignment[] = [];
  const usedAliases = new Set<string>(Object.values(keep).map((a) => a.toUpperCase()));
  for (const p of sorted) {
    const g = groupOf(p.sku);
    const third = thirdOf(p.sku);
    if (third == null) continue; // malformed sku → skip rather than crash
    const prefix = groupPrefix.get(g) ?? existingPrefix[g] ?? '';
    if (keep[p.sku]) {
      out.push({ sku: p.sku, alias: keep[p.sku].toUpperCase(), groupKey: g, prefix });
      continue;
    }
    const alias = (prefix + third).toUpperCase();
    if (usedAliases.has(alias)) throw new Error(`alias collision: ${alias} (sku ${p.sku})`);
    usedAliases.add(alias);
    out.push({ sku: p.sku, alias, groupKey: g, prefix });
  }
  return out;
}
