import { prisma } from '../db/prisma.js';
import { TIER_ACCOUNTS, EMPLOYEES, employeeEmail } from '../db/ensureSeeded.js';
import type { AppName } from './jwt.js';

export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
}

// Shared "who can log in to app X" name-card list, used by BOTH the public
// GET /api/auth/logins?app= (Minerva/Vulcan/Juno/general) and GET /api/ceres/logins (Ceres).
// Order: supervisor card first, then md (ceres only), then employees whose apps include the
// requested app (EMPLOYEES declaration order). Only accounts that actually exist in the DB
// (provisioned) are returned. Names + emails only — no roles/ids beyond `kind`.
export async function buildLoginCards(app: AppName): Promise<LoginCard[]> {
  const supervisor = TIER_ACCOUNTS.find((t) => t.role === 'supervisor')!;
  const md = TIER_ACCOUNTS.find((t) => t.role === 'md')!;

  const candidateEmails = [
    supervisor.email,
    ...(app === 'ceres' ? [md.email] : []),
    ...EMPLOYEES.filter((e) => (e.apps as readonly string[]).includes(app)).map((e) => employeeEmail(e.slug)),
  ];

  const existing = await prisma.agent.findMany({
    where: { email: { in: candidateEmails } },
    select: { email: true },
  });
  const known = new Set(existing.map((a) => a.email));

  const cards: LoginCard[] = [];
  if (known.has(supervisor.email)) {
    cards.push({ email: supervisor.email, name: supervisor.name, kind: 'password' });
  }
  if (app === 'ceres' && known.has(md.email)) {
    cards.push({ email: md.email, name: md.name, kind: 'password' });
  }
  for (const e of EMPLOYEES) {
    if (!(e.apps as readonly string[]).includes(app)) continue;
    const email = employeeEmail(e.slug);
    if (known.has(email)) cards.push({ email, name: e.name, kind: 'pin' });
  }
  return cards;
}
