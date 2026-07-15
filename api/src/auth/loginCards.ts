import { prisma } from '../db/prisma.js';
import { TIER_ACCOUNTS, EMPLOYEES, employeeEmail } from '../db/ensureSeeded.js';
import { GM_APPS, type AppName } from './jwt.js';

export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the suite login screens (role-grouped tiles + cute avatars). Additive
  // — older clients that only read email/name/kind keep working unchanged.
  group: string;                 // ceo | gm | agm | sales | finance | messengers | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
}

// Shared "who can log in to app X" name-card list, used by BOTH the public
// GET /api/auth/logins?app= (Minerva/Vesta/Juno/general) and GET /api/ceres/logins (Ceres).
// Order: supervisor first, then GM, AGM, and other employees. The password GM uses implicit
// GM_APPS; PIN-auth GMs/AGMs are ordered by role after filtering their declared app grants.
// Only accounts that actually exist in the DB
// (provisioned) are returned. Names + emails only — no roles/ids beyond `kind`.
export async function buildLoginCards(app: AppName): Promise<LoginCard[]> {
  const supervisor = TIER_ACCOUNTS.find((t) => t.role === 'supervisor')!;
  const gm = TIER_ACCOUNTS.find((t) => t.role === 'gm')!;
  const employeesForApp = EMPLOYEES.filter((e) => e.apps.includes(app));
  const pinGms = employeesForApp.filter((e) => e.role === 'gm');
  const agms = employeesForApp.filter((e) => e.role === 'agm');
  const otherEmployees = employeesForApp.filter((e) => (e.role ?? 'employee') === 'employee');

  const candidateEmails = [
    supervisor.email,
    ...(GM_APPS.includes(app) ? [gm.email] : []),
    ...[...pinGms, ...agms, ...otherEmployees].map((e) => employeeEmail(e.slug)),
  ];

  const existing = await prisma.agent.findMany({
    where: { email: { in: candidateEmails } },
    select: { email: true },
  });
  const known = new Set(existing.map((a) => a.email));

  const cards: LoginCard[] = [];
  if (known.has(supervisor.email)) {
    cards.push({ email: supervisor.email, name: supervisor.name, kind: 'password', group: supervisor.group, gender: supervisor.gender });
  }
  if (GM_APPS.includes(app) && known.has(gm.email)) {
    cards.push({ email: gm.email, name: gm.name, kind: 'password', group: gm.group, gender: gm.gender });
  }
  for (const e of [...pinGms, ...agms, ...otherEmployees]) {
    const email = employeeEmail(e.slug);
    if (known.has(email)) cards.push({ email, name: e.name, kind: 'pin', group: e.group, gender: e.gender });
  }
  return cards;
}
