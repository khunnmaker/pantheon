import { prisma } from '../db/prisma.js';
import { buildSummaryPrompt } from '../llm/prompt.js';
import { callClaude, llmAvailable } from '../llm/anthropic.js';

const histLine = (role: string, text: string) =>
  `${role === 'customer' ? 'ลูกค้า' : 'ร้าน'}: ${text}`;

// Generate a 2–3 sentence Thai summary of the whole conversation (long-term
// memory) and store it on CustomerMemory. No-ops without an LLM key.
export async function summarizeCustomer(customerId: string): Promise<string | null> {
  if (!llmAvailable()) return null;

  const messages = await prisma.message.findMany({
    where: { customerId },
    orderBy: { createdAt: 'asc' },
  });
  if (!messages.some((m) => m.role === 'customer')) return null;

  let summary: string;
  try {
    const history = messages.map((m) => histLine(m.role, m.text)).join('\n');
    summary = (await callClaude(
      buildSummaryPrompt(history),
      undefined,
      undefined,
      undefined,
      { app: 'minerva', feature: 'memory-summary' },
    )).trim();
  } catch {
    return null;
  }
  if (!summary) return null;

  await prisma.customerMemory.upsert({
    where: { customerId },
    update: { summary, summarizedThroughN: messages.length },
    create: { customerId, summary, summarizedThroughN: messages.length },
  });
  return summary;
}

// Mark a customer's open session(s) ended and refresh the long-term summary.
export async function endSession(customerId: string): Promise<string | null> {
  await prisma.session.updateMany({
    where: { customerId, status: 'open' },
    data: { status: 'ended', endedAt: new Date() },
  });
  return summarizeCustomer(customerId);
}

// Sweep: end + summarize sessions with no activity for `idleMinutes`.
export async function sweepIdleSessions(idleMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - idleMinutes * 60_000);
  const open = await prisma.session.findMany({
    where: { status: 'open' },
    select: { id: true, customerId: true },
  });

  let ended = 0;
  for (const s of open) {
    const last = await prisma.message.findFirst({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && last.createdAt < cutoff) {
      await prisma.session.update({ where: { id: s.id }, data: { status: 'ended', endedAt: new Date() } });
      await summarizeCustomer(s.customerId).catch(() => undefined);
      ended++;
    }
  }
  return ended;
}
