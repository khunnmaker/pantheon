import { prisma } from './prisma.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';
import { embed, embeddingsAvailable, storeKbEmbedding, kbEmbeddingText, kbTextHash } from '../memory/embeddings.js';
import { prewarmDraftCache } from '../llm/prewarm.js';
import { env } from '../env.js';
import { backfillProductEmbeddings } from '../catalog/productEmbeddings.js';

// Canonical staff roster — the single source of truth for who can log in.
// Synced on every boot (see syncStaff): names/roles come from here, passwords from the
// named env var(s), and any account NOT in TIER_ACCOUNTS + EMPLOYEES is removed. Passwords
// are never committed — only the env-var NAME lives in code.
//
// Four tiers (unified auth):
//   supervisor — Dr. M, implicit access to everything.
//   gm         — Nee and Noon, implicit access via GM_APPS in auth/jwt.ts (including scoped Juno).
//   agm        — assistant GMs; employee-equivalent per-person app access today.
//   employee   — all staff; per-person app access via Agent.apps (owner-edited, Pantheon's
//                admin UI — boot-sync never overwrites it on an existing row).
// `group` + `gender` are DISPLAY metadata for the suite login screens (role-grouped tiles +
// cute avatars) — they mirror Pantheon's portal grouping and have nothing to do with auth.
export const TIER_ACCOUNTS = [
  { email: 'drm@prominent.local', name: 'Dr. M', role: 'supervisor', pwEnvs: ['SEED_PASSWORD'], group: 'ceo', gender: 'male' },
  // KEEP this legacy email: Nee's Agent row id is referenced by bills/audit history; changing it would orphan it.
  { email: 'md@prominent.local', name: 'Nee', role: 'gm', pwEnvs: ['GM_PASSWORD', 'MD_PASSWORD'], group: 'gm', gender: 'female' },
  // KEEP this email: Noon's Agent row id is referenced by bills/audit history; changing it would orphan it.
  { email: 'nun@prominent.local', name: 'นุ่น', role: 'gm', pwEnvs: ['GM_PASSWORD', 'MD_PASSWORD'], group: 'gm', gender: 'female' },
] as const;

// Every employee, each with their own 6-digit PIN (EMPLOYEE_PINS) and a per-person set of
// app grants. NOTE: Nee and Noon are GM tier accounts above — they are NOT employee rows (the
// old MESSENGERS list wrongly included her under a "nee" slug; fixed here).
// `group` + `gender`: DISPLAY metadata for the login screens (see TIER_ACCOUNTS note). The
// group mirrors Pantheon's portal grouping — note นุ่น displays under GM and พิณ/เล็ก under Others.
type EmployeeSeed = {
  slug: string;
  name: string;
  apps: readonly string[];
  role?: 'agm' | 'employee';
  group: string;
  gender: 'male' | 'female';
};

export const EMPLOYEES: readonly EmployeeSeed[] = [
  { slug: 'nadeer', name: 'NaDeer', apps: ['minerva', 'ceres', 'apollo'], group: 'sales', gender: 'female' },
  { slug: 'anny', name: 'Anny', apps: ['minerva', 'ceres', 'apollo'], group: 'sales', gender: 'female' },
  { slug: 'noey', name: 'Noey', apps: ['minerva', 'ceres', 'apollo'], group: 'sales', gender: 'female' },
  { slug: 'bow', name: 'Bow', apps: ['minerva', 'ceres', 'apollo'], group: 'sales', gender: 'female' },
  { slug: 'tham', name: 'Tham', apps: ['minerva', 'ceres', 'apollo'], group: 'sales', gender: 'male' },
  { slug: 'rak', name: 'Rak', apps: ['minerva', 'ceres', 'apollo'], group: 'sales', gender: 'female' },
  { slug: 'ta', name: 'ต้า', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'arm', name: 'อาร์ม', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'man', name: 'แมน', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'boonson', name: 'บุญสอน', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'kaew', name: 'แก้ว', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'lungko', name: 'ลุงโก๊ะ', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'wong', name: 'วง', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'paeng', name: 'แป๋ง', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  { slug: 'poopae', name: 'ปูเป้', apps: ['minerva', 'ceres', 'apollo'], role: 'agm', group: 'agm', gender: 'female' },
  { slug: 'win', name: 'วิน', apps: ['minerva', 'ceres', 'apollo'], role: 'agm', group: 'agm', gender: 'male' },
  { slug: 'mail', name: 'เมล', apps: ['minerva', 'ceres', 'apollo'], role: 'agm', group: 'agm', gender: 'female' },
  { slug: 'pin', name: 'พิณ', apps: ['ceres', 'apollo'], group: 'others', gender: 'male' },
  { slug: 'lekmaeban', name: 'เล็กแม่บ้าน', apps: ['ceres', 'apollo'], group: 'others', gender: 'female' }, // housekeeper — enters expenses like everyone
  { slug: 'da', name: 'ด้า', apps: ['ceres', 'apollo'], group: 'messengers', gender: 'male' },
  // Finance team (การเงิน) — owner-granted Minerva + Juno + Ceres (2026-07-05). Juno's route
  // gate was widened from supervisor-only to requireApp('juno') so the juno grant admits them.
  { slug: 'benz', name: 'Benz', apps: ['minerva', 'juno', 'ceres', 'apollo'], group: 'finance', gender: 'female' },
  { slug: 'meow', name: 'Meow', apps: ['minerva', 'juno', 'ceres', 'apollo'], group: 'finance', gender: 'female' },
];

export const employeeEmail = (slug: string): string => `${slug}@prominent.local`;

// Weak/common 6-digit PINs — still accepted (never lock someone out over this) but
// worth a boot-log nudge to change them. Never paired with the actual value in a log.
const WEAK_PINS = new Set([
  '123456', '654321', '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999', '112233', '121212',
]);

// Parse a PIN map env ("name:pin,name:pin") → Map of key → 6-digit PIN. Used for EMPLOYEE_PINS
// (all EMPLOYEES entries, keyed by slug) and the deprecated AGENT_PINS transition fallback. Invalid
// entries are warned and skipped (a malformed env must never lock anyone out). Weak PINs are
// accepted but warned.
export function parseAgentPins(raw: string, label = 'AGENT_PINS'): Map<string, string> {
  const pins = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue; // trailing/double comma — ignore silently
    const idx = trimmed.indexOf(':');
    const name = idx === -1 ? trimmed : trimmed.slice(0, idx);
    const pin = idx === -1 ? '' : trimmed.slice(idx + 1);
    if (!name || !/^\d{6}$/.test(pin)) {
      // Never log the raw entry — it may contain a real (if malformed-context) PIN.
      // eslint-disable-next-line no-console
      console.warn(`[staff] ${label} entry ignored (want name:6digits): ${name || '(blank)'}:******`);
      continue;
    }
    if (WEAK_PINS.has(pin)) {
      // eslint-disable-next-line no-console
      console.warn(`[staff] weak PIN for ${name} — consider changing it`);
    }
    pins.set(name, pin);
  }
  return pins;
}

// Reconcile the agent table to the canonical roster (TIER_ACCOUNTS + EMPLOYEES) on boot.
// Idempotent: upserts names/roles/passwords and prunes stale logins. A missing password/PIN
// skips just that account (never seeds a blank/default password); pruning is guarded so a
// misconfigured env can never delete the last working login.
//
// Staff credentials come from env: SEED_PASSWORD (Dr. M), GM_PASSWORD or fallback MD_PASSWORD
// (Nee and Noon), EMPLOYEE_PINS (all
// employees, "slug:pin,…"). An account with no configured secret is skipped — never seeded with
// a blank/default — and a fully-unprovisioned env can never prune/lock everyone out (see the
// allProvisioned guard below). The old AGENT_PINS / STAFF_PASSWORD / CERES_MD_PASSWORD transition
// fallbacks were removed 2026-07-07 once the new vars were confirmed live on Railway.
export async function syncStaff(): Promise<void> {
  let allProvisioned = true;

  // Tier accounts (supervisor, gm).
  for (const t of TIER_ACCOUNTS) {
    // First configured env wins, so GM_PASSWORD supersedes the legacy MD_PASSWORD fallback.
    const pw = t.pwEnvs.map((name) => process.env[name]).find(Boolean) || undefined;
    if (!pw) {
      allProvisioned = false;
      // eslint-disable-next-line no-console
      console.warn(`[staff] ${t.pwEnvs.join('/')} not set — skipping ${t.email}`);
      continue;
    }
    const existing = await prisma.agent.findUnique({
      where: { email: t.email },
      select: { passwordHash: true },
    });
    // Only (re)hash when the account is new or the effective password actually changed —
    // bcrypt salts differ per call, so hashing every boot would rewrite the row for
    // no reason; verifyPassword still heals a rotated password.
    const passwordHash =
      existing && (await verifyPassword(pw, existing.passwordHash))
        ? existing.passwordHash
        : await hashPassword(pw);
    await prisma.agent.upsert({
      where: { email: t.email },
      // apps is never touched on update — Pantheon's admin UI owns it for existing rows.
      update: { name: t.name, role: t.role, passwordHash },
      create: { email: t.email, name: t.name, role: t.role, passwordHash, apps: [] },
    });
  }

  // Employees, each with their own 6-digit PIN and per-person app grants. Accept BOTH the
  // current EMPLOYEE_PINS and the legacy AGENT_PINS name (some deployments never renamed the
  // Railway var): start from AGENT_PINS, then overlay EMPLOYEE_PINS so the canonical name wins
  // on any slug that appears in both. Either var alone fully provisions the roster.
  const employeePins = parseAgentPins(env.AGENT_PINS, 'AGENT_PINS');
  for (const [slug, pin] of parseAgentPins(env.EMPLOYEE_PINS, 'EMPLOYEE_PINS')) {
    employeePins.set(slug, pin);
  }
  if (employeePins.delete('nun')) {
    // eslint-disable-next-line no-console
    console.warn('[staff] PIN entry for "nun" is deprecated and ignored; Noon uses GM_PASSWORD');
  }
  for (const e of EMPLOYEES) {
    const email = employeeEmail(e.slug);
    const pin = employeePins.get(e.slug);
    if (!pin) {
      allProvisioned = false;
      // eslint-disable-next-line no-console
      console.warn(`[staff] no PIN configured for employee "${e.slug}" — skipping ${email}`);
      continue;
    }
    const existing = await prisma.agent.findUnique({
      where: { email },
      select: { passwordHash: true, apps: true },
    });
    const passwordHash =
      existing && (await verifyPassword(pin, existing.passwordHash))
        ? existing.passwordHash
        : await hashPassword(pin);
    // apps: the roster declaration is the FLOOR of a person's grants — every app listed in
    // EMPLOYEES is applied as a UNION with whatever is already on the row (ADDITIVE: a declared
    // grant is always present, but any extra grant added out-of-band survives). This lets an
    // owner-requested grant change (edit EMPLOYEES) actually propagate to existing rows, while
    // never removing a grant on deploy — so no one is ever locked out. To REVOKE, remove the
    // app from EMPLOYEES here (it stops being re-added) or pull the PIN to kill the login entirely.
    const mergedApps = existing
      ? Array.from(new Set([...existing.apps, ...e.apps]))
      : [...e.apps];
    const appsGrew = existing !== null && mergedApps.length > existing.apps.length;
    await prisma.agent.upsert({
      where: { email },
      update: { name: e.name, role: e.role ?? 'employee', passwordHash, apps: mergedApps },
      create: { email, name: e.name, role: e.role ?? 'employee', passwordHash, apps: [...e.apps] },
    });
    if (appsGrew) {
      // eslint-disable-next-line no-console
      console.log(`[staff] applied declared app grants for "${e.slug}" → ${mergedApps.join(', ')}`);
    }
  }

  // Prune stale accounts only once EVERY canonical account (tier accounts + employees) is
  // provisioned, so old logins keep working until the new ones are fully in place (e.g.
  // before EMPLOYEE_PINS is set) and a misconfigured env can never lock everyone out.
  const emails = [...TIER_ACCOUNTS.map((t) => t.email), ...EMPLOYEES.map((e) => employeeEmail(e.slug))];
  if (allProvisioned) {
    const { count } = await prisma.agent.deleteMany({ where: { email: { notIn: emails } } });
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[staff] removed ${count} stale account(s)`);
    }
  }
}

// Populate an EMPTY production database on boot so a fresh cloud deploy is usable
// without a manual seed step. KB loads only when empty; staff are reconciled to
// Backfill missing/stale KB embeddings (best-effort, batched). Repairs two cases: a row with
// no embedding yet (kb_embedding table populated post-hoc, or a new entry whose embed failed)
// AND a row whose stored text_hash no longer matches the entry's current text — a stale vector
// left behind by a re-embed that was lost (deploy mid-flight, bulk KB reload, failed delete).
// Fetches all active entries (KB is ~50-100 rows) and filters in JS; idempotent, so it's a
// near no-op once every active entry's hash is current.
export async function backfillKbEmbeddings(): Promise<void> {
  if (!embeddingsAvailable()) return;
  try {
    const all = await prisma.$queryRaw<
      { id: string; questionVariants: string[]; answer: string; text_hash: string | null }[]
    >`
      SELECT k.id, k."questionVariants", k.answer, ke.text_hash
      FROM "KbEntry" k
      LEFT JOIN kb_embedding ke ON ke.kb_id = k.id
      WHERE k.status = 'active'`;
    const stale = all.filter((row) => {
      const hash = kbTextHash(kbEmbeddingText(row));
      return row.text_hash == null || row.text_hash !== hash;
    });
    if (!stale.length) return;
    const CHUNK = 64; // bound the Voyage request payload
    let done = 0;
    for (let i = 0; i < stale.length; i += CHUNK) {
      const batch = stale.slice(i, i + CHUNK);
      try {
        const vecs = await embed(
          batch.map((m) => kbEmbeddingText(m)),
          'document',
          undefined,
          { app: 'minerva', feature: 'kb-embed' },
        );
        // allSettled + the vecs[j] guard so one bad row/store never aborts the whole run;
        // anything left unembedded is just retried on the next boot.
        const results = await Promise.allSettled(
          batch.map((m, j) =>
            vecs[j] ? storeKbEmbedding(m.id, vecs[j], kbTextHash(kbEmbeddingText(m))) : Promise.reject(new Error('no vector')),
          ),
        );
        done += results.filter((r) => r.status === 'fulfilled').length;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[seed] KB embedding chunk failed (will retry next boot)', err);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[seed] backfilled ${done}/${stale.length} KB embeddings`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] KB embedding backfill failed', err);
  }
}

// the canonical list every boot (see syncStaff).
// The group's companies — the JupiterCompany dimension for the accounting layer. This
// FORMALISES the ad-hoc `entity` code (PROM|DENL) already on CeresExpense/CashMovement into
// the full group. CREATE-IF-MISSING only (update:{}), so once a row exists the supervisor can
// freely rename / recolour it without a boot overwriting changes. APPT is retained as an
// inactive paper-only legal entity and deliberately stays outside GROUP_COMPANY_CODES.
// (DENL/KPKF kind + KPKF Thai name left blank pending owner confirmation.)
const JUPITER_COMPANIES = [
  { code: 'PROM', name: 'Prominent', nameTh: 'พรอมิเนนต์', kind: 'distribution', color: '#0EA5E9', sortOrder: 1 },
  { code: 'TONR', name: 'Tonmai Residence', nameTh: 'ต้นไม้ เรสซิเดนซ์', kind: 'property', color: '#16A34A', sortOrder: 2 },
  { code: 'DENC', name: 'DentalPort Dental Clinic', nameTh: 'เดนทัลพอร์ต คลินิกทันตกรรม', kind: 'clinic', color: '#8B5CF6', sortOrder: 3 },
  { code: 'DENL', name: 'DentalPort', nameTh: 'เดนทัลพอร์ต', kind: 'lab', color: '#EC4899', sortOrder: 4 },
  { code: 'KPKF', name: 'Khun Phua Khun', nameTh: '', kind: 'manufacturing', color: '#F59E0B', sortOrder: 5 }, // factory — fabricates product for PROM
  {
    code: 'APPT', name: 'Appoint Alliance', nameTh: 'แอพพอยท์ อัลไลแอนซ์', kind: 'holding',
    color: '#64748B', sortOrder: 6, active: false, ledgerMode: 'paper_only',
  },
];

async function syncCompanies(): Promise<void> {
  for (const c of JUPITER_COMPANIES) {
    await prisma.jupiterCompany.upsert({ where: { code: c.code }, update: {}, create: c });
  }
}

export async function ensureSeeded(): Promise<void> {
  try {
    if ((await prisma.kbEntry.count({ where: { status: 'active' } })) === 0) {
      for (const k of HISTORY_KB) {
        await prisma.kbEntry.upsert({
          where: { id: k.id },
          update: {},
          create: {
            id: k.id,
            category: k.category,
            questionVariants: k.questionVariants,
            answer: k.answer,
            sensitivity: k.sensitivity,
            status: 'active',
            source: 'chat-history',
          },
        });
      }
      // eslint-disable-next-line no-console
      console.log(`[seed] loaded ${HISTORY_KB.length} KB entries`);
    }

    await syncStaff();
    await syncCompanies();

    // Release orphaned promote claims: a row stuck at 'promoting' at BOOT can only be a leftover
    // from a crash mid-promote (no request can still be in flight at boot) — reset it to
    // 'pending' so the item reappears in the supervisor queue instead of vanishing forever.
    const stuck = await prisma.learnedAnswer.updateMany({ where: { status: 'promoting' }, data: { status: 'pending' } });
    if (stuck.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[seed] released ${stuck.count} stuck promote claim(s)`);
    }

    // Populate any missing KB embeddings in the background (never blocks boot/readiness).
    void backfillKbEmbeddings();
    // Diana's product index follows the same fail-soft, idempotent boot-backfill pattern.
    void backfillProductEmbeddings();

    // Pre-warm the draft prompt cache so the first post-deploy draft reads a warm cache
    // instead of paying the write premium (single shot, best-effort — see prewarm.ts).
    void prewarmDraftCache();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureSeeded failed', err);
  }
}
