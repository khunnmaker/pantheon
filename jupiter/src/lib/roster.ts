// The people shown on the portal login screen, grouped into collapsible ROLE sections
// (suite login standard: no credential box until a name is tapped — then Dr. M & Nee-MD type a
// password, everyone else a masked auto-submit 6-digit PIN).
//
// Emails follow the suite convention (<slug>@prominent.local) and MUST mirror the seeded
// accounts in api/src/db/ensureSeeded.ts (TIER_ACCOUNTS + EMPLOYEES) — that seed is the single
// source of truth for who can log in. A card whose email isn't a seeded account simply can't
// log in (the api rejects it). This roster is DISPLAY only; it never sets backend roles/apps.
//
// The role GROUPS below are a login-screen grouping for humans and do NOT have to match the
// backend tier/apps. Intentional display moves vs the old flat list: นุ่น → MD, พิณ + เล็ก →
// Others (all three were formerly lumped under messengers).

export type Cred = 'password' | 'pin';   // Dr. M & Nee (MD) use a password; everyone else a 6-digit PIN.

export interface Person {
  email: string;
  label: string;
  cred: Cred;
  // A card with no working account yet (owner provisions it later). Rendered greyed/disabled,
  // not tappable, so it can never be selected or submitted.
  comingSoon?: boolean;
}

export interface RoleGroup {
  id: string;
  label: string;        // Thai group header shown on the collapsible section.
  members: Person[];
}

const slugEmail = (slug: string) => `${slug}@prominent.local`;

// The supervisor (Dr. M) is the only "หัวหน้า" — keep this identity check for the shield/tag.
export const SUPERVISOR_EMAIL = 'drm@prominent.local';

// 6 collapsible role groups, in display order. Stores is intentionally empty (placeholder for
// future staff). Every email below is verified against ensureSeeded.ts except the two
// comingSoon cards, which have no account by design.
export const ROLE_GROUPS: RoleGroup[] = [
  {
    id: 'ceo',
    label: 'ผู้บริหาร (CEO)',
    members: [
      // Dr. P — no seeded account yet; disabled "coming soon" card (owner provisions later).
      { email: '', label: 'Dr. P', cred: 'pin', comingSoon: true },
      { email: 'drm@prominent.local', label: 'Dr. M', cred: 'password' },
    ],
  },
  {
    id: 'md',
    label: 'MD',
    members: [
      { email: 'md@prominent.local', label: 'Nee (นี)', cred: 'password' },
      { email: slugEmail('nun'), label: 'Noon (นุ่น)', cred: 'pin' },
    ],
  },
  {
    id: 'sales',
    label: 'ฝ่ายขาย (Sales)',
    members: [
      { email: slugEmail('nadeer'), label: 'NaDeer', cred: 'pin' },
      { email: slugEmail('anny'), label: 'Anny', cred: 'pin' },
      { email: slugEmail('noey'), label: 'Noey', cred: 'pin' },
    ],
  },
  {
    id: 'messengers',
    label: 'แมสเซนเจอร์',
    members: [
      { email: slugEmail('ta'), label: 'ต้า', cred: 'pin' },
      { email: slugEmail('arm'), label: 'อาร์ม', cred: 'pin' },
      { email: slugEmail('man'), label: 'แมน', cred: 'pin' },
      { email: slugEmail('boonson'), label: 'บุญสอน', cred: 'pin' },
      { email: slugEmail('kaew'), label: 'แก้ว', cred: 'pin' },
      { email: slugEmail('lungko'), label: 'ลุงโก๊ะ', cred: 'pin' },
      { email: slugEmail('wong'), label: 'วง', cred: 'pin' },
      { email: slugEmail('paeng'), label: 'แป๋ง', cred: 'pin' },
      { email: slugEmail('da'), label: 'ด้า', cred: 'pin' },
    ],
  },
  {
    id: 'stores',
    label: 'สโตร์',
    members: [], // No staff yet — clean empty state (placeholder for future staff).
  },
  {
    id: 'others',
    label: 'อื่นๆ',
    members: [
      { email: slugEmail('pin'), label: 'พิณ', cred: 'pin' },
      { email: slugEmail('lekmaeban'), label: 'เล็ก', cred: 'pin' }, // seed name "เล็กแม่บ้าน", displayed "เล็ก"
    ],
  },
];
