// Design tokens for the Apollo board polish pass. Literal Tailwind class strings only — Tailwind's
// JIT scanner reads raw source text, so every class it must generate has to appear verbatim
// somewhere in a scanned file. These lookup tables ARE that literal text; call sites interpolate
// the resolved token value (never a raw color name) into className.
import { Flag, type LucideIcon } from 'lucide-react';
import { memberAvatar } from '@pantheon/ui';
import type { Person, Priority } from '../types';

export interface ColumnAccent { dot: string; chipBg: string; chipText: string; ring: string; border: string }

// 6 stable accents cycled by column index (blue, violet, amber, emerald, rose, slate).
export const COLUMN_ACCENTS: ColumnAccent[] = [
  { dot: 'bg-blue-500', chipBg: 'bg-blue-50', chipText: 'text-blue-700', ring: 'ring-blue-300', border: 'hover:border-blue-300' },
  { dot: 'bg-violet-500', chipBg: 'bg-violet-50', chipText: 'text-violet-700', ring: 'ring-violet-300', border: 'hover:border-violet-300' },
  { dot: 'bg-amber-500', chipBg: 'bg-amber-50', chipText: 'text-amber-700', ring: 'ring-amber-300', border: 'hover:border-amber-300' },
  { dot: 'bg-emerald-500', chipBg: 'bg-emerald-50', chipText: 'text-emerald-700', ring: 'ring-emerald-300', border: 'hover:border-emerald-300' },
  { dot: 'bg-rose-500', chipBg: 'bg-rose-50', chipText: 'text-rose-700', ring: 'ring-rose-300', border: 'hover:border-rose-300' },
  { dot: 'bg-slate-500', chipBg: 'bg-slate-50', chipText: 'text-slate-700', ring: 'ring-slate-300', border: 'hover:border-slate-300' },
];
// Modulo-safe (negative-safe) so a status that no longer matches a column index never crashes.
export const accentForColumn = (index: number): ColumnAccent => COLUMN_ACCENTS[((index % COLUMN_ACCENTS.length) + COLUMN_ACCENTS.length) % COLUMN_ACCENTS.length];

export interface PriorityMeta { icon: LucideIcon; chip: string; dot: string; ring: string; label: string }
export const PRIORITY_META: Record<Priority, PriorityMeta> = {
  urgent: { icon: Flag, chip: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500', ring: 'ring-rose-300', label: 'ด่วนที่สุด' },
  high: { icon: Flag, chip: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500', ring: 'ring-orange-300', label: 'สูง' },
  normal: { icon: Flag, chip: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500', ring: 'ring-blue-300', label: 'ปกติ' },
  low: { icon: Flag, chip: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400', ring: 'ring-slate-300', label: 'ต่ำ' },
};

// Due-date styling shared by TaskCard and the List view's Due cell — one rule for
// overdue (red) / due-today (amber) / future (plain) so the two never drift apart.
export function dueClass(dueDate: string): string {
  const day = dueDate.slice(0, 10); const now = new Date().toLocaleDateString('en-CA');
  return day < now ? 'font-semibold text-rose-600' : day === now ? 'font-medium text-amber-600' : '';
}
export function shortDate(dueDate: string): string {
  return new Date(`${dueDate.slice(0, 10)}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}

// Gender lookup by id against the agents list loaded from GET /api/apollo/agents (the only
// endpoint enriched with gender — see §0). Defaults to 'male' when the id isn't found there
// (e.g. a person object came from a payload outside that list).
export function genderOf(id: string | null | undefined, agents: Person[]): 'male' | 'female' {
  return agents.find((a) => a.id === id)?.gender ?? 'male';
}
export function agentAvatar(person: Pick<Person, 'id' | 'email'>, agents: Person[]): string {
  return memberAvatar(person.email, genderOf(person.id, agents));
}
