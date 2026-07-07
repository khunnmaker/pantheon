// Merged catalog taxonomy = built-in groups/sub-groups (code, in catalogGroups.ts) OVERLAID with
// staff-created ones (DB: CatalogGroupDef / CatalogSubgroupDef). Every route that needs the group
// vocabulary (the /groups list, group/sub-group validation, code generation) loads it from HERE so
// custom groups behave exactly like built-ins. Built-ins always exist even if the DB tables are
// empty, so the taxonomy can never "disappear". Auto-assign RULES stay code-only (regex) and only
// ever target built-in keys — custom groups are manual-assignment only, which is intended.

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
  for (const g of groups) {
    const builtin: TaxSubgroup[] = (SUBGROUPS[g.key] ?? []).map((s) => ({ ...s, custom: false }));
    const custom: TaxSubgroup[] = customSubs
      .filter((s) => s.groupKey === g.key)
      // drop any custom sub whose code collides with a built-in sub of the same group (built-in wins)
      .filter((s) => !builtin.some((b) => b.code === s.code))
      .map((s) => ({ code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, custom: true }));
    const merged = [...builtin, ...custom];
    if (merged.length) subgroupsByGroup.set(g.key, merged);
  }

  const groupKeys = new Set(groups.map((g) => g.key));
  const groupCodeByKey = new Map(groups.map((g) => [g.key, g.code]));
  const subCodesByGroup: Record<string, Set<string>> = {};
  for (const [k, subs] of subgroupsByGroup) subCodesByGroup[k] = new Set(subs.map((s) => s.code));
  const usedCodes = new Set(groups.map((g) => g.code.toUpperCase()));

  return { groups, subgroupsByGroup, groupKeys, groupCodeByKey, subCodesByGroup, usedCodes };
}
