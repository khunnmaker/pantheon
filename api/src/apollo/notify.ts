import { prisma } from '../db/prisma.js';
import { sendLineText } from '../line/send.js';

const APOLLO_URL = 'https://apollo.prominentdental.com';

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
  const dueThrough = new Date(`${today}T00:00:00.000Z`);
  const agents = await prisma.agent.findMany({
    where: { lineUserId: { not: null } },
    select: {
      id: true, name: true, lineUserId: true,
      apolloAssignedTasks: {
        where: { completedAt: null, dueDate: { lte: dueThrough } },
        orderBy: [{ dueDate: 'asc' }, { priority: 'asc' }],
        take: 20,
        select: { id: true, title: true, dueDate: true },
      },
    },
  });
  let sent = 0;
  for (const agent of agents) {
    if (!agent.lineUserId || !agent.apolloAssignedTasks.length) continue;
    const overdue = agent.apolloAssignedTasks.filter((t) => t.dueDate.toISOString().slice(0, 10) < today);
    const dueToday = agent.apolloAssignedTasks.filter((t) => t.dueDate.toISOString().slice(0, 10) === today);
    const lines = [`☀️ Apollo · งานของ ${agent.name}`, `วันนี้ ${dueToday.length} · เลยกำหนด ${overdue.length}`];
    for (const task of [...overdue, ...dueToday].slice(0, 10)) {
      const mark = task.dueDate.toISOString().slice(0, 10) < today ? '⚠️' : '•';
      lines.push(`${mark} ${task.title}`, `${APOLLO_URL}/t/${task.id}`);
    }
    if (agent.apolloAssignedTasks.length > 10) lines.push(`และอีก ${agent.apolloAssignedTasks.length - 10} งาน`);
    await sendLineText(agent.lineUserId, lines.join('\n'));
    sent += 1;
  }
  return sent;
}
