// Merged catalog taxonomy = built-in groups/sub-groups (code, in catalogGroups.ts) OVERLAID with
// staff-created ones (DB: CatalogGroupDef / CatalogSubgroupDef). Every route that needs the group
// vocabulary (the /groups list, group/sub-group validation, code generation) loads it from HERE so
// custom groups behave exactly like built-ins. A DB sub-group row can replace a built-in code in
// place, or override its display names when the code still matches. Built-ins always exist unless
// explicitly replaced, even if the DB tables are empty, so the taxonomy can never "disappear".
// Auto-assign rules stay code-only (regex) and target built-in keys; replacement codes are exposed
// as a remap, while custom groups remain manual-assignment only.

import { prisma } from '../db/prisma.js';
import { CATALOG_GROUPS, SUBGROUPS, type Pillar } from './catalogGroups.js';

export const PILLARS: Pillar[] = ['lab', 'digital', 'clinical', 'equipment', 'review'];

export interface TaxGroup {
  key: string;
  code: string;
  nameTh: string;
  nameEn: string;
  pillar: Pillar;
  custom: boolean; // true = staff-created (editable/deletable)
}
export interface TaxSubgroup {
  code: string;
  nameTh: string;
  nameEn: string;
  custom: boolean;
}
export interface Taxonomy {
  groups: TaxGroup[]; // built-ins (in code order) then custom, for display
  subgroupsByGroup: Map<string, TaxSubgroup[]>;
  groupKeys: Set<string>;
  groupCodeByKey: Map<string, string>;
  subCodesByGroup: Record<string, Set<string>>;
  builtinSubRemap: Record<string, Record<string, string>>;
  usedCodes: Set<string>; // every group code in use (built-in + custom), UPPERCASE
}

export async function loadTaxonomy(): Promise<Taxonomy> {
  const [customGroups, customSubs] = await Promise.all([
    prisma.catalogGroupDef.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.catalogSubgroupDef.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const builtinKeys = new Set(CATALOG_GROUPS.map((g) => g.key));

  const groups: TaxGroup[] = [
    ...CATALOG_GROUPS.map((g) => ({ ...g, custom: false })),
    // a custom row that somehow shares a built-in key is ignored (built-in wins)
    ...customGroups
      .filter((g) => !builtinKeys.has(g.key))
      .map((g) => ({ key: g.key, code: g.code, nameTh: g.nameTh, nameEn: g.nameEn, pillar: g.pillar as Pillar, custom: true })),
  ];

  const subgroupsByGroup = new Map<string, TaxSubgroup[]>();
  const builtinSubRemap: Record<string, Record<string, string>> = {};
  for (const g of groups) {
    const groupSubs = customSubs.filter((s) => s.groupKey === g.key);
    const builtinCodes = new Set((SUBGROUPS[g.key] ?? []).map((s) => s.code));
    const replacementRows = new Set(groupSubs.filter((s) => s.replacesBuiltin && builtinCodes.has(s.replacesBuiltin)));
    const replacements = new Map([...replacementRows].map((s) => [s.replacesBuiltin!, s]));
    // A row only name-overrides a built-in that is still LIVE — once a built-in is replaced, its
    // old code is free again, and a later row reusing it is an ordinary custom sub-group.
    const overrides = new Map(groupSubs.filter((s) => !replacementRows.has(s) && builtinCodes.has(s.code) && !replacements.has(s.code)).map((s) => [s.code, s]));
    const builtin: TaxSubgroup[] = (SUBGROUPS[g.key] ?? []).map((s) => {
      const replacement = replacements.get(s.code);
      if (replacement) return { code: replacement.code, nameTh: replacement.nameTh, nameEn: replacement.nameEn, custom: true };
      const override = overrides.get(s.code);
      return { ...s, ...(override ? { nameTh: override.nameTh, nameEn: override.nameEn } : {}), custom: false };
    });
    const custom: TaxSubgroup[] = groupSubs
      .filter((s) => !replacementRows.has(s) && !overrides.has(s.code))
      .map((s) => ({ code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, custom: true }));
    const merged = [...builtin, ...custom];
    if (merged.length) subgroupsByGroup.set(g.key, merged);
    if (replacements.size) builtinSubRemap[g.key] = Object.fromEntries([...replacements].map(([oldCode, row]) => [oldCode, row.code]));
  }

  const groupKeys = new Set(groups.map((g) => g.key));
  const groupCodeByKey = new Map(groups.map((g) => [g.key, g.code]));
  const subCodesByGroup: Record<string, Set<string>> = {};
  for (const [k, subs] of subgroupsByGroup) subCodesByGroup[k] = new Set(subs.map((s) => s.code));
  const usedCodes = new Set(groups.map((g) => g.code.toUpperCase()));

  return { groups, subgroupsByGroup, groupKeys, groupCodeByKey, subCodesByGroup, builtinSubRemap, usedCodes };
}
