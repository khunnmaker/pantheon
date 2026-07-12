import { hasAppAccess, type Agent, type AppName, type Badges } from './api';

// The deities the portal can launch. `url` is a VITE_*_URL env override on top of the canonical
// *.prominentdental.com subdomain default. That default MUST stay same-site with the api
// (api.prominentdental.com): the suite SSO cookie is SameSite=Lax + Domain=.prominentdental.com,
// so it only rides the bootstrap GET /api/auth/me when the app is opened from a
// *.prominentdental.com origin. A raw *.up.railway.app tile URL is a DIFFERENT site → the Lax
// cookie is withheld → the opened app's /me returns 401 → it shows Login even though the user is
// already signed in. So NEVER point these at raw Railway URLs. Every deity now carries a
// *.prominentdental.com default (mercury included since 2026-07); an unset URL hides the tile.
//
// Post unified-auth (PR #7): tile visibility is a PER-PERSON grant, not a role list — it must
// match exactly what the caller can open (and what /api/pantheon/badges returns). hasAppAccess()
// below mirrors the server's gate (api/src/auth/jwt.ts) so tiles == badges == openable apps.
// `order` is most-used-first and resolved in tilesFor().

export type AppKey = AppName;

export interface AppDef {
  key: AppKey;
  name: string;          // deity name
  job: string;           // Thai job label
  url: string | undefined;
  accent: string;        // tailwind text color for the tile icon/name
  badge: (b: Badges) => number | null;   // pending-work count from the badges payload
}

const env = import.meta.env;

export const APPS: AppDef[] = [
  {
    key: 'jupiter',
    name: 'Jupiter',
    job: 'บัญชี · งบการเงิน',
    url: env.VITE_JUPITER_URL ?? 'https://jupiter.prominentdental.com',
    accent: 'text-violet-600',
    badge: () => null,
  },
  {
    key: 'minerva',
    name: 'Minerva',
    job: 'ตอบแชทลูกค้า LINE',
    url: env.VITE_MINERVA_URL ?? 'https://minerva.prominentdental.com',
    accent: 'text-sky-600',
    badge: (b) => b.minerva?.pending ?? null,
  },
  {
    key: 'juno',
    name: 'Juno',
    job: 'การเงิน · ตรวจสลิป',
    url: env.VITE_JUNO_URL ?? 'https://juno.prominentdental.com',
    accent: 'text-emerald-600',
    badge: (b) => b.juno?.toVerify ?? null,
  },
  {
    key: 'vesta',
    name: 'Vesta',
    job: 'จัดการสต็อกสินค้า',
    url: env.VITE_VESTA_URL ?? 'https://vesta.prominentdental.com',
    accent: 'text-indigo-600',
    badge: (b) => b.vesta?.lowStock ?? null,
  },
  {
    key: 'ceres',
    name: 'Ceres',
    job: 'ค่าใช้จ่าย · เงินสดย่อย',
    url: env.VITE_CERES_URL ?? 'https://ceres.prominentdental.com',
    accent: 'text-amber-600',
    badge: (b) => b.ceres?.awaitingAction ?? null,
  },
  {
    key: 'mercury',
    name: 'Mercury',
    job: 'จัดซื้อ · สั่งของ',
    url: env.VITE_MERCURY_URL ?? 'https://mercury.prominentdental.com',
    accent: 'text-orange-600',
    badge: (b) => b.mercury?.pending ?? null,
  },
];

// Most-used-first display order. The supervisor's day starts in finance (verify slips) then
// the console, stock, expenses; other accounts see whichever of these they're granted, in the
// same relative order. Any app missing here sorts last (defensive; all four are listed).
const ORDER: AppKey[] = ['juno', 'jupiter', 'minerva', 'vesta', 'ceres', 'mercury'];

// The tiles this account should see: GRANTED (hasAppAccess) AND has a configured URL, in
// most-used order. Grant-gated so tiles match the person's badges exactly.
export function tilesFor(agent: Agent): AppDef[] {
  const rank = new Map(ORDER.map((k, i) => [k, i]));
  return APPS
    .filter((a) => hasAppAccess(agent, a.key) && !!a.url)
    .sort((a, b) => ((rank.get(a.key) ?? ORDER.length) - (rank.get(b.key) ?? ORDER.length)));
}
