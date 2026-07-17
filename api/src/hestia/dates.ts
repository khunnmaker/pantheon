const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function parseDateOnly(value: string): Date | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function bangkokDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function bangkokDate(now = new Date()): Date {
  return parseDateOnly(bangkokDateKey(now))!;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

export function dateRange(fromValue: string, toValue: string, maxInclusiveDays = 366): { from: Date; to: Date } | null {
  const from = parseDateOnly(fromValue);
  const to = parseDateOnly(toValue);
  if (!from || !to) return null;
  const difference = daysBetween(from, to);
  if (difference < 0 || difference >= maxInclusiveDays) return null;
  return { from, to };
}
