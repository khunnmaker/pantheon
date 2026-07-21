// The people shown on the portal login screen, grouped into collapsible ROLE sections
// (suite login standard: no credential box until a name is tapped — then Dr. M, Nee, and Noon
// type a password; everyone else uses a masked auto-submit 6-digit PIN).
//
// Emails follow the suite convention (<slug>@prominent.local) and MUST mirror the seeded
// accounts in api/src/db/ensureSeeded.ts (TIER_ACCOUNTS + STAFF) — that seed is the single
// source of truth for who can log in. A card whose email isn't a seeded account simply can't
// log in (the api rejects it). This roster is DISPLAY only; it never sets backend roles/apps.
//
// The role GROUPS below are a login-screen grouping for humans and do NOT have to match the
// backend tier/apps. Intentional display moves vs the old flat list: นุ่น → GM, พิณ + เล็ก →
// Others (all three were formerly lumped under messengers).

export type Cred = 'password' | 'pin';   // Dr. M and both GMs use a password; everyone else a 6-digit PIN.

// Drives the cute avatar's look (feminine vs masculine hair). Display-only — nothing to do with
// auth. Sales are female, messengers are male (owner-specified); the rest are set per person.
export type Gender = 'male' | 'female';

export interface Person {
  email: string;
  label: string;
  cred: Cred;
  gender: Gender;
  // A card with no working account yet (owner provisions it later). Rendered greyed/disabled,
  // not tappable, so it can never be selected or submitted.
  comingSoon?: boolean;
}

export interface RoleGroup {
  id: string;
  label: string;        // Thai group header shown on the collapsible section.
  // Flat Metro tile accent (a solid Tailwind bg-* class) for this department's tile + banner.
  color: string;
  members: Person[];
}

const slugEmail = (slug: string) => `${slug}@prominent.local`;

// The supervisor (Dr. M) is the only "หัวหน้า" — keep this identity check for the shield/tag.
export const SUPERVISOR_EMAIL = 'drm@prominent.local';

// Collapsible role groups, in display order. Stores is intentionally empty (placeholder for
// future staff). Every email below is verified against ensureSeeded.ts except the two
// comingSoon cards, which have no account by design.
export const ROLE_GROUPS: RoleGroup[] = [
  {
    id: 'ceo',
    label: 'ผู้บริหาร (CEO)',
    color: 'bg-violet-600',
    members: [
      // Dr. P — no seeded account yet; disabled "coming soon" card (owner provisions later).
      { email: '', label: 'Dr. P', cred: 'pin', gender: 'male', comingSoon: true },
      { email: 'drm@prominent.local', label: 'Dr. M', cred: 'password', gender: 'male' },
    ],
  },
  {
    id: 'gm',
    label: 'ผู้จัดการทั่วไป (GM)',
    color: 'bg-teal-600',
    members: [
      // Legacy-but-kept email: changing Nee's Agent identity would orphan bills/audit history.
      { email: 'md@prominent.local', label: 'Nee (นี)', cred: 'password', gender: 'female' },
      { email: slugEmail('nun'), label: 'Noon (นุ่น)', cred: 'password', gender: 'female' },
    ],
  },
  {
    id: 'central',
    label: 'ส่วนกลาง (Central Office)',
    color: 'bg-cyan-600',
    members: [
      { email: slugEmail('poopae'), label: 'Poopae (ปูเป้)', cred: 'pin', gender: 'female' },
      { email: slugEmail('win'), label: 'Win (วิน)', cred: 'pin', gender: 'male' },
      { email: slugEmail('mail'), label: 'Mail (เมล)', cred: 'pin', gender: 'female' },
    ],
  },
  {
    id: 'sales',
    label: 'ฝ่ายขาย (Sales)',
    color: 'bg-emerald-600',
    members: [
      { email: slugEmail('nadeer'), label: 'NaDeer', cred: 'pin', gender: 'female' },
      { email: slugEmail('anny'), label: 'Anny', cred: 'pin', gender: 'female' },
      { email: slugEmail('noey'), label: 'Noey', cred: 'pin', gender: 'female' },
      { email: slugEmail('bow'), label: 'Bow', cred: 'pin', gender: 'female' },
      { email: slugEmail('tham'), label: 'Tham', cred: 'pin', gender: 'male' },
      { email: slugEmail('rak'), label: 'Rak', cred: 'pin', gender: 'female' },
    ],
  },
  {
    id: 'finance',
    label: 'การเงิน (Finance)',
    color: 'bg-rose-600',
    members: [
      // Benz & Meow are the finance (Juno) staff. These cards must stay in step with the
      // seeded finance accounts in api/src/db/ensureSeeded.ts (provisioned via STAFF_PINS on
      // Railway) — edit both places when finance staff change.
      { email: slugEmail('benz'), label: 'Benz', cred: 'pin', gender: 'female' },
      { email: slugEmail('meow'), label: 'Meow', cred: 'pin', gender: 'female' },
    ],
  },
  {
    id: 'messengers',
    label: 'แมสเซนเจอร์ (Messenger)',
    color: 'bg-sky-600',
    members: [
      { email: slugEmail('ta'), label: 'ต้า', cred: 'pin', gender: 'male' },
      { email: slugEmail('arm'), label: 'อาร์ม', cred: 'pin', gender: 'male' },
      { email: slugEmail('man'), label: 'แมน', cred: 'pin', gender: 'male' },
      { email: slugEmail('boonson'), label: 'บุญสอน', cred: 'pin', gender: 'male' },
      { email: slugEmail('kaew'), label: 'แก้ว', cred: 'pin', gender: 'male' },
      { email: slugEmail('lungko'), label: 'ลุงโก๊ะ', cred: 'pin', gender: 'male' },
      { email: slugEmail('wong'), label: 'วง', cred: 'pin', gender: 'male' },
      { email: slugEmail('paeng'), label: 'แป๋ง', cred: 'pin', gender: 'male' },
      { email: slugEmail('da'), label: 'ด้า', cred: 'pin', gender: 'male' },
    ],
  },
  {
    id: 'stores',
    label: 'สโตร์ (Store)',
    color: 'bg-amber-500',
    members: [], // No staff yet — clean empty state (placeholder for future staff).
  },
  {
    id: 'others',
    label: 'อื่นๆ (Others)',
    color: 'bg-fuchsia-600',
    members: [
      { email: slugEmail('pin'), label: 'พิณ', cred: 'pin', gender: 'male' },
      { email: slugEmail('lekmaeban'), label: 'เล็ก', cred: 'pin', gender: 'female' }, // seed name "เล็กแม่บ้าน", displayed "เล็ก"
    ],
  },
];
