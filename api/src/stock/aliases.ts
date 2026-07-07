// Product alias generation. A product's canonical key is its dashed SKU ("07-10-09",
// shared with Express — never changed). An ALIAS is a short human code staff can type/read.
//
// GROUP-BASED codes (current scheme): alias = <2-letter group code>[<2-letter subgroup>]<num>,
// numbered within the (group, subgroup) bucket. e.g. IM01 (impression, no sub), IMAL01
// (impression/alginate), EN12 (endo). Self-describing by category. See catalogGroups.ts.
// (The older FAMILY-based buildAliases — "TR34" — is kept below for its unit test / reference.)

import { GROUP_CODE, SUBGROUP_CODES } from './catalogGroups.js';

export interface AliasAssignment {
  sku: string;
  alias: string;
  groupKey: string;
  prefix: string; // the alpha prefix (group code, or group+subgroup code)
}

// The alpha prefix for a product's code: group code, plus its subgroup code when it has a
// valid one for that group (e.g. "IM" or "IMAL"). null if the product has no/invalid group.
// groupCode / subCodes default to the built-in maps; callers pass the MERGED maps (from
// stock/taxonomy.ts) so staff-created groups get codes too.
export function codePrefix(
  catalogGroup: string | null,
  catalogSubgroup: string | null,
  groupCode: Map<string, string> = GROUP_CODE,
  subCodes: Record<string, Set<string>> = SUBGROUP_CODES,
): string | null {
  if (!catalogGroup || !groupCode.has(catalogGroup)) return null;
  const g = groupCode.get(catalogGroup)!;
  const sub = catalogSubgroup && subCodes[catalogGroup]?.has(catalogSubgroup) ? catalogSubgroup : '';
  return g + sub;
}

// Build group-based codes. Deterministic: same input → same output. Only products WITH a
// (valid) catalogGroup get a code. Numbering is per PREFIX bucket (group, or group+subgroup),
// so IMAL01/IMAL02 and IM01/IM02 coexist. `keep` (sku→alias) preserves existing codes and
// APPENDS new items after the bucket's current max, so codes stay stable as items are added.
export function buildGroupAliases(
  products: { sku: string; catalogGroup: string | null; catalogSubgroup?: string | null }[],
  opts?: { keep?: Record<string, string>; groupCode?: Map<string, string>; subCodes?: Record<string, Set<string>> },
): AliasAssignment[] {
  const keep = opts?.keep ?? {};
  const groupCode = opts?.groupCode ?? GROUP_CODE;
  const subCodes = opts?.subCodes ?? SUBGROUP_CODES;
  const sorted = [...products].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  // Bucket by resolved prefix (group or group+subgroup), in ascending SKU order.
  const byPrefix = new Map<string, { sku: string; groupKey: string }[]>();
  for (const p of sorted) {
    const prefix = codePrefix(p.catalogGroup, p.catalogSubgroup ?? null, groupCode, subCodes);
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push({ sku: p.sku, groupKey: p.catalogGroup! });
  }

  const out: AliasAssignment[] = [];
  for (const [prefix, members] of byPrefix) {
    const codeRe = new RegExp(`^${prefix}(\\d+)$`);
    const used = new Set<number>();
    for (const m of members) {
      const k = keep[m.sku];
      const mt = k && codeRe.exec(k);
      if (mt) used.add(parseInt(mt[1], 10));
    }
    let next = 1;
    const nextFree = () => {
      while (used.has(next)) next++;
      used.add(next);
      return next;
    };
    const width = Math.max(2, String(members.length).length);
    for (const m of members) {
      const k = keep[m.sku];
      const n = k && codeRe.test(k) ? parseInt(codeRe.exec(k)![1], 10) : nextFree();
      out.push({ sku: m.sku, alias: `${prefix}${String(n).padStart(width, '0')}`, groupKey: m.groupKey, prefix });
    }
  }
  return out;
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
