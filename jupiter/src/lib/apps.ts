import type { Badges, Role } from './api';

// The deities the portal can launch. `url` is read from build-time env so the
// Railway→custom-domain cutover (Phase 2) is an env edit, not a code change; a tile with
// an unset URL is hidden even if the role could enter it (e.g. before the service exists).
// `enter` mirrors the api's badge gating (who may open each app). `order` is most-used-first
// per role and is resolved in tileOrderFor() below.

export type AppKey = 'minerva' | 'vulcan' | 'juno' | 'ceres';

export interface AppDef {
  key: AppKey;
  name: string;          // deity name
  job: string;           // Thai job label
  url: string | undefined;
  enter: Role[];         // roles allowed to open it (matches /api/jupiter/badges gating)
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
    enter: ['agent', 'supervisor'],
    accent: 'text-sky-600',
    badge: (b) => b.minerva?.pending ?? null,
  },
  {
    key: 'juno',
    name: 'Juno',
    job: 'การเงิน · ตรวจสลิป',
    url: env.VITE_JUNO_URL,
    enter: ['supervisor'],
    accent: 'text-emerald-600',
    badge: (b) => b.juno?.toVerify ?? null,
  },
  {
    key: 'vulcan',
    name: 'Vulcan',
    job: 'จัดการสต็อกสินค้า',
    url: env.VITE_VULCAN_URL,
    enter: ['supervisor'],
    accent: 'text-indigo-600',
    badge: (b) => b.vulcan?.lowStock ?? null,
  },
  {
    key: 'ceres',
    name: 'Ceres',
    job: 'ค่าใช้จ่าย · เงินสดย่อย',
    url: env.VITE_CERES_URL,
    enter: ['supervisor'],
    accent: 'text-amber-600',
    badge: (b) => b.ceres?.awaitingAction ?? null,
  },
];

// Most-used-first tile order per role. Agents live in Minerva all day; the supervisor's day
// starts in finance (verify slips) then the console, stock, expenses.
const ORDER: Record<Role, AppKey[]> = {
  agent: ['minerva'],
  supervisor: ['juno', 'minerva', 'vulcan', 'ceres'],
};

// The tiles a role should see: allowed to enter AND has a configured URL, in most-used order.
export function tilesFor(role: Role): AppDef[] {
  const rank = new Map(ORDER[role].map((k, i) => [k, i]));
  return APPS
    .filter((a) => a.enter.includes(role) && !!a.url && rank.has(a.key))
    .sort((a, b) => (rank.get(a.key)! - rank.get(b.key)!));
}
