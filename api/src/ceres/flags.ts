import { prisma } from '../db/prisma.js';
import type { AuthedAgent } from '../auth/jwt.js';
import { ceresRole } from './auth.js';
import { getStaffRequest, CeresRequestError } from './requestService.js';

// Owner directive (2026-07-21): "each person should be able to flag any transaction for
// review — again, especially in the beginning." Any Ceres persona can flag a request or
// expense they can already SEE (server-enforced, reusing the same visibility rule the list
// endpoints use); GM/CEO triage the open queue and resolve. 'cashTxn' is a reserved target
// type (see schema.prisma's CeresFlag comment) — no cash-movement void exists yet (see
// requestVoid.ts / the void feature's report), so it's intentionally not accepted here.
export const FLAG_TARGET_TYPES = ['request', 'expense'] as const;
export type FlagTargetType = (typeof FLAG_TARGET_TYPES)[number];

export class CeresFlagError extends Error {
  constructor(public readonly code: 'not_found' | 'forbidden' | 'already_flagged') {
    super(code);
  }
}

// Mirrors GET /api/ceres/expenses' own-party visibility filter (routes/ceres/p1.ts) — a
// messenger may only flag an expense tied to their own party; gm/ceo see everything.
async function assertExpenseVisible(expenseId: string, agent: AuthedAgent): Promise<void> {
  const expense = await prisma.ceresExpense.findUnique({ where: { id: expenseId } });
  if (!expense) throw new CeresFlagError('not_found');
  const role = ceresRole(agent);
  if (role === 'gm' || role === 'ceo') return;
  const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } });
  if (!own || expense.partyId !== own.id) throw new CeresFlagError('not_found');
}

// Mirrors GET /api/ceres/requests/:id's own-or-manager visibility rule exactly, by reusing
// the same function (requestService.ts's getStaffRequest) rather than re-deriving it.
async function assertRequestVisible(requestId: string, agent: AuthedAgent): Promise<void> {
  try {
    await getStaffRequest(requestId, agent);
  } catch (err) {
    if (err instanceof CeresRequestError && err.code === 'not_found') throw new CeresFlagError('not_found');
    throw err;
  }
}

export interface CreateFlagInput {
  targetType: FlagTargetType;
  targetId: string;
  note: string;
  agent: AuthedAgent;
}

export async function createFlag({ targetType, targetId, note, agent }: CreateFlagInput) {
  if (targetType === 'expense') await assertExpenseVisible(targetId, agent);
  else await assertRequestVisible(targetId, agent);

  // One open flag per (target, flagger) — re-flagging while open is a 409; check-then-create
  // is not airtight under a true race, but flagging is a rare, human-paced action (same
  // trust level as the rest of Ceres' non-locked write paths, e.g. PATCH /expenses).
  const existingOpen = await prisma.ceresFlag.findFirst({
    where: { targetType, targetId, flaggedById: agent.id, status: 'open' },
  });
  if (existingOpen) throw new CeresFlagError('already_flagged');

  return prisma.ceresFlag.create({
    data: {
      targetType,
      targetId,
      flaggedById: agent.id,
      flaggedByName: agent.name,
      note,
      status: 'open',
    },
  });
}

export async function listFlags(status: 'open' | 'resolved' = 'open', limit = 200) {
  return prisma.ceresFlag.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: limit });
}

export async function resolveFlag(id: string, resolutionNote: string, agent: AuthedAgent) {
  const existing = await prisma.ceresFlag.findUnique({ where: { id } });
  if (!existing) throw new CeresFlagError('not_found');
  if (existing.status === 'resolved') throw new CeresFlagError('already_flagged');
  return prisma.ceresFlag.update({
    where: { id },
    data: {
      status: 'resolved',
      resolvedById: agent.id,
      resolvedByName: agent.name,
      resolvedAt: new Date(),
      resolutionNote,
    },
  });
}

// Narrows a batch of target ids down to the ones THIS messenger can actually see — same
// ownership rule as assertRequestVisible/assertExpenseVisible above (request: their own
// requestedById; expense: their own party), just batched instead of one-at-a-time. Ids
// filtered out simply don't appear in the result — no error, no existence signal.
async function filterVisibleToMessenger(targetType: FlagTargetType, targetIds: string[], agent: AuthedAgent): Promise<string[]> {
  if (targetType === 'expense') {
    const own = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email } });
    if (!own) return [];
    const rows = await prisma.ceresExpense.findMany({
      where: { id: { in: targetIds }, partyId: own.id },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
  const rows = await prisma.ceresPaymentRequest.findMany({
    where: { id: { in: targetIds }, workflowVersion: 2, requestedById: agent.id },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// Open-flag counts for a batch of target ids. gm/ceo see counts for anything (they already
// see every request/expense). A messenger only gets counts for ids they can actually see —
// same visibility rule createFlag() enforces — so this endpoint can't be used to probe
// whether some OTHER person's request/expense has an open flag on it (IDOR fix,
// 2026-07-21 review): a messenger passing another person's id simply gets no entry back,
// identical to passing an id that doesn't exist.
export async function getFlagCounts(targetType: FlagTargetType, targetIds: string[], agent: AuthedAgent): Promise<Record<string, number>> {
  if (targetIds.length === 0) return {};
  const role = ceresRole(agent);
  const visibleIds = role === 'gm' || role === 'ceo' ? targetIds : await filterVisibleToMessenger(targetType, targetIds, agent);
  if (visibleIds.length === 0) return {};
  const rows = await prisma.ceresFlag.groupBy({
    by: ['targetId'],
    where: { targetType, targetId: { in: visibleIds }, status: 'open' },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.targetId] = row._count._all;
  return counts;
}
