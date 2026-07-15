import { describe, expect, it } from 'vitest';
import {
  CALENDAR_MAX_RANGE_DAYS, buildEventData, eventDateRangeWhere, eventOverlapsRange, eventTimeSchema,
  maskEvent, parseCalendarRange, parseDate, resolveCalendarScope, validEventDateRange, validEventTimeRange,
} from '../src/apollo/calendarQuery.js';

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

  it('never leaks private title/note to a non-CEO manager viewer (e.g. md/Nee) — regression: manager() must not be used here', () => {
    // The route computes viewerIsCeo as EXACTLY role === 'supervisor', so an md viewer always
    // calls in with false here, same as any other non-CEO employee — this is what would break
    // if maskEvent (or its caller) ever swapped in the manager() helper (which also covers 'md').
    const masked = maskEvent(privateRaw, 'md-1', false);
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
  it('parses a minimal valid event, defaulting visibility to private', () => {
    const result = buildEventData({ title: 'นัดหมอ', date: '2026-07-20' });
    expect(result).toEqual({
      title: 'นัดหมอ', note: '', date: parseDate('2026-07-20'), endDate: null, startTime: null, endTime: null, visibility: 'private',
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
      title: 'สัมมนา', note: 'ห้องประชุมใหญ่', date: parseDate('2026-07-20'), endDate: parseDate('2026-07-22'), startTime: '09:00', endTime: '17:00', visibility: 'private',
    });
  });

  it('accepts an explicit visibility of "public"', () => {
    const result = buildEventData({ title: 'ประชุมทีม', date: '2026-07-20', visibility: 'public' });
    expect(result?.visibility).toBe('public');
  });
});
