import { buildAliases, buildGroupAliases, groupOf } from '../stock/aliases.js';

// Plain regression test for the PURE alias generator (no DB). Exits 1 on any failure.
let fails = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) fails++;
}

// 1. groupOf
check('groupOf("07-10-09") === "07-10"', groupOf('07-10-09') === '07-10');

// 2. A tray family → prefix "TR", alias for item 34 = "TR34".
const trays = [
  { sku: '01-01-01', nameEn: 'TRAY MATERIAL 1 kg', nameTh: '' },
  { sku: '01-01-05', nameEn: 'TRAY MATERIAL 1 kg', nameTh: '' },
  { sku: '01-01-34', nameEn: 'GOODYS', nameTh: '' },
];
const trayRes = buildAliases(trays);
const trayAlias = (sku: string) => trayRes.find((r) => r.sku === sku)?.alias;
check('all tray aliases start with TR', trayRes.every((r) => r.alias.startsWith('TR')));
check('01-01-34 → TR34', trayAlias('01-01-34') === 'TR34');
check('01-01-01 → TR01', trayAlias('01-01-01') === 'TR01');

// 3. Two groups whose lead names both start with "SE" → second gets a different prefix.
const collide = [
  { sku: '01-02-01', nameEn: 'SELF CURE 38', nameTh: '' },
  { sku: '01-02-02', nameEn: 'SELF CURE 39', nameTh: '' },
  { sku: '01-03-01', nameEn: 'SELF ETCH BOND', nameTh: '' },
  { sku: '01-03-02', nameEn: 'SELF ETCH BOND', nameTh: '' },
];
const colRes = buildAliases(collide);
const pfxOf = (g: string) => colRes.find((r) => r.groupKey === g)?.prefix;
check('two "SE" families get different prefixes', pfxOf('01-02') !== pfxOf('01-03'));
check('collide set: all aliases unique', new Set(colRes.map((r) => r.alias)).size === colRes.length);

// 4. Thai-only-named group → non-empty fallback alias, still unique.
const thai = [
  { sku: '20-09-02', nameEn: '', nameTh: 'สารช่วยในการหล่อลื่น' },
  { sku: '20-09-03', nameEn: '', nameTh: 'สารช่วยในการหล่อลื่น' },
];
const thaiRes = buildAliases(thai);
check('thai-only group produces aliases', thaiRes.length === 2);
check('thai-only aliases are non-empty', thaiRes.every((r) => r.alias.length >= 2));
check('thai-only aliases unique', new Set(thaiRes.map((r) => r.alias)).size === 2);

// 5. Full-set uniqueness across a mixed catalog.
const mixed = [...trays, ...collide, ...thai];
const mixedRes = buildAliases(mixed);
check('mixed set: aliases globally unique', new Set(mixedRes.map((r) => r.alias)).size === mixedRes.length);
check('mixed set: one alias per product', mixedRes.length === mixed.length);

// 6. Determinism — same input twice → identical output.
const a = JSON.stringify(buildAliases(mixed));
const b = JSON.stringify(buildAliases(mixed));
check('deterministic (stable output)', a === b);

// 7. Malformed sku (no third segment) is skipped, not crashing.
const malformed = buildAliases([{ sku: '99-99', nameEn: 'BROKEN', nameTh: '' }, { sku: '99-99-01', nameEn: 'BROKEN', nameTh: '' }]);
check('malformed sku skipped (1 of 2)', malformed.length === 1 && malformed[0].sku === '99-99-01');

// 8. Fill-only keeps pinned prefixes + aliases and only assigns fresh SKUs.
const fill = buildAliases(
  [{ sku: '01-01-01', nameEn: 'TRAY MATERIAL', nameTh: '' }, { sku: '01-01-77', nameEn: 'TRAY MATERIAL', nameTh: '' }],
  { existingPrefixByGroup: { '01-01': 'ZZ' }, keepAliases: { '01-01-01': 'ZZ01' } },
);
check('fill: pinned prefix reused → 01-01-77 = ZZ77', fill.find((r) => r.sku === '01-01-77')?.alias === 'ZZ77');
check('fill: kept alias preserved → 01-01-01 = ZZ01', fill.find((r) => r.sku === '01-01-01')?.alias === 'ZZ01');

// ── group-based codes (buildGroupAliases) ──
// impression = code "IM"; two impression products (by sku order) → IM01, IM02.
const gp = [
  { sku: '07-01-04', catalogGroup: 'impression' },
  { sku: '07-01-07', catalogGroup: 'impression' },
  { sku: '07-22-01', catalogGroup: 'endo' },
  { sku: '99-99-01', catalogGroup: null }, // ungrouped → no code
];
const gRes = buildGroupAliases(gp);
const gAlias = (sku: string) => gRes.find((r) => r.sku === sku)?.alias;
check('group: IM01 for first impression (by sku)', gAlias('07-01-04') === 'IM01');
check('group: IM02 for second impression', gAlias('07-01-07') === 'IM02');
check('group: EN01 for the endo product', gAlias('07-22-01') === 'EN01');
check('group: ungrouped product gets no code', gRes.every((r) => r.sku !== '99-99-01'));
check('group: deterministic', JSON.stringify(buildGroupAliases(gp)) === JSON.stringify(gRes));
// fill/append: keep IM01, a NEW impression product appends as IM02 (not renumbering IM01).
const gFill = buildGroupAliases(
  [{ sku: '07-01-04', catalogGroup: 'impression' }, { sku: '07-01-99', catalogGroup: 'impression' }],
  { keep: { '07-01-04': 'IM01' } },
);
check('group fill: kept IM01 preserved', gFill.find((r) => r.sku === '07-01-04')?.alias === 'IM01');
check('group fill: new item appends → IM02', gFill.find((r) => r.sku === '07-01-99')?.alias === 'IM02');
check('group: codes globally unique', new Set(gRes.map((r) => r.alias)).size === gRes.length);

console.log(fails === 0 ? '\nAll checks PASSED' : `\n${fails} check(s) FAILED`);
if (fails) process.exit(1);
