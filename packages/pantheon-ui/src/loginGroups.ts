// Fixed role-group metadata for the suite login screens — the SAME Thai labels + Metro tile
// colors as the Pantheon portal (pantheon/src/lib/roster.ts). Login cards come from the server
// (GET /api/auth/logins?app=… — each card carries a `group` id); this file only decides the
// display label, tile color, and the fixed order the groups render in. A card whose `group` isn't
// in GROUP_META is bucketed under "others" so nobody ever disappears.

export interface GroupMeta {
  id: string;
  label: string; // Thai group header shown on the L1 tile + L2/L3 banner.
  color: string; // Flat Metro tile accent (a solid Tailwind bg-* class).
}

// Display order is fixed; empty groups are omitted at render time.
export const GROUP_META: GroupMeta[] = [
  { id: 'ceo', label: 'ผู้บริหาร (CEO)', color: 'bg-violet-600' },
  { id: 'md', label: 'MD', color: 'bg-teal-600' },
  { id: 'sales', label: 'ฝ่ายขาย (Sales)', color: 'bg-emerald-600' },
  { id: 'finance', label: 'การเงิน (Finance)', color: 'bg-rose-600' },
  { id: 'messengers', label: 'แมสเซนเจอร์', color: 'bg-sky-600' },
  { id: 'stores', label: 'สโตร์', color: 'bg-amber-500' },
  { id: 'others', label: 'อื่นๆ', color: 'bg-fuchsia-600' },
];

const OTHERS = GROUP_META.find((g) => g.id === 'others')!;

export interface GroupedLogins<T> {
  meta: GroupMeta;
  members: T[];
}

// Bucket fetched cards into GROUP_META order, dropping empty groups. Any card whose `group` isn't
// a known GROUP_META id falls into "others".
export function groupLogins<T extends { group: string }>(cards: T[]): GroupedLogins<T>[] {
  const byId = new Map<string, T[]>();
  for (const card of cards) {
    const id = GROUP_META.some((g) => g.id === card.group) ? card.group : OTHERS.id;
    const list = byId.get(id);
    if (list) list.push(card);
    else byId.set(id, [card]);
  }
  return GROUP_META.map((meta) => ({ meta, members: byId.get(meta.id) ?? [] })).filter(
    (g) => g.members.length > 0,
  );
}
