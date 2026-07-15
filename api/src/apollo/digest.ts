// Pure message-builder for the Apollo morning digest — no prisma, no LINE client, so the
// text layout (task/event lines, ordering, display caps, "and N more" trailers) is
// unit-testable without a DB. notify.ts stays a thin shell: run the prisma queries (already
// scoped to one agent's own rows), hand the results to buildDigestLines, and send whatever
// comes back — null means nothing to send, so the caller skips the LINE push entirely.

export const APOLLO_URL = 'https://apollo.prominentdental.com';

// priority is stored as a free-text String column (see schema.prisma), so a naive
// `orderBy priority asc` sorts alphabetically (high < low < normal < urgent) — wrong. This
// mirrors the frontend's priorityRank (apollo/src/Workspace.tsx) so both sides agree on
// urgent-first ordering.
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const TASK_DISPLAY_CAP = 10;
const EVENT_DISPLAY_CAP = 5;

export interface DigestTask { id: string; title: string; dueDate: Date; priority: string }
export interface DigestEvent { title: string; startTime: string | null; endTime: string | null; visibility: string }

function dateKey(d: Date): string { return d.toISOString().slice(0, 10); }

/**
 * Builds the morning-digest LINE message lines for one agent, or null when there's nothing to
 * send (no open due/overdue tasks AND no events today — the caller should skip the LINE push).
 *
 * `tasks` — the agent's own open tasks due today or earlier, in any order (re-sorted here:
 * dueDate asc, then priority rank urgent<high<normal<low — sorting by `priority asc` at the DB
 * level would be alphabetical since priority is a plain string column).
 * `events` — the agent's own ApolloEvent rows for today ONLY (the caller must have already
 * filtered to that one agent's rows; this function has no agentId concept and trusts its input).
 * `totalOpenCount` — the TRUE total of matching open tasks (a separate count query in
 * notify.ts), used only for the "และอีก N งาน" trailer so it never undercounts when the agent
 * has more open tasks than whatever fetch cap the caller used.
 */
export function buildDigestLines(
  name: string,
  tasks: DigestTask[],
  events: DigestEvent[],
  todayKey: string,
  totalOpenCount: number,
): string[] | null {
  if (!tasks.length && !events.length) return null;

  const overdueCount = tasks.filter((t) => dateKey(t.dueDate) < todayKey).length;
  const dueTodayCount = tasks.filter((t) => dateKey(t.dueDate) === todayKey).length;
  const ordered = [...tasks].sort((a, b) => {
    const byDate = a.dueDate.getTime() - b.dueDate.getTime();
    return byDate !== 0 ? byDate : (PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal) - (PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal);
  });

  const lines = [
    `☀️ Apollo · งานของ ${name}`,
    `วันนี้ ${dueTodayCount} · เลยกำหนด ${overdueCount}${events.length > 0 ? ` · นัดหมาย ${events.length}` : ''}`,
  ];

  for (const task of ordered.slice(0, TASK_DISPLAY_CAP)) {
    const mark = dateKey(task.dueDate) < todayKey ? '⚠️' : '•';
    lines.push(`${mark} ${task.title}`, `${APOLLO_URL}/t/${task.id}`);
  }
  const moreTasks = totalOpenCount - Math.min(TASK_DISPLAY_CAP, ordered.length);
  if (moreTasks > 0) lines.push(`และอีก ${moreTasks} งาน`);

  // No-time events sort first (empty string precedes any "HH:MM"), then timed events
  // ascending — same convention as CalendarView's dayChips (all-day before timed).
  const orderedEvents = [...events].sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  for (const event of orderedEvents.slice(0, EVENT_DISPLAY_CAP)) {
    const time = event.startTime ? `${event.startTime}${event.endTime ? `–${event.endTime}` : ''} ` : '';
    const lock = event.visibility === 'private' ? '🔒 ' : '';
    lines.push(`📅 ${time}${lock}${event.title}`);
  }
  const moreEvents = events.length - EVENT_DISPLAY_CAP;
  if (moreEvents > 0) lines.push(`และอีกนัดหมาย ${moreEvents} รายการ`);

  return lines;
}
