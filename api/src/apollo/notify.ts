import { prisma } from '../db/prisma.js';
import { getProminentOwnerLineUserId } from '../line/owner.js';
import { sendLineText, sendOwnerLineText } from '../line/send.js';
import { eventDateRangeWhere, recurringEventRangeWhere } from './calendarQuery.js';
import { APOLLO_URL, buildDigestLines, digestEventsForDay } from './digest.js';

export function thaiDateKey(date = new Date()): string {
  return new Date(date.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function notifyApolloAssignment(taskId: string): Promise<void> {
  const task = await prisma.apolloTask.findUnique({
    where: { id: taskId },
    include: { project: { select: { name: true } }, assignee: { select: { lineUserId: true } } },
  });
  if (!task?.assignee?.lineUserId) return;
  const isOwner = task.assignee.lineUserId === getProminentOwnerLineUserId();
  const result = await (isOwner ? sendOwnerLineText : sendLineText)(task.assignee.lineUserId, [
    `📌 งานใหม่: ${task.title}`,
    `โครงการ: ${task.project.name} · กำหนด ${task.dueDate.toISOString().slice(0, 10)}`,
    `${APOLLO_URL}/t/${task.id}`,
  ].join('\n'));
  if (isOwner && result.skipped) {
    // eslint-disable-next-line no-console
    console.error({ event: 'owner_digest_skipped', kind: 'apollo_assignment', reason: result.skipReason });
  }
}

export async function sendApolloMorningDigests(): Promise<number> {
  const ownerLineUserId = getProminentOwnerLineUserId();
  const today = thaiDateKey();
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const dueThrough = todayDate;
  const agents = await prisma.agent.findMany({
    where: { lineUserId: { not: null } },
    select: {
      id: true, name: true, lineUserId: true,
      apolloAssignedTasks: {
        where: { completedAt: null, dueDate: { lte: dueThrough } },
        orderBy: { dueDate: 'asc' },
        take: 20,
        select: { id: true, title: true, dueDate: true, priority: true },
      },
    },
  });
  let sent = 0;
  let ownerMatches = 0;
  for (const agent of agents) {
    if (!agent.lineUserId) continue;
    const isOwner = Boolean(ownerLineUserId && agent.lineUserId === ownerLineUserId);
    if (isOwner) ownerMatches += 1;
    const taskWhere = { assigneeId: agent.id, completedAt: null, dueDate: { lte: dueThrough } };
    const [totalOpenCount, events] = await Promise.all([
      // True total (the findMany above is capped at 20) — feeds buildDigestLines' "และอีก N
      // งาน" trailer so it never undercounts past the fetch cap.
      prisma.apolloTask.count({ where: taskWhere }),
      // OWN events only: agentId is filtered directly in this query (never widened to other
      // agents' rows, never fetched-then-filtered). This digest is pushed to this agent's own
      // private LINE, so surfacing one of their own 'private' events here is not a visibility
      // leak — the only reader is its owner, same as the calendar's own-event handling. Candidates
      // = non-recurring rows overlapping today OR a recurring series active today; the recurrence
      // columns are selected so occursOn(today) can drop the days a series doesn't actually fall on.
      prisma.apolloEvent.findMany({
        where: { agentId: agent.id, OR: [eventDateRangeWhere(todayDate, todayDate), recurringEventRangeWhere(todayDate, todayDate)] },
        select: { title: true, startTime: true, endTime: true, visibility: true, date: true, recurrenceRule: true, recurrenceUntil: true, skipDates: true },
      }),
    ]);
    const lines = buildDigestLines(agent.name, agent.apolloAssignedTasks, digestEventsForDay(events, today), today, totalOpenCount);
    if (!lines) continue;
    if (isOwner) {
      try {
        const result = await sendOwnerLineText(agent.lineUserId, lines.join('\n'));
        if (result.sent) sent += 1;
        else if (result.skipped) {
          // eslint-disable-next-line no-console
          console.error({ event: 'owner_digest_skipped', kind: 'apollo_morning', reason: result.skipReason });
        }
      } catch {
        // Owner delivery is isolated so a private-channel outage cannot block staff digests.
        // eslint-disable-next-line no-console
        console.error({ event: 'owner_push_failed', kind: 'apollo_morning', reason: 'line_api_error' });
      }
      continue;
    }
    await sendLineText(agent.lineUserId, lines.join('\n'));
    sent += 1;
  }
  if (ownerMatches === 0) {
    // eslint-disable-next-line no-console
    console.warn({
      event: 'owner_digest_skipped',
      kind: 'apollo_morning',
      reason: ownerLineUserId ? 'owner_agent_not_found' : 'owner_id_unset',
    });
  }
  return sent;
}
