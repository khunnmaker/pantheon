import { addDays, dateKey } from './dates.js';

export type HestiaCadence = 'daily' | 'weekdays' | 'custom';

export interface StreakHabit {
  cadence: HestiaCadence;
  scheduleDays: number[];
  targetCount: number;
  startDate: Date;
  endDate: Date | null;
}

export interface StreakCheckIn {
  checkDate: Date;
  count: number;
}

export interface StreakResult {
  currentStreak: number;
  longestStreak: number;
  lastCompletedOn: Date | null;
  calculatedOn: Date;
}

export function isHabitScheduled(habit: StreakHabit, date: Date): boolean {
  if (date < habit.startDate || (habit.endDate && date > habit.endDate)) return false;
  const day = date.getUTCDay();
  if (habit.cadence === 'daily') return true;
  if (habit.cadence === 'weekdays') return day >= 1 && day <= 5;
  return habit.scheduleDays.includes(day);
}

export function calculateStreak(habit: StreakHabit, checkIns: StreakCheckIn[], calculatedOn: Date): StreakResult {
  const completed = new Set(
    checkIns
      .filter((row) => row.count >= habit.targetCount && isHabitScheduled(habit, row.checkDate))
      .map((row) => dateKey(row.checkDate)),
  );
  const lastDate = habit.endDate && habit.endDate < calculatedOn ? habit.endDate : calculatedOn;
  let longestStreak = 0;
  let run = 0;
  let lastCompletedOn: Date | null = null;

  if (lastDate >= habit.startDate) {
    for (let date = habit.startDate; date <= lastDate; date = addDays(date, 1)) {
      if (!isHabitScheduled(habit, date)) continue;
      if (completed.has(dateKey(date))) {
        run += 1;
        longestStreak = Math.max(longestStreak, run);
        lastCompletedOn = date;
      } else {
        run = 0;
      }
    }
  }

  let currentStreak = 0;
  let cursor = lastDate;
  if (cursor >= habit.startDate && isHabitScheduled(habit, cursor) && dateKey(cursor) === dateKey(calculatedOn) && !completed.has(dateKey(cursor))) {
    cursor = addDays(cursor, -1);
  }
  for (; cursor >= habit.startDate; cursor = addDays(cursor, -1)) {
    if (!isHabitScheduled(habit, cursor)) continue;
    if (!completed.has(dateKey(cursor))) break;
    currentStreak += 1;
  }

  return { currentStreak, longestStreak, lastCompletedOn, calculatedOn };
}
