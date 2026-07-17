import { describe, expect, it } from 'vitest';
import { bangkokDateKey, parseDateOnly } from '../src/hestia/dates.js';
import { calculateStreak, isHabitScheduled, type StreakHabit } from '../src/hestia/streaks.js';

const d = (value: string) => parseDateOnly(value)!;
const habit = (overrides: Partial<StreakHabit> = {}): StreakHabit => ({
  cadence: 'daily', scheduleDays: [0, 1, 2, 3, 4, 5, 6], targetCount: 1,
  startDate: d('2026-07-01'), endDate: null, ...overrides,
});
const checks = (...values: Array<string | [string, number]>) => values.map((value) => ({
  checkDate: d(typeof value === 'string' ? value : value[0]), count: typeof value === 'string' ? 1 : value[1],
}));

describe('Hestia streak engine', () => {
  it('counts daily completion runs and preserves the historical longest run', () => {
    const result = calculateStreak(habit(), checks('2026-07-01', '2026-07-02', '2026-07-03', '2026-07-05'), d('2026-07-06'));
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(3);
    expect(result.lastCompletedOn).toEqual(d('2026-07-05'));
  });

  it('ignores weekends for weekday habits', () => {
    const h = habit({ cadence: 'weekdays', startDate: d('2026-07-03') });
    expect(isHabitScheduled(h, d('2026-07-04'))).toBe(false);
    expect(calculateStreak(h, checks('2026-07-03', '2026-07-06'), d('2026-07-06')).currentStreak).toBe(2);
  });

  it('uses explicit Sunday-zero schedule days for custom habits', () => {
    const h = habit({ cadence: 'custom', scheduleDays: [0, 2, 4] });
    expect(isHabitScheduled(h, d('2026-07-05'))).toBe(true);
    expect(isHabitScheduled(h, d('2026-07-06'))).toBe(false);
    expect(calculateStreak(h, checks('2026-07-02', '2026-07-05', '2026-07-07'), d('2026-07-07')).currentStreak).toBe(3);
  });

  it('does not break the current streak for an unchecked scheduled current day', () => {
    const result = calculateStreak(habit(), checks('2026-07-01', '2026-07-02'), d('2026-07-03'));
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(2);
  });

  it('requires count to reach targetCount', () => {
    const result = calculateStreak(habit({ targetCount: 2 }), checks(['2026-07-01', 1], ['2026-07-02', 2]), d('2026-07-03'));
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });

  it('ignores check-ins outside start/end bounds', () => {
    const h = habit({ startDate: d('2026-07-02'), endDate: d('2026-07-03') });
    const result = calculateStreak(h, checks('2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'), d('2026-07-06'));
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(2);
    expect(result.lastCompletedOn).toEqual(d('2026-07-03'));
  });

  it('recomputes correctly after undo and historical backfill', () => {
    const h = habit();
    expect(calculateStreak(h, checks('2026-07-01', '2026-07-02', '2026-07-03'), d('2026-07-04')).currentStreak).toBe(3);
    expect(calculateStreak(h, checks('2026-07-01', '2026-07-03'), d('2026-07-04')).currentStreak).toBe(1);
    expect(calculateStreak(h, checks('2026-07-01', '2026-07-02', '2026-07-03'), d('2026-07-04')).longestStreak).toBe(3);
  });

  it('handles leap day as an ordinary scheduled day', () => {
    const h = habit({ startDate: d('2028-02-28') });
    const result = calculateStreak(h, checks('2028-02-28', '2028-02-29', '2028-03-01'), d('2028-03-02'));
    expect(result.currentStreak).toBe(3);
  });

  it('uses the Bangkok calendar boundary, not UTC midnight', () => {
    expect(bangkokDateKey(new Date('2026-07-16T16:59:59.999Z'))).toBe('2026-07-16');
    expect(bangkokDateKey(new Date('2026-07-16T17:00:00.000Z'))).toBe('2026-07-17');
  });

  it('strictly rejects malformed and impossible YYYY-MM-DD dates', () => {
    expect(parseDateOnly('2026-02-29')).toBeNull();
    expect(parseDateOnly('2026-2-09')).toBeNull();
    expect(parseDateOnly('2026-07-17T00:00:00Z')).toBeNull();
  });
});
