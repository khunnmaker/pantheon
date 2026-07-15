import { prisma } from '../db/prisma.js';
import { sendLineText } from '../line/send.js';
import { eventDateRangeWhere } from './calendarQuery.js';
import { APOLLO_URL, buildDigestLines } from './digest.js';

export function thaiDateKey(date = new Date()): string {
  return new Date(date.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function notifyApolloAssignment(taskId: string): Promise<void> {
  const task = await prisma.apolloTask.findUnique({
    where: { id: taskId },
    include: { project: { select: { name: true } }, assignee: { select: { lineUserId: true } } },
  });
  if (!task?.assignee?.lineUserId) return;
  await sendLineText(task.assignee.lineUserId, [
    `📌 งานใหม่: ${task.title}`,
    `โครงการ: ${task.project.name} · กำหนด ${task.dueDate.toISOString().slice(0, 10)}`,
    `${APOLLO_URL}/t/${task.id}`,
  ].join('\n'));
}

export async function sendApolloMorningDigests(): Promise<number> {
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
  for (const agent of agents) {
    if (!agent.lineUserId) continue;
    const taskWhere = { assigneeId: agent.id, completedAt: null, dueDate: { lte: dueThrough } };
    const [totalOpenCount, events] = await Promise.all([
      // True total (the findMany above is capped at 20) — feeds buildDigestLines' "และอีก N
      // งาน" trailer so it never undercounts past the fetch cap.
      prisma.apolloTask.count({ where: taskWhere }),
      // OWN events only: agentId is filtered directly in this query (never widened to other
      // agents' rows, never fetched-then-filtered). This digest is pushed to this agent's own
      // private LINE, so surfacing one of their own 'private' events here is not a visibility
      // leak — the only reader is its owner, same as the calendar's own-event handling.
      prisma.apolloEvent.findMany({
        where: { agentId: agent.id, ...eventDateRangeWhere(todayDate, todayDate) },
        select: { title: true, startTime: true, endTime: true, visibility: true },
      }),
    ]);
    const lines = buildDigestLines(agent.name, agent.apolloAssignedTasks, events, today, totalOpenCount);
    if (!lines) continue;
    await sendLineText(agent.lineUserId, lines.join('\n'));
    sent += 1;
  }
  return sent;
}
