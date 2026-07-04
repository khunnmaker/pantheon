// The people shown on the portal login screen (suite login standard: a card list of
// people — supervisor on top, team beneath — no credential box until a name is tapped;
// then Dr. M types a password, everyone else a masked auto-submit 6-digit PIN).
//
// Emails follow the suite convention (name@prominent.local). Accounts are provisioned in the
// api's seed/env (SEED_PASSWORD for Dr. M; AGENT_PINS / CERES_MESSENGER_PINS for the rest) —
// this roster is only the login UI; a person whose account isn't provisioned yet simply
// can't log in (the api rejects the credentials), which is correct for Phase 1.

export type Cred = 'password' | 'pin';   // Dr. M uses a password; everyone else a 6-digit PIN.

export interface Person {
  email: string;
  label: string;
  cred: Cred;
}

// Supervisor (CEO) — password only, NEVER a PIN (security constraint, brief §8).
export const SUPERVISOR: Person = { email: 'drm@prominent.local', label: 'Dr. M', cred: 'password' };

// Sales agents (Minerva) — 6-digit PIN.
export const AGENTS: Person[] = [
  { email: 'nadeer@prominent.local', label: 'NaDeer', cred: 'pin' },
  { email: 'anny@prominent.local', label: 'Anny', cred: 'pin' },
  { email: 'noey@prominent.local', label: 'Noey', cred: 'pin' },
];

// MD (Nee) — password (env CERES_MD_PASSWORD). Ceres 'md' role. Email + cred MUST match
// the seeded STAFF row in api/src/db/ensureSeeded.ts, or the login just fails.
export const MD: Person = { email: 'md@prominent.local', label: 'Nee (MD)', cred: 'password' };

// Messengers (คนส่งของ, Ceres) — 6-digit PIN. Collapsed under "ทีมแมสเซนเจอร์" so the flat
// list stays short. This list MUST mirror MESSENGERS + messengerEmail() in
// api/src/db/ensureSeeded.ts (slug → m-<slug>@prominent.local) so each card maps to a real
// seeded account; a person not in that seed simply can't log in.
export const MESSENGERS: Person[] = [
  { email: 'm-ta@prominent.local', label: 'ต้า', cred: 'pin' },
  { email: 'm-arm@prominent.local', label: 'อาร์ม', cred: 'pin' },
  { email: 'm-man@prominent.local', label: 'แมน', cred: 'pin' },
  { email: 'm-boonson@prominent.local', label: 'บุญสอน', cred: 'pin' },
  { email: 'm-kaew@prominent.local', label: 'แก้ว', cred: 'pin' },
  { email: 'm-lungko@prominent.local', label: 'ลุงโก๊ะ', cred: 'pin' },
  { email: 'm-wong@prominent.local', label: 'วง', cred: 'pin' },
  { email: 'm-paeng@prominent.local', label: 'แป๋ง', cred: 'pin' },
  { email: 'm-nun@prominent.local', label: 'นุ่น', cred: 'pin' },
  { email: 'm-nee@prominent.local', label: 'นี', cred: 'pin' },
  { email: 'm-pin@prominent.local', label: 'พิณ', cred: 'pin' },
  { email: 'm-lekmaeban@prominent.local', label: 'เล็กแม่บ้าน', cred: 'pin' },
  { email: 'm-da@prominent.local', label: 'ด้า', cred: 'pin' },
];
