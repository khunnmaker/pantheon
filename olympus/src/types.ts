export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
export interface Agent { id: string; email: string; name: string; role: Role; apps: string[] }

// Every Hestia route is behind requireAuth + requireRole('supervisor') (api/src/routes/hestia.ts)
// regardless of Agent.apps — see olympus/src/lib/api.ts for the matching client-side gate.

export type GoalStatus = 'active' | 'completed' | 'archived';
export type HabitCadence = 'daily' | 'weekdays' | 'custom';
export type JournalSource = 'manual' | 'notion';

// api/prisma/schema.prisma HestiaHabitStreak — a derived cache, recomputed server-side after
// every check-in/undo and relevant habit edit. `@db.Date` fields cross the wire as full
// ISO-8601 datetime strings (JSON.stringify on a Date); callers slice(0, 10) when they need the
// YYYY-MM-DD key.
export interface HestiaHabitStreak {
  habitId: string;
  ownerId: string;
  currentStreak: number;
  longestStreak: number;
  lastCompletedOn: string | null;
  calculatedOn: string;
  updatedAt: string;
}

// Bare HestiaHabit row (no `goal` backref) — the shape embedded in HestiaGoal.habits (GET/POST/PATCH
// .../goals*) and returned directly by POST/PATCH .../habits (those routes re-fetch with
// `include: { streak: true }` only, never `goal`).
export interface HestiaHabit {
  id: string;
  ownerId: string;
  goalId: string;
  code: string;
  title: string;
  description: string;
  cadence: HabitCadence;
  scheduleDays: number[];
  targetCount: number;
  startDate: string;
  endDate: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  streak: HestiaHabitStreak | null;
}

// Goal reference embedded on a habit row — GET /api/hestia/habits includes `goal: true` (the
// bare goal, without its own nested `habits`).
export interface HestiaGoalRef {
  id: string;
  ownerId: string;
  year: number;
  code: string;
  title: string;
  description: string;
  status: GoalStatus;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Row shape returned by GET /api/hestia/habits (goal attached, no nested habits on it).
export interface HestiaHabitWithGoal extends HestiaHabit { goal: HestiaGoalRef }

// Row shape returned by GET/POST/PATCH .../goals (habits attached, each with its own streak but
// no goal backref).
export interface HestiaGoal extends HestiaGoalRef { habits: HestiaHabit[] }

export interface HestiaCheckIn {
  id: string;
  ownerId: string;
  habitId: string;
  checkDate: string;
  count: number;
  note: string;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HestiaJournalEntry {
  id: string;
  ownerId: string;
  entryDate: string;
  title: string;
  bodyMarkdown: string;
  mood: number | null;
  tags: string[];
  source: JournalSource;
  externalId: string | null;
  externalUrl: string | null;
  sourceUpdatedAt: string | null;
  importedAt: string | null;
  sourceMetadata: unknown | null;
  createdAt: string;
  updatedAt: string;
}

// GET /api/hestia/overview response.
export interface HestiaOverview {
  date: string;
  year: number;
  goals: HestiaGoal[];
  checkIns: HestiaCheckIn[];
  totals: { completed: number; total: number };
  recentJournal: HestiaJournalEntry[];
}

// GET /api/hestia/journal response (cursor pagination, newest first).
export interface HestiaJournalPage {
  entries: HestiaJournalEntry[];
  nextCursor: string | null;
}

// PUT/DELETE .../check-ins/:date responses.
export interface HestiaCheckInPutResult { checkIn: HestiaCheckIn; streak: HestiaHabitStreak | null }
export interface HestiaCheckInDeleteResult { ok: true; streak: HestiaHabitStreak | null }

// Request bodies — field order here is display/identity-first (code before title) to match the
// required form order (plan §4): forms read this same order top to bottom.
export interface GoalInput { code: string; title: string; year: number; description?: string; color?: string; sortOrder?: number }
export interface GoalPatchInput { code?: string; title?: string; year?: number; description?: string; color?: string; sortOrder?: number; status?: GoalStatus }

export interface HabitInput {
  code: string; title: string; goalId: string; cadence: HabitCadence; scheduleDays?: number[];
  targetCount: number; startDate: string; endDate?: string | null; description?: string; sortOrder?: number;
}
export interface HabitPatchInput extends Partial<HabitInput> { active?: boolean }

export interface JournalInput { entryDate: string; title?: string; bodyMarkdown: string; mood?: number | null; tags?: string[] }
export type JournalPatchInput = Partial<JournalInput>;
