// Bangkok-local date helpers for Olympus/Hestia. The API's write routes are UTC-midnight
// `@db.Date` values keyed by a strict YYYY-MM-DD string (see api/src/hestia/dates.ts), but the
// "today" a supervisor means is Asia/Bangkok wall-clock time, which can differ from the browser's
// own local date near midnight. Every "today" derivation in the UI goes through bangkokTodayKey
// so the client and server always agree on which calendar day is current.
export function bangkokTodayKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function pad2(n: number): string { return String(n).padStart(2, '0'); }
export function dateKey(year: number, month: number, day: number): string { return `${year}-${pad2(month + 1)}-${pad2(day)}`; }
export function daysInMonth(year: number, month: number): number { return new Date(year, month + 1, 0).getDate(); }

// Adds `delta` days to a YYYY-MM-DD key, walking in pinned-UTC epoch ms (never local Date
// construction) so this never drifts a day off the browser's offset — mirrors
// apollo/src/lib/ui.ts's eventDayKeys rationale.
export function addDaysToKey(key: string, delta: number): string {
  const t = new Date(`${key}T00:00:00.000Z`).getTime() + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export const WEEKDAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

export interface CalendarCell { year: number; month: number; day: number; inMonth: boolean }
// Full Sunday-first 7-column grid for a month, including the leading/trailing days that pad the
// first/last week out from the neighboring months. Copied from apollo/src/lib/ui.ts monthGrid.
export function monthGrid(year: number, month: number): CalendarCell[] {
  const startWeekday = new Date(year, month, 1).getDay();
  const total = Math.ceil((startWeekday + daysInMonth(year, month)) / 7) * 7;
  return Array.from({ length: total }, (_, i) => {
    const d = new Date(year, month, 1 - startWeekday + i);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), inMonth: d.getMonth() === month && d.getFullYear() === year };
  });
}

export function shortThaiDate(key: string): string {
  return new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}
export function longThaiDate(key: string): string {
  return new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
}
export function monthTitleThai(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
}
