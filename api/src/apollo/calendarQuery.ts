import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { parseRecurrenceRule, type ApolloRecurrenceRule } from './recurrence.js';

// Pure logic for GET /api/apollo/calendar (+ the private-events endpoints it now also feeds) —
// date-range validation, per-role scoping, and event validation/masking, split out from the
// route handlers so all of it is unit-testable without a Fastify harness (this codebase has
// none; mirrors the recurrence.ts split for the same reason).

// YYYY-MM-DD format guard — the same shape apollo.ts's task bodies validate dueDate with.
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Wall-clock "HH:MM", 24h. Used by ApolloEvent's startTime/endTime.
export const eventTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Parses a YYYY-MM-DD string to a UTC-midnight Date, rejecting non-calendar dates (e.g. Feb 30). */
export function parseDate(value: string): Date | null {
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** YYYY-MM-DD key of a Date read in UTC — the mirror of parseDate. @db.Date columns come back as
 *  UTC-midnight Dates, so reading them in UTC (never toISOString, never local getters) is what
 *  keeps occurrence keys from drifting a day off the stored calendar date. */
export function toDateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export const CALENDAR_MAX_RANGE_DAYS = 62;

export interface CalendarRange { from: Date; to: Date }

/**
 * Validates + parses the calendar endpoint's from/to pair: both must be real calendar dates,
 * from must not be after to, and the span must not exceed CALENDAR_MAX_RANGE_DAYS. Returns
 * null on any failure so the route can respond 400 without inspecting the reason.
 */
export function parseCalendarRange(from: string, to: string): CalendarRange | null {
  const fromDate = parseDate(from);
  const toDate = parseDate(to);
  if (!fromDate || !toDate || fromDate > toDate) return null;
  const spanDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
  return spanDays > CALENDAR_MAX_RANGE_DAYS ? null : { from: fromDate, to: toDate };
}

export interface CalendarScope {
  /** undefined = no assignee/owner filter (everyone in scope), null = unassigned-only
   *  (tasks) / no-one (events — see resolveCalendarScope's doc), string = one agent id. */
  assigneeId?: string | null;
  /** true when the tasks where-clause must ALSO restrict to projects the viewer is a member
   *  of. Only ever true for a staff member's non-self scope — a manager sees every project, and
   *  a staff member's own self-scope is unrestricted (exactly the old forced-to-self behavior). */
  memberProjectOnly: boolean;
}

/**
 * Resolves the effective task/event scope for GET /api/apollo/calendar.
 * - manager: assignee param drives it directly, exactly as before — a specific agentId scopes
 *   to that person, 'none' scopes to unassigned-only, 'all'/omitted means everyone; never
 *   member-restricted (managers already see across every project).
 * - staff, self scope (param omitted, or equal to the viewer's own id): own assigned tasks
 *   in any non-archived project — the old forced-to-self behavior, unrestricted by project
 *   membership.
 * - staff, any other scope ('all' | 'none' | someone else's id): now HONORED — peers may
 *   check each other's availability — but member-restricted, so tasks only ever surface within
 *   projects the viewer is already a member of (no new task info leaks beyond what the board
 *   already shows them). Events carry no such restriction (see the GET /calendar route): the
 *   free/busy check is deliberately open team-wide, since only the masked "ไม่ว่าง" block —
 *   never title/note — is ever visible to a non-owner.
 */
export function resolveCalendarScope(isManager: boolean, selfId: string, assignee: string | undefined): CalendarScope {
  if (isManager) {
    if (!assignee || assignee === 'all') return { assigneeId: undefined, memberProjectOnly: false };
    if (assignee === 'none') return { assigneeId: null, memberProjectOnly: false };
    return { assigneeId: assignee, memberProjectOnly: false };
  }
  if (!assignee || assignee === selfId) return { assigneeId: selfId, memberProjectOnly: false };
  if (assignee === 'all') return { assigneeId: undefined, memberProjectOnly: true };
  if (assignee === 'none') return { assigneeId: null, memberProjectOnly: true };
  return { assigneeId: assignee, memberProjectOnly: true };
}

// ─── ApolloEvent: validation ─────────────────────────────────────────────

/**
 * endDate (if present) must land on/after `date`, and the span is capped at the same
 * CALENDAR_MAX_RANGE_DAYS the calendar range query itself uses.
 */
export function validEventDateRange(date: Date, endDate: Date | null): boolean {
  if (!endDate) return true;
  if (endDate < date) return false;
  const spanDays = (endDate.getTime() - date.getTime()) / 86_400_000;
  return spanDays <= CALENDAR_MAX_RANGE_DAYS;
}

/**
 * endTime (if present) requires startTime, and must be strictly later. A plain string compare
 * is correct because both are validated "HH:MM" (zero-padded, 24h) — lexicographic order
 * matches chronological order.
 */
export function validEventTimeRange(startTime: string | null, endTime: string | null): boolean {
  if (!endTime) return true;
  if (!startTime) return false;
  return endTime > startTime;
}

export interface EventInput { title: string; note?: string; date: string; endDate?: string | null; startTime?: string | null; endTime?: string | null; visibility?: 'private' | 'public'; recurrenceRule?: ApolloRecurrenceRule | null; recurrenceUntil?: string | null }
export interface EventData { title: string; note: string; date: Date; endDate: Date | null; startTime: string | null; endTime: string | null; visibility: 'private' | 'public'; recurrenceRule: ApolloRecurrenceRule | null; recurrenceUntil: Date | null }

/**
 * A recurrence rule is valid for a base date only when its periodic anchor equals that date's own
 * — weekly's weekday === the base weekday, monthly's dayOfMonth === the base day-of-month (the UI
 * derives the rule FROM the picked date Google-style, so a mismatch is a client bug, not a user
 * choice). Daily has no anchor. Read in UTC to match the @db.Date base date.
 */
export function ruleMatchesBaseDate(rule: ApolloRecurrenceRule, date: Date): boolean {
  if (rule.freq === 'weekly') return rule.weekday === date.getUTCDay();
  if (rule.freq === 'monthly') return rule.dayOfMonth === date.getUTCDate();
  return true; // daily
}

/**
 * Cross-field validation + parsing shared by POST /api/apollo/events and PATCH
 * /api/apollo/events/:id, so both route handlers stay thin wrappers that just 400 on null.
 * Recurrence rules: rejected if malformed, if their weekday/dayOfMonth doesn't match the base
 * date, or if combined with a multi-day endDate (a rule expands one day per occurrence, so the two
 * are mutually exclusive). recurrenceUntil must be on/after the base date; it is dropped when
 * there is no rule (harmless — nothing to bound). skipDates is deliberately absent here: it is
 * managed only by the skip route, so a whole-series PATCH can never clobber it.
 */
export function buildEventData(input: EventInput): EventData | null {
  const date = parseDate(input.date);
  if (!date) return null;
  const endDate = input.endDate ? parseDate(input.endDate) : null;
  if (input.endDate && !endDate) return null;
  if (!validEventDateRange(date, endDate)) return null;
  const startTime = input.startTime ?? null;
  const endTime = input.endTime ?? null;
  if (!validEventTimeRange(startTime, endTime)) return null;
  const rule = input.recurrenceRule == null ? null : parseRecurrenceRule(input.recurrenceRule);
  if (input.recurrenceRule != null && !rule) return null; // provided but malformed
  if (rule) {
    if (endDate) return null; // rule + multi-day span cannot combine
    if (!ruleMatchesBaseDate(rule, date)) return null;
  }
  const recurrenceUntil = rule && input.recurrenceUntil ? parseDate(input.recurrenceUntil) : null;
  if (rule && input.recurrenceUntil && !recurrenceUntil) return null; // provided but malformed
  if (recurrenceUntil && recurrenceUntil < date) return null; // until must be on/after the base date
  return { title: input.title, note: input.note ?? '', date, endDate, startTime, endTime, visibility: input.visibility ?? 'public', recurrenceRule: rule, recurrenceUntil };
}

// ─── ApolloEvent: calendar-range query + masking ─────────────────────────

/**
 * Whether an event spanning [date, endDate] (endDate null = single day) overlaps the closed
 * range [from, to] — i.e. event.date <= to AND coalesce(endDate, date) >= from. Pure predicate
 * documenting the intended semantics; eventDateRangeWhere below implements the same rule as a
 * Prisma where-fragment (coalesce isn't directly expressible as a Prisma filter, hence the
 * OR-based translation there).
 */
export function eventOverlapsRange(date: Date, endDate: Date | null, from: Date, to: Date): boolean {
  const effectiveEnd = endDate ?? date;
  return date <= to && effectiveEnd >= from;
}

/** Prisma where-fragment for the overlap rule above. */
export function eventDateRangeWhere(from: Date, to: Date): Prisma.ApolloEventWhereInput {
  return {
    date: { lte: to },
    OR: [
      { endDate: null, date: { gte: from } },
      { endDate: { gte: from } },
    ],
  };
}

export interface ApolloEventRow {
  id: string; agentId: string; title: string; note: string; visibility: string;
  date: Date; endDate: Date | null; startTime: string | null; endTime: string | null;
  agent: { id: string; name: string; email: string; role: string };
}
export interface MaskedApolloEvent {
  id: string; agentId: string; date: Date; endDate: Date | null;
  startTime: string | null; endTime: string | null; own: boolean;
  assignee: { id: string; name: string; email: string; role: string };
  title?: string; note?: string; visibility?: 'private' | 'public';
}

/**
 * Server-side privacy mask for GET /api/apollo/calendar's events. Full payload (title/note/
 * visibility) goes to: the owner; the CEO (viewerIsCeo — the caller must derive this as EXACTLY
 * `role === 'supervisor'`, never the manager() helper, which also covers 'gm' — GM users must
 * never see private details); or anyone at all when the event itself is visibility 'public'.
 * Every other viewer gets only the free/busy shape, with title/note/visibility genuinely ABSENT
 * from the object (not just blanked), so a masked payload can never leak them even if a caller
 * forgets to check `own`/`visibility` before reading further.
 */
export function maskEvent(event: ApolloEventRow, viewerId: string, viewerIsCeo: boolean): MaskedApolloEvent {
  const own = event.agentId === viewerId;
  const { agent, title, note, visibility, ...rest } = event;
  const full = own || viewerIsCeo || visibility === 'public';
  return { ...rest, own, assignee: agent, ...(full ? { title, note, visibility: visibility as 'private' | 'public' } : {}) };
}

// ─── ApolloEvent: recurrence expansion ───────────────────────────────────
// Events with a rule are stored as ONE row (rule + until + skipDates) and expanded here at read
// time — never materialized as separate rows. All date math is UTC-key based (parseDate/toDateKey,
// never toISOString on a local Date) so occurrence keys never drift off the stored @db.Date.

/** The recurrence-bearing fields occursOn/expand need — satisfied by both a raw ApolloEvent row
 *  and the digest's leaner projection. `recurrenceRule` is the raw Json column (parsed here). */
export interface EventRecurrenceFields {
  date: Date;
  recurrenceRule: unknown;
  recurrenceUntil: Date | null;
  skipDates: string[];
}

/**
 * Whether `event` has an occurrence on the given YYYY-MM-DD key. The base `date` is always the
 * first occurrence. A rule-less event occurs only on its base date. Weekly matches the rule's
 * weekday; monthly matches its dayOfMonth clamped to the month's length — IDENTICAL to
 * recurrence.ts's nextOccurrenceDate (Math.min(dayOfMonth, lastDay)), so e.g. a day-31 rule lands
 * on Feb 28/29 rather than skipping February (parity is asserted in the tests). Bounded above by
 * recurrenceUntil (inclusive) and punctured by skipDates.
 */
export function occursOn(event: EventRecurrenceFields, dateKey: string): boolean {
  const target = parseDate(dateKey);
  if (!target) return false;
  const baseKey = toDateKey(event.date);
  if (dateKey < baseKey) return false; // before the series starts (lexical compare — keys are zero-padded)
  if (event.recurrenceUntil && dateKey > toDateKey(event.recurrenceUntil)) return false;
  if (event.skipDates.includes(dateKey)) return false;
  const rule = parseRecurrenceRule(event.recurrenceRule);
  if (!rule) return dateKey === baseKey; // non-recurring: base date only
  if (rule.freq === 'daily') return true;
  if (rule.freq === 'weekly') return target.getUTCDay() === rule.weekday;
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return target.getUTCDate() === Math.min(rule.dayOfMonth ?? 0, lastDay);
}

/**
 * Every occurrence key of `event` within the closed [from, to] window, ascending. Iterates day by
 * day (the calendar range is capped at CALENDAR_MAX_RANGE_DAYS, and a rule forbids a multi-day
 * span, so this is at most ~62 cheap occursOn checks) — so expansion can never disagree with
 * occursOn by construction. Clamped to the later of base/from and the earlier of to/until.
 */
export function expandEventOccurrences(event: EventRecurrenceFields, from: Date, to: Date): string[] {
  const baseKey = toDateKey(event.date);
  const fromKey = toDateKey(from);
  let startKey = baseKey > fromKey ? baseKey : fromKey;
  let endKey = toDateKey(to);
  if (event.recurrenceUntil) { const untilKey = toDateKey(event.recurrenceUntil); if (untilKey < endKey) endKey = untilKey; }
  const keys: string[] = [];
  const start = parseDate(startKey);
  const end = parseDate(endKey);
  if (!start || !end) return keys;
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const key = toDateKey(new Date(t));
    if (occursOn(event, key)) keys.push(key);
  }
  return keys;
}

/**
 * Prisma where-fragment for recurring-series candidates active anywhere in [from, to]: a real rule
 * (JSON non-null), base date on/before `to`, and the series not already ended before `from`
 * (recurrenceUntil null = forever). This only narrows the DB fetch; exact per-day membership is
 * still occursOn/expandEventOccurrences' job. OR this alongside eventDateRangeWhere (which catches
 * the base-day and every non-recurring/multi-day row) to get the full candidate set.
 */
export function recurringEventRangeWhere(from: Date, to: Date): Prisma.ApolloEventWhereInput {
  return {
    recurrenceRule: { not: Prisma.AnyNull },
    date: { lte: to },
    OR: [{ recurrenceUntil: null }, { recurrenceUntil: { gte: from } }],
  };
}

/** A calendar row: a masked event plus, for a recurring OWN/PUBLIC row only, the rule, the series
 *  base date, and the until bound. seriesDate is what EventModal must seed its date field from
 *  (never the occurrence `date`) — see THE REBASE TRAP in the build brief. recurrenceUntil rides
 *  along for the same reason: the modal PATCHes the whole form, so without the current bound a
 *  series edit would silently clear it. */
export type CalendarEventRow = MaskedApolloEvent & { recurrenceRule?: ApolloRecurrenceRule | null; seriesDate?: string; recurrenceUntil?: string | null };
/** Raw ApolloEvent row (calendarEventSelect) carrying the recurrence columns for expansion. */
export type RawCalendarEvent = ApolloEventRow & EventRecurrenceFields;

/**
 * Masks each raw event, then expands recurring ones into one row per occurrence in [from, to] (row
 * `date` = the occurrence, so the existing per-day grouping just works). A recurring row also
 * carries `recurrenceRule` + `seriesDate` ONLY when it's the viewer's own event or a public one —
 * masked free/busy rows stay stripped to who+when, so a rule/base-date can never leak. Non-recurring
 * events pass through as their single masked row unchanged (multi-day spans still expand client-side).
 */
export function expandCalendarEvents(rawEvents: RawCalendarEvent[], viewerId: string, viewerIsCeo: boolean, from: Date, to: Date): CalendarEventRow[] {
  return rawEvents.flatMap((raw): CalendarEventRow[] => {
    const { recurrenceRule, recurrenceUntil, skipDates, ...forMask } = raw;
    const masked = maskEvent(forMask, viewerId, viewerIsCeo);
    const rule = parseRecurrenceRule(recurrenceRule);
    if (!rule) return [masked];
    const withSeries = masked.own || masked.visibility === 'public'; // own/public rows only
    const recur: EventRecurrenceFields = { date: raw.date, recurrenceRule, recurrenceUntil, skipDates };
    return expandEventOccurrences(recur, from, to).map((key): CalendarEventRow => ({
      ...masked,
      date: parseDate(key) as Date,
      ...(withSeries ? { recurrenceRule: rule, seriesDate: toDateKey(raw.date), recurrenceUntil: recurrenceUntil ? toDateKey(recurrenceUntil) : null } : {}),
    }));
  });
}
