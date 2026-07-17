import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

// Generic "More" grid — Phase 4 of the Ceres revamp replaces the nine-tab horizontal
// scroller with three role-specific front doors (StaffHome/NeeHome/CeoHome) plus a
// grouped catch-all for every existing secondary tool. This component is deliberately
// dumb: callers (StaffHome.tsx, Md.tsx) decide which items exist per role and what each
// one does — see docs/CERES_REVAMP_PLAN.md "Phase 4" item 4.

export interface MoreMenuItem {
  key: string;
  label: string;
  sub?: string;
  icon: ReactNode;
  onClick: () => void;
  badge?: number;
}

export interface MoreMenuGroup {
  title?: string;
  items: MoreMenuItem[];
}

export default function MoreMenu({ groups }: { groups: MoreMenuGroup[] }) {
  return (
    <div className="space-y-5">
      {groups.map((group, gi) => (
        <section key={group.title ?? gi}>
          {group.title && <h3 className="text-sm font-semibold text-slate-500 mb-2">{group.title}</h3>}
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {group.items.map((item) => (
              <button
                key={item.key}
                onClick={item.onClick}
                className="w-full flex items-center gap-3 px-4 py-3.5 min-h-[56px] text-left hover:bg-slate-50"
              >
                <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
                  {item.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-slate-800">{item.label}</div>
                  {item.sub && <div className="text-xs text-slate-400 truncate">{item.sub}</div>}
                </div>
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-rose-100 text-rose-700 text-[11px] font-bold flex items-center justify-center">
                    {item.badge}
                  </span>
                )}
                <ChevronRight size={17} className="text-slate-300 shrink-0" />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
