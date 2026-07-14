import { describe, expect, it } from 'vitest';
import { nextOccurrenceDate, parseRecurrenceRule } from '../src/apollo/recurrence.js';

describe('Apollo recurrence', () => {
  it('advances daily and weekly rules strictly into the future', () => {
    const monday = new Date('2026-07-13T00:00:00.000Z');
    expect(nextOccurrenceDate(monday, { freq: 'daily' }).toISOString().slice(0, 10)).toBe('2026-07-14');
    expect(nextOccurrenceDate(monday, { freq: 'weekly', weekday: 1 }).toISOString().slice(0, 10)).toBe('2026-07-20');
    expect(nextOccurrenceDate(monday, { freq: 'weekly', weekday: 5 }).toISOString().slice(0, 10)).toBe('2026-07-17');
  });

  it('clamps monthly recurrences to the target month length', () => {
    expect(nextOccurrenceDate(new Date('2026-01-31T00:00:00.000Z'), { freq: 'monthly', dayOfMonth: 31 }).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(nextOccurrenceDate(new Date('2028-01-31T00:00:00.000Z'), { freq: 'monthly', dayOfMonth: 31 }).toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('rejects incomplete or out-of-range rules', () => {
    expect(parseRecurrenceRule({ freq: 'weekly' })).toBeNull();
    expect(parseRecurrenceRule({ freq: 'monthly', dayOfMonth: 32 })).toBeNull();
    expect(parseRecurrenceRule({ freq: 'daily', weekday: 4 })).toEqual({ freq: 'daily' });
  });
});
