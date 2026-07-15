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

// Short Thai weekday labels, Sunday-first — shared by the grid header and QuickCreate's
// human-readable date summaries so the abbreviation never drifts between the two call sites.
export const WEEKDAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

// Calendar month math — manual y/m/d string building (never toISOString) so the grid and its
// API range never drift a day off the browser's local timezone offset.
export function pad2(n: number): string { return String(n).padStart(2, '0'); }
export function dateKey(year: number, month: number, day: number): string { return `${year}-${pad2(month + 1)}-${pad2(day)}`; }
export function daysInMonth(year: number, month: number): number { return new Date(year, month + 1, 0).getDate(); }

export interface CalendarCell { year: number; month: number; day: number; inMonth: boolean }
// Full Sunday-first 7-column grid for a month, including the leading/trailing days that pad
// the first and last week out from the neighboring months.
export function monthGrid(year: number, month: number): CalendarCell[] {
  const startWeekday = new Date(year, month, 1).getDay();
  const total = Math.ceil((startWeekday + daysInMonth(year, month)) / 7) * 7;
  return Array.from({ length: total }, (_, i) => {
    const d = new Date(year, month, 1 - startWeekday + i);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), inMonth: d.getMonth() === month && d.getFullYear() === year };
  });
}

// Expands a (possibly multi-day) private event's [date, endDate] into every YYYY-MM-DD key it
// should render a chip on. Unlike the grid math above, this walks in pinned-UTC epoch ms (both
// endpoints parsed with an explicit "Z") rather than local-time Date construction — since it
// never mixes the two, it's safe from the toISOString local-offset drift the grid math avoids
// by NOT using toISOString; here every step is UTC in and UTC out. date/endDate come straight
// off the API's @db.Date ISO strings. Capped defensively at the server's own multi-day span
// limit so a bad row can never spin the loop.
const MAX_EVENT_SPAN_DAYS = 62;
export function eventDayKeys(date: string, endDate: string | null): string[] {
  const startKey = date.slice(0, 10);
  const endKey = (endDate ?? date).slice(0, 10);
  const keys: string[] = [];
  let t = new Date(`${startKey}T00:00:00.000Z`).getTime();
  const endT = new Date(`${endKey}T00:00:00.000Z`).getTime();
  for (let i = 0; t <= endT && i <= MAX_EVENT_SPAN_DAYS; i += 1, t += 86_400_000) {
    keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

// Google-Calendar-style anchored popover placement: prefer flush below-right of the clicked
// anchor, flip above when it would overflow the bottom edge and flip left-aligned (right edges
// aligned) when it would overflow the right edge, then clamp into an 8px viewport margin either
// way. Pure + deterministic (no DOM reads) so QuickCreate can call it on mount, scroll, and
// resize alike without this file ever touching the DOM itself.
export function quickCreatePosition(anchor: DOMRect, size: { w: number; h: number }, viewport: { w: number; h: number }): { top: number; left: number } {
  const MARGIN = 8;
  const GAP = 4;
  let top = anchor.bottom + GAP;
  if (top + size.h > viewport.h - MARGIN) top = anchor.top - size.h - GAP;
  let left = anchor.left;
  if (left + size.w > viewport.w - MARGIN) left = anchor.right - size.w;
  const maxTop = Math.max(MARGIN, viewport.h - size.h - MARGIN);
  const maxLeft = Math.max(MARGIN, viewport.w - size.w - MARGIN);
  return { top: Math.min(Math.max(top, MARGIN), maxTop), left: Math.min(Math.max(left, MARGIN), maxLeft) };
}
