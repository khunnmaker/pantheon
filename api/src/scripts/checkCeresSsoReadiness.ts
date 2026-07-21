import { hasAppAccess, type AuthedAgent } from '../auth/jwt.js';
import { prisma } from '../db/prisma.js';
import { STAFF, TIER_ACCOUNTS, staffEmail } from '../db/ensureSeeded.js';

type AuditAgent = Pick<AuthedAgent, 'id' | 'email' | 'name' | 'role' | 'apps'> & { authVersion: number };

const emailKey = (value: string): string => value.trim().toLowerCase();
const sorted = (values: Iterable<string>): string[] => [...values].sort((a, b) => a.localeCompare(b));
const identifiesAgent = (agent: Pick<AuditAgent, 'id' | 'email'>): string => `${agent.email} (${agent.id})`;

async function main(): Promise<void> {
  // Deliberately select identity/access fields only. This audit never reads password hashes,
  // deployment variables, bearer tokens, cookies, PINs, or any other credential material.
  const [agentsRaw, parties, referencedExpenseParties] = await Promise.all([
    prisma.agent.findMany({
      select: { id: true, email: true, name: true, role: true, apps: true, authVersion: true },
      orderBy: { email: 'asc' },
    }),
    prisma.ceresParty.findMany({
      select: { id: true, name: true, kind: true, agentEmail: true, active: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
    prisma.ceresExpense.findMany({
      where: { partyId: { not: null } },
      distinct: ['partyId'],
      select: { partyId: true },
    }),
  ]);

  const agents = agentsRaw.filter(
    (agent): agent is AuditAgent => ['supervisor', 'gm', 'central', 'staff'].includes(agent.role),
  );
  const agentByEmail = new Map(agents.map((agent) => [emailKey(agent.email), agent]));
  const activePartiesByEmail = new Map<string, typeof parties>();
  for (const party of parties) {
    if (!party.active || !party.agentEmail) continue;
    const key = emailKey(party.agentEmail);
    activePartiesByEmail.set(key, [...(activePartiesByEmail.get(key) ?? []), party]);
  }

  const activeLegacyMessengers = parties.filter((party) => party.active && party.kind === 'person');
  const activeLegacyMessengersWithoutAgent = activeLegacyMessengers
    .filter((party) => !party.agentEmail || !agentByEmail.has(emailKey(party.agentEmail)))
    .map((party) => `${party.name} (${party.id})${party.agentEmail ? ` -> ${party.agentEmail}` : ''}`);
  const activeLegacyMessengersWithoutAccess = activeLegacyMessengers
    .flatMap((party) => {
      const agent = party.agentEmail ? agentByEmail.get(emailKey(party.agentEmail)) : undefined;
      return agent && !hasAppAccess(agent, 'ceres') ? [identifiesAgent(agent)] : [];
    });

  const expectedTargets = [
    ...TIER_ACCOUNTS.map((account) => ({ email: account.email, name: account.name })),
    ...STAFF
      .filter((staff) => staff.apps.includes('ceres'))
      .map((staff) => ({ email: staffEmail(staff.slug), name: staff.name })),
  ];
  const targetAccountsMissingAgent = expectedTargets
    .filter((target) => !agentByEmail.has(emailKey(target.email)))
    .map((target) => `${target.email} (${target.name})`);
  const targetAccountsWithoutAccess = expectedTargets
    .flatMap((target) => {
      const agent = agentByEmail.get(emailKey(target.email));
      return agent && !hasAppAccess(agent, 'ceres') ? [identifiesAgent(agent)] : [];
    });
  const targetRequestersWithoutActiveParty = expectedTargets
    .flatMap((target) => {
      const agent = agentByEmail.get(emailKey(target.email));
      if (!agent || (agent.role !== 'staff' && agent.role !== 'central')) return [];
      return activePartiesByEmail.has(emailKey(agent.email)) ? [] : [identifiesAgent(agent)];
    });

  const duplicateActivePartiesByEmail = [...activePartiesByEmail.entries()]
    .filter(([, linkedParties]) => linkedParties.length > 1)
    .map(([email, linkedParties]) => `${email}: ${sorted(linkedParties.map((party) => party.id)).join(', ')}`);
  const grantedStaffWithoutActiveParty = agents
    .filter((agent) => (agent.role === 'staff' || agent.role === 'central') && hasAppAccess(agent, 'ceres'))
    .filter((agent) => !activePartiesByEmail.has(emailKey(agent.email)))
    .map(identifiesAgent);

  const partyIds = new Set(parties.map((party) => party.id));
  const missingReferencedLegacyParties = referencedExpenseParties
    .flatMap((row) => row.partyId && !partyIds.has(row.partyId) ? [row.partyId] : []);

  const issues = {
    activeLegacyMessengersWithoutAgent: sorted(activeLegacyMessengersWithoutAgent),
    activeLegacyMessengersWithoutAccess: sorted(activeLegacyMessengersWithoutAccess),
    targetAccountsMissingAgent: sorted(targetAccountsMissingAgent),
    targetAccountsWithoutAccess: sorted(targetAccountsWithoutAccess),
    targetRequestersWithoutActiveParty: sorted(targetRequestersWithoutActiveParty),
    duplicateActivePartiesByEmail: sorted(duplicateActivePartiesByEmail),
    grantedStaffWithoutActiveParty: sorted(grantedStaffWithoutActiveParty),
    missingReferencedLegacyParties: sorted(missingReferencedLegacyParties),
  };
  const issueCounts = Object.fromEntries(Object.entries(issues).map(([key, identifiers]) => [key, identifiers.length]));
  const report = {
    counts: {
      agents: agents.length,
      activeLegacyMessengers: activeLegacyMessengers.length,
      targetAccounts: expectedTargets.length,
      activeLinkedParties: [...activePartiesByEmail.values()].reduce((sum, rows) => sum + rows.length, 0),
      referencedLegacyParties: referencedExpenseParties.length,
      ...issueCounts,
    },
    identifiers: issues,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (Object.values(issues).some((identifiers) => identifiers.length > 0)) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
