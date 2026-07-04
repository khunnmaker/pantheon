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

// MD (Nee) — 6-digit PIN. Ceres role; account lands with Ceres go-live.
export const MD: Person = { email: 'nee@prominent.local', label: 'Nee (MD)', cred: 'pin' };

// Messengers (คนส่งของ, Ceres) — 6-digit PIN. Collapsed under "ทีมแมสเซนเจอร์" so the flat
// list stays short. Names per docs/CERES_BRIEF.md.
export const MESSENGERS: Person[] = [
  { email: 'ta@prominent.local', label: 'ต้า', cred: 'pin' },
  { email: 'arm@prominent.local', label: 'อาร์ม', cred: 'pin' },
  { email: 'man@prominent.local', label: 'แมน', cred: 'pin' },
  { email: 'boonsorn@prominent.local', label: 'บุญสอน', cred: 'pin' },
  { email: 'kaew@prominent.local', label: 'แก้ว', cred: 'pin' },
  { email: 'lungkoh@prominent.local', label: 'ลุงโก๊ะ', cred: 'pin' },
  { email: 'wong@prominent.local', label: 'วง', cred: 'pin' },
  { email: 'paeng@prominent.local', label: 'แป๋ง', cred: 'pin' },
  { email: 'nun@prominent.local', label: 'นุ่น', cred: 'pin' },
  { email: 'nee-msg@prominent.local', label: 'นี', cred: 'pin' },
  { email: 'messenger11@prominent.local', label: 'แมสเซนเจอร์ 11', cred: 'pin' },
  { email: 'messenger12@prominent.local', label: 'แมสเซนเจอร์ 12', cred: 'pin' },
  { email: 'messenger13@prominent.local', label: 'แมสเซนเจอร์ 13', cred: 'pin' },
];
