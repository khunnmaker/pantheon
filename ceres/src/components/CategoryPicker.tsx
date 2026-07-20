import { useEffect, useState } from 'react';
import type { Category } from '../lib/api';

// Groups a `group`-bearing list into buckets in FIRST-APPEARANCE order. Callers pass
// categories already sorted by sortOrder (bootstrap.categories, admin list), so first
// appearance of a group name == ascending sortOrder of that group's first member —
// matches docs/CERES_CATEGORIES_PLAN.md's "group display order" rule. Exported so
// CategoryAdmin.tsx (the จัดการหมวดหมู่ admin screen) can reuse the same grouping logic
// instead of re-implementing it.
export function groupByCategoryGroup<T extends { group: string }>(items: T[]): { group: string; items: T[] }[] {
  const groups: { group: string; items: T[] }[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    let idx = index.get(item.group);
    if (idx === undefined) {
      idx = groups.length;
      index.set(item.group, idx);
      groups.push({ group: item.group, items: [] });
    }
    groups[idx].items.push(item);
  }
  return groups;
}

// Shared grouped category chip-picker (Ceres Phase B categories revamp, 2026-07-18) — used by
// RequestSheet, ExpenseSheet, and MdTemplates's TemplateDialog so all three category pickers
// look and behave identically. NEVER pre-selects: `value` starts at '' (or whatever the caller
// defaults to) and stays there until the person taps a chip themselves — see
// docs/CERES_CATEGORIES_PLAN.md "NO lazy defaults". Chip classes copied VERBATIM from the
// pre-revamp RequestSheet.tsx category chips (owner rule: match siblings, never invent a new
// style direction).
//
// Two-stage progressive disclosure (owner feedback 2026-07-18: "too visually noisy — show only
// group first; after click group the subgroup shows"): only group chips render up front, and
// tapping one reveals just that group's category chips below. NO group auto-expands for a blank
// picker — this app just killed every other lazy default, so a first-open picker stays fully
// collapsed until the person taps a group themselves. A pre-filled `value` (editing an item, a
// liquidation defaultCategory, applying a template in RequestSheet/MdTemplates) is the one
// exception: its group starts (or jumps to) expanded with the chip highlighted, so people don't
// have to hunt for what's already picked.
//
// `value`/`onChange` are keyed by whatever the caller's own state tracks — RequestSheet/
// ExpenseSheet key on category id, MdTemplates keys on the category NAME (its RecurringTemplate
// payload stores the name directly). `getKey` picks which.
export default function CategoryPicker({
  categories,
  value,
  onChange,
  getKey = (c) => c.id,
}: {
  categories: Category[];
  value: string;
  onChange: (value: string) => void;
  getKey?: (c: Category) => string;
}) {
  const groups = groupByCategoryGroup(categories);
  // Fails safe (rule: inactive/renamed category still referenced by `value`) — `selected` is
  // simply null, nothing highlights, and no group is forced open; the person just re-picks.
  const selected = categories.find((c) => getKey(c) === value) || null;

  const [expandedGroup, setExpandedGroup] = useState<string | null>(() => selected?.group ?? null);

  // Re-sync when `value` changes out from under us after mount — e.g. MdTemplates's "apply
  // template" or a prefill effect sets `value` while this component is already mounted.
  // `categories` is intentionally left out of the deps: callers rebuild that array every render
  // (see ExpenseSheet.tsx's `[...bootstrap.categories].filter(...).sort(...)`), so depending on
  // it would re-run this on every keystroke elsewhere on the sheet.
  useEffect(() => {
    if (selected) setExpandedGroup(selected.group);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const visibleGroup = groups.find((g) => g.group === expandedGroup) || null;
  // Selected chip is scrolled out of view (different/collapsed group) — surface it as text.
  const showSelectedHint = !!selected && selected.group !== expandedGroup;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <button
            key={g.group}
            type="button"
            onClick={() => setExpandedGroup((cur) => (cur === g.group ? null : g.group))}
            className={`px-3 py-2 rounded-full text-sm font-semibold border min-h-[40px] ${
              expandedGroup === g.group ? 'bg-amber-100 border-amber-300 text-amber-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {g.group}
          </button>
        ))}
      </div>
      {visibleGroup && (
        <div className="flex flex-wrap gap-2">
          {visibleGroup.items.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(getKey(c))}
              className={`px-3 py-2 rounded-full text-sm font-medium border min-h-[40px] ${
                getKey(c) === value ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {showSelectedHint && <div className="text-xs text-slate-400">เลือกไว้: {selected!.name}</div>}
    </div>
  );
}
