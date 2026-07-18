import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  CALENDAR_MAX_RANGE_DAYS, buildEventData, eventDateRangeWhere, eventOverlapsRange, eventTimeSchema,
  expandCalendarEvents, expandEventOccurrences, maskEvent, occursOn, parseCalendarRange, parseDate,
  recurringEventRangeWhere, resolveCalendarScope, ruleMatchesBaseDate, toDateKey, validEventDateRange,
  validEventTimeRange, type EventRecurrenceFields, type RawCalendarEvent,
} from '../src/apollo/calendarQuery.js';
import { nextOccurrenceDate } from '../src/apollo/recurrence.js';

describe('Apollo calendar date-range validation', () => {
  it('accepts a range up to and including the 62-day cap, rejects anything past it', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const atCap = new Date(from.getTime() + CALENDAR_MAX_RANGE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const overCap = new Date(from.getTime() + (CALENDAR_MAX_RANGE_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);

    expect(parseCalendarRange('2026-01-01', atCap)).toEqual({ from, to: new Date(`${atCap}T00:00:00.000Z`) });
    expect(parseCalendarRange('2026-01-01', overCap)).toBeNull();
    // A single calendar month (the frontend's actual usage) is always well inside the cap.
    expect(parseCalendarRange('2026-07-01', '2026-07-31')).not.toBeNull();
  });

  it('rejects malformed or non-calendar dates and an inverted range', () => {
    expect(parseCalendarRange('2026-02-30', '2026-03-01')).toBeNull(); // Feb 30 doesn't exist
    expect(parseCalendarRange('2026/07/01', '2026-07-31')).toBeNull(); // wrong separator
    expect(parseCalendarRange('2026-07-31', '2026-07-01')).toBeNull(); // to before from
  });
});

describe('Apollo calendar scope resolution (resolveCalendarScope)', () => {
  it('manager scope is unchanged: one agent, unassigned-only, or everyone — never member-restricted', () => {
    expect(resolveCalendarScope(true, 'mgr-1', 'agent-9')).toEqual({ assigneeId: 'agent-9', memberProjectOnly: false });
    expect(resolveCalendarScope(true, 'mgr-1', 'none')).toEqual({ assigneeId: null, memberProjectOnly: false });
    expect(resolveCalendarScope(true, 'mgr-1', 'all')).toEqual({ assigneeId: undefined, memberProjectOnly: false });
    expect(resolveCalendarScope(true, 'mgr-1', undefined)).toEqual({ assigneeId: undefined, memberProjectOnly: false });
  });

  it('employee self scope (omitted param or own id) stays unrestricted by project membership — the old forced-to-self behavior', () => {
    expect(resolveCalendarScope(false, 'self-1', undefined)).toEqual({ assigneeId: 'self-1', memberProjectOnly: false });
    expect(resolveCalendarScope(false, 'self-1', 'self-1')).toEqual({ assigneeId: 'self-1', memberProjectOnly: false });
  });

  it('employee peer/all/none scope is now HONORED but carries the member-project clause', () => {
    expect(resolveCalendarScope(false, 'self-1', 'agent-9')).toEqual({ assigneeId: 'agent-9', memberProjectOnly: true });
    expect(resolveCalendarScope(false, 'self-1', 'all')).toEqual({ assigneeId: undefined, memberProjectOnly: true });
    expect(resolveCalendarScope(false, 'self-1', 'none')).toEqual({ assigneeId: null, memberProjectOnly: true });
  });
});

describe('Apollo event masking (maskEvent): visibility matrix — own/CEO/public get full payload, else masked', () => {
  const agent = { id: 'owner-1', name: 'Owner One', email: 'owner@prominent.local', role: 'employee' };
  const privateRaw = {
    id: 'evt-1', agentId: 'owner-1', title: 'หมอฟัน', note: 'คลินิกบางนา', visibility: 'private',
    date: new Date('2026-07-20T00:00:00.000Z'), endDate: null,
    startTime: '09:00', endTime: '10:00', agent,
  };
  const publicRaw = { ...privateRaw, id: 'evt-2', title: 'ประชุมทีม', note: 'ห้องประชุมใหญ่', visibility: 'public' };

  it('keeps title/note/visibility when the viewer IS the owner, and marks own: true', () => {
    const masked = maskEvent(privateRaw, 'owner-1', false);
    expect(masked.own).toBe(true);
    expect(masked.title).toBe('หมอฟัน');
    expect(masked.note).toBe('คลินิกบางนา');
    expect(masked.visibility).toBe('private');
    expect(masked.assignee).toEqual(agent);
  });

  it('genuinely omits title/note/visibility (not just blanks them) for a non-owner, non-CEO viewer of a PRIVATE event', () => {
    const masked = maskEvent(privateRaw, 'someone-else', false);
    expect(masked.own).toBe(false);
    expect(masked).not.toHaveProperty('title');
    expect(masked).not.toHaveProperty('note');
    expect(masked).not.toHaveProperty('visibility');
    expect(Object.keys(masked).sort()).toEqual(['agentId', 'assignee', 'date', 'endDate', 'endTime', 'id', 'own', 'startTime'].sort());
    // free/busy fields (who + when) still come through — that's the point of the feature.
    expect(masked.assignee).toEqual(agent);
    expect(masked.startTime).toBe('09:00');
  });

  it('gives the CEO (viewerIsCeo: true) full title/note/visibility on someone else\'s PRIVATE event', () => {
    const masked = maskEvent(privateRaw, 'ceo-1', true);
    expect(masked.own).toBe(false);
    expect(masked.title).toBe('หมอฟัน');
    expect(masked.note).toBe('คลินิกบางนา');
    expect(masked.visibility).toBe('private');
  });

  it('never leaks private title/note to a non-CEO manager viewer (e.g. gm/Nee) — regression: manager() must not be used here', () => {
    // The route computes viewerIsCeo as EXACTLY role === 'supervisor', so a gm viewer always
    // calls in with false here, same as any other non-CEO employee — this is what would break
    // if maskEvent (or its caller) ever swapped in the manager() helper (which also covers 'gm').
    const masked = maskEvent(privateRaw, 'gm-1', false);
    expect(masked.own).toBe(false);
    expect(masked).not.toHaveProperty('title');
    expect(masked).not.toHaveProperty('note');
    expect(masked).not.toHaveProperty('visibility');
  });

  it('gives ANY viewer (not owner, not CEO) the full payload on a PUBLIC event', () => {
    const masked = maskEvent(publicRaw, 'someone-else', false);
    expect(masked.own).toBe(false);
    expect(masked.title).toBe('ประชุมทีม');
    expect(masked.note).toBe('ห้องประชุมใหญ่');
    expect(masked.visibility).toBe('public');
  });
});

describe('Apollo event date-overlap logic for multi-day events (eventOverlapsRange)', () => {
  const from = new Date('2026-07-01T00:00:00.000Z');
  const to = new Date('2026-07-31T00:00:00.000Z');

  it('single-day events at/inside/outside the range boundaries', () => {
    expect(eventOverlapsRange(new Date('2026-07-01T00:00:00.000Z'), null, from, to)).toBe(true); // exactly at from
    expect(eventOverlapsRange(new Date('2026-07-31T00:00:00.000Z'), null, from, to)).toBe(true); // exactly at to
    expect(eventOverlapsRange(new Date('2026-07-15T00:00:00.000Z'), null, from, to)).toBe(true); // inside
    expect(eventOverlapsRange(new Date('2026-06-30T00:00:00.000Z'), null, from, to)).toBe(false); // before
    expect(eventOverlapsRange(new Date('2026-08-01T00:00:00.000Z'), null, from, to)).toBe(false); // after
  });

  it('multi-day events straddling either boundary overlap', () => {
    // starts before the month, ends inside it
    expect(eventOverlapsRange(new Date('2026-06-28T00:00:00.000Z'), new Date('2026-07-03T00:00:00.000Z'), from, to)).toBe(true);
    // starts inside the month, ends after it
    expect(eventOverlapsRange(new Date('2026-07-29T00:00:00.000Z'), new Date('2026-08-02T00:00:00.000Z'), from, to)).toBe(true);
    // spans clean over the whole month on both sides
    expect(eventOverlapsRange(new Date('2026-06-01T00:00:00.000Z'), new Date('2026-08-31T00:00:00.000Z'), from, to)).toBe(true);
  });

  it('multi-day events entirely outside the range do not overlap', () => {
    expect(eventOverlapsRange(new Date('2026-06-01T00:00:00.000Z'), new Date('2026-06-20T00:00:00.000Z'), from, to)).toBe(false);
    expect(eventOverlapsRange(new Date('2026-08-05T00:00:00.000Z'), new Date('2026-08-20T00:00:00.000Z'), from, to)).toBe(false);
  });

  it('eventDateRangeWhere translates the same rule into a Prisma where-fragment', () => {
    expect(eventDateRangeWhere(from, to)).toEqual({
      date: { lte: to },
      OR: [
        { endDate: null, date: { gte: from } },
        { endDate: { gte: from } },
      ],
    });
  });
});

describe('Apollo event time validation (validEventTimeRange, eventTimeSchema)', () => {
  it('accepts a valid 24h "HH:MM" and rejects malformed strings', () => {
    expect(eventTimeSchema.safeParse('09:00').success).toBe(true);
    expect(eventTimeSchema.safeParse('23:59').success).toBe(true);
    expect(eventTimeSchema.safeParse('00:00').success).toBe(true);
    expect(eventTimeSchema.safeParse('24:00').success).toBe(false); // hour out of range
    expect(eventTimeSchema.safeParse('9:00').success).toBe(false); // not zero-padded
    expect(eventTimeSchema.safeParse('09:60').success).toBe(false); // minute out of range
    expect(eventTimeSchema.safeParse('').success).toBe(false);
  });

  it('endTime absent is always valid, regardless of startTime', () => {
    expect(validEventTimeRange(null, null)).toBe(true);
    expect(validEventTimeRange('09:00', null)).toBe(true);
  });

  it('endTime present requires startTime, and must be strictly later', () => {
    expect(validEventTimeRange(null, '10:00')).toBe(false); // endTime without startTime
    expect(validEventTimeRange('10:00', '09:00')).toBe(false); // endTime before startTime
    expect(validEventTimeRange('10:00', '10:00')).toBe(false); // equal — must be strictly later
    expect(validEventTimeRange('09:00', '10:00')).toBe(true);
  });
});

describe('Apollo event date-range validation (validEventDateRange)', () => {
  it('no endDate is always valid', () => {
    expect(validEventDateRange(new Date('2026-07-20T00:00:00.000Z'), null)).toBe(true);
  });

  it('endDate must be on/after date, within the 62-day cap', () => {
    const date = new Date('2026-07-20T00:00:00.000Z');
    expect(validEventDateRange(date, new Date('2026-07-19T00:00:00.000Z'))).toBe(false); // before date
    expect(validEventDateRange(date, date)).toBe(true); // same day
    const atCap = new Date(date.getTime() + CALENDAR_MAX_RANGE_DAYS * 86_400_000);
    const overCap = new Date(date.getTime() + (CALENDAR_MAX_RANGE_DAYS + 1) * 86_400_000);
    expect(validEventDateRange(date, atCap)).toBe(true);
    expect(validEventDateRange(date, overCap)).toBe(false);
  });
});

describe('Apollo buildEventData — shared POST/PATCH validation + parsing', () => {
  it('parses a minimal valid event, defaulting visibility to public', () => {
    const result = buildEventData({ title: 'นัดหมอ', date: '2026-07-20' });
    expect(result).toEqual({
      title: 'นัดหมอ', note: '', date: parseDate('2026-07-20'), endDate: null, startTime: null, endTime: null, visibility: 'public',
      recurrenceRule: null, recurrenceUntil: null,
    });
  });

  it('rejects an invalid calendar date', () => {
    expect(buildEventData({ title: 'x', date: '2026-02-30' })).toBeNull();
  });

  it('rejects endDate before date', () => {
    expect(buildEventData({ title: 'x', date: '2026-07-20', endDate: '2026-07-19' })).toBeNull();
  });

  it('rejects endTime without startTime', () => {
    expect(buildEventData({ title: 'x', date: '2026-07-20', endTime: '10:00' })).toBeNull();
  });

  it('accepts a full multi-day, timed event', () => {
    const result = buildEventData({ title: 'สัมมนา', note: 'ห้องประชุมใหญ่', date: '2026-07-20', endDate: '2026-07-22', startTime: '09:00', endTime: '17:00' });
    expect(result).toEqual({
      title: 'สัมมนา', note: 'ห้องประชุมใหญ่', date: parseDate('2026-07-20'), endDate: parseDate('2026-07-22'), startTime: '09:00', endTime: '17:00', visibility: 'public',
      recurrenceRule: null, recurrenceUntil: null,
    });
  });

  it('accepts an explicit visibility of "private" (overriding the public default)', () => {
    const result = buildEventData({ title: 'นัดหมอ', date: '2026-07-20', visibility: 'private' });
    expect(result?.visibility).toBe('private');
  });
});

// ─── Recurrence ──────────────────────────────────────────────────────────

// 2026-07-16 is a Thursday (UTC weekday 4) — the base for the weekly fixtures below.
const recur = (dateKey: string, rule: unknown, opts: { until?: string; skip?: string[] } = {}): EventRecurrenceFields => ({
  date: parseDate(dateKey) as Date,
  recurrenceRule: rule,
  recurrenceUntil: opts.until ? parseDate(opts.until) : null,
  skipDates: opts.skip ?? [],
});

describe('Apollo event recurrence rule validation (buildEventData + ruleMatchesBaseDate)', () => {
  it('weekly rule must anchor to the base date\'s weekday, monthly to its day-of-month', () => {
    const thursday = parseDate('2026-07-16') as Date;
    expect(ruleMatchesBaseDate({ freq: 'weekly', weekday: 4 }, thursday)).toBe(true);
    expect(ruleMatchesBaseDate({ freq: 'weekly', weekday: 5 }, thursday)).toBe(false);
    expect(ruleMatchesBaseDate({ freq: 'monthly', dayOfMonth: 16 }, thursday)).toBe(true);
    expect(ruleMatchesBaseDate({ freq: 'monthly', dayOfMonth: 17 }, thursday)).toBe(false);
    expect(ruleMatchesBaseDate({ freq: 'daily' }, thursday)).toBe(true); // daily has no anchor

    expect(buildEventData({ title: 'ติว', date: '2026-07-16', recurrenceRule: { freq: 'weekly', weekday: 4 } })?.recurrenceRule).toEqual({ freq: 'weekly', weekday: 4 });
    expect(buildEventData({ title: 'ติว', date: '2026-07-16', recurrenceRule: { freq: 'weekly', weekday: 5 } })).toBeNull();
    expect(buildEventData({ title: 'บิล', date: '2026-07-16', recurrenceRule: { freq: 'monthly', dayOfMonth: 16 } })?.recurrenceRule).toEqual({ freq: 'monthly', dayOfMonth: 16 });
    expect(buildEventData({ title: 'บิล', date: '2026-07-16', recurrenceRule: { freq: 'monthly', dayOfMonth: 15 } })).toBeNull();
  });

  it('rejects a rule combined with a multi-day endDate — expansion is one day per occurrence', () => {
    expect(buildEventData({ title: 'x', date: '2026-07-16', endDate: '2026-07-18', recurrenceRule: { freq: 'daily' } })).toBeNull();
    // multi-day WITHOUT a rule stays valid (unchanged behavior)
    expect(buildEventData({ title: 'x', date: '2026-07-16', endDate: '2026-07-18' })).not.toBeNull();
  });

  it('recurrenceUntil must be a real date on/after the base date; equal is allowed', () => {
    expect(buildEventData({ title: 'x', date: '2026-07-16', recurrenceRule: { freq: 'daily' }, recurrenceUntil: '2026-07-15' })).toBeNull();
    expect(buildEventData({ title: 'x', date: '2026-07-16', recurrenceRule: { freq: 'daily' }, recurrenceUntil: '2026-02-30' })).toBeNull();
    expect(buildEventData({ title: 'x', date: '2026-07-16', recurrenceRule: { freq: 'daily' }, recurrenceUntil: '2026-07-16' })?.recurrenceUntil).toEqual(parseDate('2026-07-16'));
  });

  it('drops recurrenceUntil when there is no rule, and rejects a malformed rule object', () => {
    expect(buildEventData({ title: 'x', date: '2026-07-16', recurrenceUntil: '2026-08-31' })?.recurrenceUntil).toBeNull();
    expect(buildEventData({ title: 'x', date: '2026-07-16', recurrenceRule: { freq: 'weekly' } as never })).toBeNull(); // weekly without weekday
  });
});

describe('Apollo event recurrence occursOn', () => {
  const weekly = recur('2026-07-16', { freq: 'weekly', weekday: 4 });

  it('base date IS the first occurrence; nothing before it occurs', () => {
    expect(occursOn(weekly, '2026-07-16')).toBe(true);
    expect(occursOn(weekly, '2026-07-09')).toBe(false); // right weekday, before base
    expect(occursOn(recur('2026-07-16', null), '2026-07-16')).toBe(true); // rule-less: base only
    expect(occursOn(recur('2026-07-16', null), '2026-07-17')).toBe(false);
  });

  it('weekly matches only the rule weekday; daily matches every day from base', () => {
    expect(occursOn(weekly, '2026-07-23')).toBe(true);
    expect(occursOn(weekly, '2026-07-24')).toBe(false); // Friday
    expect(occursOn(weekly, '2027-01-07')).toBe(true); // Thursday far in the future — no until, runs forever
    const daily = recur('2026-07-16', { freq: 'daily' });
    expect(occursOn(daily, '2026-07-17')).toBe(true);
    expect(occursOn(daily, '2026-12-31')).toBe(true);
  });

  it('recurrenceUntil is inclusive: occurs ON it, never after', () => {
    const bounded = recur('2026-07-16', { freq: 'weekly', weekday: 4 }, { until: '2026-07-30' });
    expect(occursOn(bounded, '2026-07-30')).toBe(true);
    expect(occursOn(bounded, '2026-08-06')).toBe(false);
  });

  it('skipDates puncture single occurrences; stale entries that are not occurrences are ignored harmlessly', () => {
    const skipped = recur('2026-07-16', { freq: 'weekly', weekday: 4 }, { skip: ['2026-07-23', '2026-07-24'] });
    expect(occursOn(skipped, '2026-07-23')).toBe(false); // skipped
    expect(occursOn(skipped, '2026-07-16')).toBe(true); // others unaffected
    expect(occursOn(skipped, '2026-07-30')).toBe(true);
    expect(occursOn(skipped, '2026-07-24')).toBe(false); // stale entry: was never an occurrence anyway
  });

  it('rejects a malformed date key outright', () => {
    expect(occursOn(weekly, '2026-02-30')).toBe(false);
    expect(occursOn(weekly, 'not-a-date')).toBe(false);
  });
});

describe('Apollo event recurrence: monthly month-end clamp — parity with the task engine', () => {
  const day31 = recur('2026-01-31', { freq: 'monthly', dayOfMonth: 31 });

  it('lands exactly where nextOccurrenceDate puts the task series (clamp to month length, never skip the month)', () => {
    // The task engine's decision for a day-31 rule leaving January: clamp to Feb 28.
    const taskNext = toDateKey(nextOccurrenceDate(parseDate('2026-01-31') as Date, { freq: 'monthly', dayOfMonth: 31 }));
    expect(taskNext).toBe('2026-02-28');
    expect(occursOn(day31, taskNext)).toBe(true); // events agree with tasks
    expect(occursOn(day31, '2026-02-27')).toBe(false);
    expect(occursOn(day31, '2026-03-31')).toBe(true); // back to the literal day where it exists
    expect(occursOn(day31, '2026-04-30')).toBe(true); // 30-day month clamps to 30
  });

  it('leap-year February clamps to the 29th, matching the task engine again', () => {
    const leap = recur('2028-01-31', { freq: 'monthly', dayOfMonth: 31 });
    const taskNext = toDateKey(nextOccurrenceDate(parseDate('2028-01-31') as Date, { freq: 'monthly', dayOfMonth: 31 }));
    expect(taskNext).toBe('2028-02-29');
    expect(occursOn(leap, '2028-02-29')).toBe(true);
    expect(occursOn(leap, '2028-02-28')).toBe(false);
  });
});

describe('Apollo event recurrence expansion (expandEventOccurrences)', () => {
  const from = parseDate('2026-07-01') as Date;
  const to = parseDate('2026-07-31') as Date;

  it('weekly: base + every matching weekday through the range end', () => {
    expect(expandEventOccurrences(recur('2026-07-16', { freq: 'weekly', weekday: 4 }), from, to))
      .toEqual(['2026-07-16', '2026-07-23', '2026-07-30']);
  });

  it('daily: every day from base, cut by until (inclusive) and skipDates', () => {
    expect(expandEventOccurrences(recur('2026-07-16', { freq: 'daily' }, { until: '2026-07-18' }), from, to))
      .toEqual(['2026-07-16', '2026-07-17', '2026-07-18']);
    expect(expandEventOccurrences(recur('2026-07-16', { freq: 'daily' }, { until: '2026-07-19', skip: ['2026-07-17'] }), from, to))
      .toEqual(['2026-07-16', '2026-07-18', '2026-07-19']);
  });

  it('a series based before the window starts expanding AT the window start, not the base', () => {
    const august = { from: parseDate('2026-08-01') as Date, to: parseDate('2026-08-31') as Date };
    expect(expandEventOccurrences(recur('2026-07-16', { freq: 'weekly', weekday: 4 }), august.from, august.to))
      .toEqual(['2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27']);
  });

  it('monthly day-31 across short months keeps the clamp inside expansion too', () => {
    expect(expandEventOccurrences(recur('2026-01-31', { freq: 'monthly', dayOfMonth: 31 }), parseDate('2026-02-01') as Date, parseDate('2026-04-30') as Date))
      .toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('empty when the series ends before the window or starts after it', () => {
    expect(expandEventOccurrences(recur('2026-07-16', { freq: 'daily' }, { until: '2026-07-20' }), parseDate('2026-08-01') as Date, parseDate('2026-08-31') as Date)).toEqual([]);
    expect(expandEventOccurrences(recur('2026-09-03', { freq: 'weekly', weekday: 4 }), from, to)).toEqual([]);
  });

  it('a rule-less event expands to just its base date when in range', () => {
    expect(expandEventOccurrences(recur('2026-07-16', null), from, to)).toEqual(['2026-07-16']);
  });
});

describe('Apollo recurring-candidate where-fragment (recurringEventRangeWhere)', () => {
  it('narrows to rows with a real rule, based on/before `to`, whose series has not ended before `from`', () => {
    const from = parseDate('2026-07-01') as Date;
    const to = parseDate('2026-07-31') as Date;
    expect(recurringEventRangeWhere(from, to)).toEqual({
      recurrenceRule: { not: Prisma.AnyNull },
      date: { lte: to },
      OR: [{ recurrenceUntil: null }, { recurrenceUntil: { gte: from } }],
    });
  });
});

describe('Apollo calendar expansion rows (expandCalendarEvents) — masking + THE REBASE TRAP', () => {
  const agent = { id: 'owner-1', name: 'Owner One', email: 'owner@prominent.local', role: 'employee' };
  const from = parseDate('2026-07-01') as Date;
  const to = parseDate('2026-07-31') as Date;
  const raw = (over: Partial<RawCalendarEvent> = {}): RawCalendarEvent => ({
    id: 'evt-r', agentId: 'owner-1', title: 'ติวเตอร์', note: 'ทุกพฤหัส', visibility: 'private',
    date: parseDate('2026-07-16') as Date, endDate: null, startTime: '07:00', endTime: '08:00', agent,
    recurrenceRule: { freq: 'weekly', weekday: 4 }, recurrenceUntil: null, skipDates: [], ...over,
  });

  it('REBASE TRAP: every expanded occurrence row carries seriesDate === the base date, with row date = the occurrence', () => {
    const rows = expandCalendarEvents([raw()], 'owner-1', false, from, to);
    expect(rows.map((r) => toDateKey(r.date))).toEqual(['2026-07-16', '2026-07-23', '2026-07-30']);
    for (const row of rows) {
      expect(row.seriesDate).toBe('2026-07-16'); // EventModal must seed its วันที่ from THIS, never row.date
      expect(row.recurrenceRule).toEqual({ freq: 'weekly', weekday: 4 });
      expect(row.recurrenceUntil).toBeNull();
      expect(row.title).toBe('ติวเตอร์');
      expect(row.own).toBe(true);
    }
  });

  it('recurrenceUntil rides along on own rows as a date key — EventModal PATCHes the whole form, so omitting it would silently clear the bound', () => {
    const rows = expandCalendarEvents([raw({ recurrenceUntil: parseDate('2026-07-23') })], 'owner-1', false, from, to);
    expect(rows.map((r) => toDateKey(r.date))).toEqual(['2026-07-16', '2026-07-23']);
    expect(rows[0].recurrenceUntil).toBe('2026-07-23');
  });

  it('masked viewer of a PRIVATE series gets one free/busy row per occurrence with rule/seriesDate/title/note/visibility all ABSENT', () => {
    const rows = expandCalendarEvents([raw()], 'someone-else', false, from, to);
    expect(rows).toHaveLength(3); // free/busy still shows every occurrence — that's the feature
    for (const row of rows) {
      expect(row.own).toBe(false);
      expect(row).not.toHaveProperty('title');
      expect(row).not.toHaveProperty('note');
      expect(row).not.toHaveProperty('visibility');
      expect(row).not.toHaveProperty('recurrenceRule');
      expect(row).not.toHaveProperty('seriesDate');
      expect(row).not.toHaveProperty('recurrenceUntil');
      expect(row.startTime).toBe('07:00'); // free/busy shape intact
    }
  });

  it('PUBLIC series rows carry rule + seriesDate for ANY viewer; CEO viewing private gets title but NO series fields (own/public only)', () => {
    const pub = expandCalendarEvents([raw({ visibility: 'public' })], 'someone-else', false, from, to);
    expect(pub[0].title).toBe('ติวเตอร์');
    expect(pub[0].seriesDate).toBe('2026-07-16');
    expect(pub[0].recurrenceRule).toEqual({ freq: 'weekly', weekday: 4 });
    const ceo = expandCalendarEvents([raw()], 'ceo-1', true, from, to);
    expect(ceo[0].title).toBe('ติวเตอร์'); // CEO view exception unchanged
    expect(ceo[0]).not.toHaveProperty('seriesDate');
    expect(ceo[0]).not.toHaveProperty('recurrenceRule');
  });

  it('skipDates drop their occurrence row; a non-recurring event passes through as its single masked row without series fields', () => {
    const rows = expandCalendarEvents([raw({ skipDates: ['2026-07-23'] })], 'owner-1', false, from, to);
    expect(rows.map((r) => toDateKey(r.date))).toEqual(['2026-07-16', '2026-07-30']);
    const plain = expandCalendarEvents([raw({ recurrenceRule: null })], 'owner-1', false, from, to);
    expect(plain).toHaveLength(1);
    expect(toDateKey(plain[0].date)).toBe('2026-07-16');
    expect(plain[0]).not.toHaveProperty('seriesDate');
    expect(plain[0]).not.toHaveProperty('recurrenceRule');
  });
});
