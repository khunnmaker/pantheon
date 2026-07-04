// Product alias generation. A product's canonical key is its dashed SKU ("07-10-09",
// shared with Express — never changed). An ALIAS is a short human code staff can type/read.
//
// GROUP-BASED codes (current scheme): alias = <2-letter group code> + running number within
// the group, e.g. IM01 (impression), EN12 (endo). Self-describing by category. See
// buildGroupAliases + catalogGroups.ts. (The older FAMILY-based buildAliases — prefix +
// item segment, e.g. "TR34" — is kept below for its unit test / reference.)

import { GROUP_CODE } from './catalogGroups.js';

export interface AliasAssignment {
  sku: string;
  alias: string;
  groupKey: string;
  prefix: string;
}

// Build group-based codes. Deterministic: same input → same output. Only products WITH a
// catalogGroup get a code (ungrouped → excluded — assign a group first). `keep` (sku→alias)
// preserves existing codes and APPENDS new items after the group's current max number, so
// codes stay stable as products are added; without it, every group renumbers from 1.
export function buildGroupAliases(
  products: { sku: string; catalogGroup: string | null }[],
  opts?: { keep?: Record<string, string> },
): AliasAssignment[] {
  const keep = opts?.keep ?? {};
  // Group members by catalogGroup, in ascending SKU order for stable numbering.
  const sorted = [...products].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const byGroup = new Map<string, { sku: string }[]>();
  for (const p of sorted) {
    if (!p.catalogGroup || !GROUP_CODE.has(p.catalogGroup)) continue;
    if (!byGroup.has(p.catalogGroup)) byGroup.set(p.catalogGroup, []);
    byGroup.get(p.catalogGroup)!.push({ sku: p.sku });
  }

  const out: AliasAssignment[] = [];
  for (const [groupKey, members] of byGroup) {
    const code = GROUP_CODE.get(groupKey)!;
    const codeRe = new RegExp(`^${code}(\\d+)$`);
    // Which numbers are already used in this group (by a KEPT alias for one of its members)?
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
    const width = Math.max(2, String(members.length).length); // 2 digits, or more for 100+
    for (const m of members) {
      const k = keep[m.sku];
      const n = k && codeRe.test(k) ? parseInt(codeRe.exec(k)![1], 10) : nextFree();
      out.push({ sku: m.sku, alias: `${code}${String(n).padStart(width, '0')}`, groupKey, prefix: code });
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
