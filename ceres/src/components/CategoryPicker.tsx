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
// RequestSheet, ExpenseSheet, MdRequests's RequestForm, and MdTemplates's TemplateDialog so all
// four category pickers look and behave identically. NEVER pre-selects: `value` starts at ''
// (or whatever the caller defaults to) and stays there until the person taps a chip themselves
// — see docs/CERES_CATEGORIES_PLAN.md "NO lazy defaults". Chip classes copied VERBATIM from the
// pre-revamp RequestSheet.tsx category chips (owner rule: match siblings, never invent a new
// style direction).
//
// `value`/`onChange` are keyed by whatever the caller's own state tracks — RequestSheet/
// ExpenseSheet key on category id, MdRequests/MdTemplates key on the category NAME (their
// PaymentRequest/RecurringTemplate payloads store the name directly). `getKey` picks which.
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
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.group}>
          <div className="text-xs font-semibold text-slate-400 mb-1.5">{g.group}</div>
          <div className="flex flex-wrap gap-2">
            {g.items.map((c) => (
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
        </div>
      ))}
    </div>
  );
}
