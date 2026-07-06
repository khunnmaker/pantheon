import { prisma } from '../db/prisma.js';
import { TIER_ACCOUNTS, EMPLOYEES, employeeEmail } from '../db/ensureSeeded.js';
import { MD_APPS, type AppName } from './jwt.js';

export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the suite login screens (role-grouped tiles + cute avatars). Additive
  // — older clients that only read email/name/kind keep working unchanged.
  group: string;                 // ceo | md | sales | finance | messengers | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
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
    ...(MD_APPS.includes(app) ? [md.email] : []),
    ...EMPLOYEES.filter((e) => (e.apps as readonly string[]).includes(app)).map((e) => employeeEmail(e.slug)),
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
  if (MD_APPS.includes(app) && known.has(md.email)) {
    cards.push({ email: md.email, name: md.name, kind: 'password', group: md.group, gender: md.gender });
  }
  for (const e of EMPLOYEES) {
    if (!(e.apps as readonly string[]).includes(app)) continue;
    const email = employeeEmail(e.slug);
    if (known.has(email)) cards.push({ email, name: e.name, kind: 'pin', group: e.group, gender: e.gender });
  }
  return cards;
}
