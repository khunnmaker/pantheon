import { z } from 'zod';
import type { Prisma } from '@prisma/client';

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
   *  of. Only ever true for an employee's non-self scope — a manager sees every project, and
   *  an employee's own self-scope is unrestricted (exactly the old forced-to-self behavior). */
  memberProjectOnly: boolean;
}

/**
 * Resolves the effective task/event scope for GET /api/apollo/calendar.
 * - manager: assignee param drives it directly, exactly as before — a specific agentId scopes
 *   to that person, 'none' scopes to unassigned-only, 'all'/omitted means everyone; never
 *   member-restricted (managers already see across every project).
 * - employee, self scope (param omitted, or equal to the viewer's own id): own assigned tasks
 *   in any non-archived project — the old forced-to-self behavior, unrestricted by project
 *   membership.
 * - employee, any other scope ('all' | 'none' | someone else's id): now HONORED — peers may
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

export interface EventInput { title: string; note?: string; date: string; endDate?: string | null; startTime?: string | null; endTime?: string | null; visibility?: 'private' | 'public' }
export interface EventData { title: string; note: string; date: Date; endDate: Date | null; startTime: string | null; endTime: string | null; visibility: 'private' | 'public' }

/**
 * Cross-field validation + parsing shared by POST /api/apollo/events and PATCH
 * /api/apollo/events/:id, so both route handlers stay thin wrappers that just 400 on null.
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
  return { title: input.title, note: input.note ?? '', date, endDate, startTime, endTime, visibility: input.visibility ?? 'private' };
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
 * `role === 'supervisor'`, never the manager() helper, which also covers 'md' — md/Nee must
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
