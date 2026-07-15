import { describe, expect, it } from 'vitest';
import { APOLLO_URL, buildDigestLines, type DigestEvent, type DigestTask } from '../src/apollo/digest.js';

const TODAY = '2026-07-15';
const task = (id: string, title: string, dueKey: string, priority = 'normal'): DigestTask =>
  ({ id, title, dueDate: new Date(`${dueKey}T00:00:00.000Z`), priority });
const event = (title: string, startTime: string | null = null, endTime: string | null = null, visibility = 'public'): DigestEvent =>
  ({ title, startTime, endTime, visibility });
const taskIds = (lines: string[]) => lines.filter((l) => l.startsWith(`${APOLLO_URL}/t/`)).map((l) => l.slice(`${APOLLO_URL}/t/`.length));

describe('Apollo morning digest builder (buildDigestLines): header + task lines', () => {
  it('splits overdue vs today in the header and marks task lines ⚠️ (overdue) / • (due today)', () => {
    const lines = buildDigestLines('สมชาย', [
      task('t-today', 'ส่งใบเสนอราคา', TODAY),
      task('t-old', 'ตามของค้างส่ง', '2026-07-13'),
    ], [], TODAY, 2);
    expect(lines).toEqual([
      '☀️ Apollo · งานของ สมชาย',
      'วันนี้ 1 · เลยกำหนด 1', // no · นัดหมาย segment when there are no events
      '⚠️ ตามของค้างส่ง', `${APOLLO_URL}/t/t-old`, // overdue first (dueDate asc)
      '• ส่งใบเสนอราคา', `${APOLLO_URL}/t/t-today`,
    ]);
  });

  it('orders by dueDate first, then priority rank urgent<high<normal<low within a day — never alphabetically', () => {
    const lines = buildDigestLines('a', [
      task('t-low', 'งาน low', TODAY, 'low'),
      task('t-high', 'งาน high', TODAY, 'high'),
      task('t-normal', 'งาน normal', TODAY, 'normal'),
      task('t-urgent', 'งาน urgent', TODAY, 'urgent'),
      task('t-yesterday-low', 'งานเก่า low', '2026-07-14', 'low'),
    ], [], TODAY, 5)!;
    // Alphabetical string order would be high<low<normal<urgent — this asserts the rank map won.
    // The overdue low-priority task still leads: dueDate asc is the primary key.
    expect(taskIds(lines)).toEqual(['t-yesterday-low', 't-urgent', 't-high', 't-normal', 't-low']);
  });
});

describe('Apollo morning digest builder: event lines', () => {
  it('formats event lines — time range, start-only, no-time — with 🔒 prefix on private only, no-time first then by start', () => {
    const lines = buildDigestLines('a', [], [
      event('ประชุมทีม', '09:00', '10:30', 'public'),
      event('นัดหมอฟัน', '13:00', null, 'private'),
      event('ลาพักร้อน', null, null, 'public'),
    ], TODAY, 0);
    expect(lines).toEqual([
      '☀️ Apollo · งานของ a',
      'วันนี้ 0 · เลยกำหนด 0 · นัดหมาย 3',
      '📅 ลาพักร้อน',
      '📅 09:00–10:30 ประชุมทีม',
      '📅 13:00 🔒 นัดหมอฟัน',
    ]);
  });

  it('event-only digest still builds (send condition is tasks OR events)', () => {
    const lines = buildDigestLines('a', [], [event('นัดหมอ')], TODAY, 0);
    expect(lines).not.toBeNull();
    expect(lines![1]).toBe('วันนี้ 0 · เลยกำหนด 0 · นัดหมาย 1');
  });

  it('returns null when there are no tasks and no events — caller skips the LINE push', () => {
    expect(buildDigestLines('a', [], [], TODAY, 0)).toBeNull();
  });
});

describe('Apollo morning digest builder: display caps + "and N more" trailers', () => {
  it('"และอีก N งาน" uses the true open count, not the fetch window (undercount fix)', () => {
    // Simulates take-20 fetch with 25 truly open: 10 shown → trailer must say 15, not 20-10=10.
    const tasks = Array.from({ length: 20 }, (_, i) => task(`t${i}`, `งาน ${i}`, TODAY));
    const lines = buildDigestLines('a', tasks, [], TODAY, 25)!;
    expect(taskIds(lines)).toHaveLength(10); // display cap kept
    expect(lines).toContain('และอีก 15 งาน');
  });

  it('no task trailer when everything shown fits the cap exactly', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, `งาน ${i}`, TODAY));
    const lines = buildDigestLines('a', tasks, [], TODAY, 10)!;
    expect(taskIds(lines)).toHaveLength(10);
    expect(lines.some((l) => l.includes('และอีก'))).toBe(false);
  });

  it('shows at most 5 events with "และอีกนัดหมาย N รายการ" for the rest', () => {
    const events = Array.from({ length: 7 }, (_, i) => event(`นัด ${i}`, `0${i}:00`));
    const lines = buildDigestLines('a', [], events, TODAY, 0)!;
    expect(lines[1]).toBe('วันนี้ 0 · เลยกำหนด 0 · นัดหมาย 7'); // header counts all 7
    expect(lines.filter((l) => l.startsWith('📅')).length).toBe(5);
    expect(lines).toContain('และอีกนัดหมาย 2 รายการ');
  });
});
