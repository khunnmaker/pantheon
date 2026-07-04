import type { Agent, AppName, Badges } from './api';

// The deities the portal can launch. `url` is read from build-time env so the
// Railway→custom-domain cutover (Phase 2) is an env edit, not a code change; a tile with
// an unset URL is hidden even if the caller could enter it (e.g. before the service exists).
//
// Post unified-auth (PR #7): tile visibility is a PER-PERSON grant, not a role list — it must
// match exactly what the caller can open (and what /api/jupiter/badges returns). hasAppAccess()
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
    key: 'minerva',
    name: 'Minerva',
    job: 'ตอบแชทลูกค้า LINE',
    url: env.VITE_MINERVA_URL,
    accent: 'text-sky-600',
    badge: (b) => b.minerva?.pending ?? null,
  },
  {
    key: 'juno',
    name: 'Juno',
    job: 'การเงิน · ตรวจสลิป',
    url: env.VITE_JUNO_URL,
    accent: 'text-emerald-600',
    badge: (b) => b.juno?.toVerify ?? null,
  },
  {
    key: 'vulcan',
    name: 'Vulcan',
    job: 'จัดการสต็อกสินค้า',
    url: env.VITE_VULCAN_URL,
    accent: 'text-indigo-600',
    badge: (b) => b.vulcan?.lowStock ?? null,
  },
  {
    key: 'ceres',
    name: 'Ceres',
    job: 'ค่าใช้จ่าย · เงินสดย่อย',
    url: env.VITE_CERES_URL,
    accent: 'text-amber-600',
    badge: (b) => b.ceres?.awaitingAction ?? null,
  },
];

// Mirrors api/src/auth/jwt.ts hasAppAccess: supervisor → everything; md → ceres only;
// employee → their own per-person `apps` grant. Keep in lock-step with the server so a tile
// only ever appears when the same account would pass requireApp on that app's routes.
export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'md') return app === 'ceres';
  return (agent.apps ?? []).includes(app);
}

// Most-used-first display order. The supervisor's day starts in finance (verify slips) then
// the console, stock, expenses; other accounts see whichever of these they're granted, in the
// same relative order. Any app missing here sorts last (defensive; all four are listed).
const ORDER: AppKey[] = ['juno', 'minerva', 'vulcan', 'ceres'];

// The tiles this account should see: GRANTED (hasAppAccess) AND has a configured URL, in
// most-used order. Grant-gated so tiles match the person's badges exactly.
export function tilesFor(agent: Agent): AppDef[] {
  const rank = new Map(ORDER.map((k, i) => [k, i]));
  return APPS
    .filter((a) => hasAppAccess(agent, a.key) && !!a.url)
    .sort((a, b) => ((rank.get(a.key) ?? ORDER.length) - (rank.get(b.key) ?? ORDER.length)));
}
