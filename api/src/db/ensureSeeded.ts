import { prisma } from './prisma.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';
import { embed, embeddingsAvailable, storeKbEmbedding, kbEmbeddingText, kbTextHash } from '../memory/embeddings.js';
import { prewarmDraftCache } from '../llm/prewarm.js';

// Canonical staff list — the single source of truth for who can log in.
// Synced on every boot (see syncStaff): names/roles come from here, passwords
// from the named env var, and any account NOT listed here is removed. Passwords
// are never committed — only the env-var NAME lives in code.
//   SEED_PASSWORD     — admin/supervisor login
//   STAFF_PASSWORD    — shared team (agent) login
//   CERES_MD_PASSWORD — Nee's Ceres md login
const STAFF = [
  { email: 'drm@prominent.local', name: 'Dr. M', role: 'supervisor', pwEnv: 'SEED_PASSWORD' },
  { email: 'nadeer@prominent.local', name: 'NaDeer', role: 'agent', pwEnv: 'STAFF_PASSWORD' },
  { email: 'anny@prominent.local', name: 'Anny', role: 'agent', pwEnv: 'STAFF_PASSWORD' },
  { email: 'noey@prominent.local', name: 'Noey', role: 'agent', pwEnv: 'STAFF_PASSWORD' },
  { email: 'md@prominent.local', name: 'Nee', role: 'md', pwEnv: 'CERES_MD_PASSWORD' },
] as const;

// Canonical Ceres messenger roster — each logs in with their own PIN (see
// CERES_MESSENGER_PINS, parsed in syncMessengerPins). Exported so ensureCeres.ts
// can seed the matching CeresParty rows off the same list.
export const MESSENGERS = [
  { slug: 'ta', name: 'ต้า' },
  { slug: 'arm', name: 'อาร์ม' },
  { slug: 'man', name: 'แมน' },
  { slug: 'boonson', name: 'บุญสอน' },
  { slug: 'kaew', name: 'แก้ว' },
  { slug: 'lungko', name: 'ลุงโก๊ะ' },
  { slug: 'wong', name: 'วง' },
  { slug: 'paeng', name: 'แป๋ง' },
  { slug: 'nun', name: 'นุ่น' },
  { slug: 'nee', name: 'นี' },
  { slug: 'pin', name: 'พิณ' },
  { slug: 'lekmaeban', name: 'เล็กแม่บ้าน' },
  { slug: 'da', name: 'ด้า' },
] as const;

export const messengerEmail = (slug: string): string => `m-${slug}@prominent.local`;

// Parse "ta:123456,arm:234567,…" → { ta: "123456", arm: "234567" }. Trims whitespace,
// ignores empty segments, and warns (skips) on a malformed "slug:pin" pair.
function parseMessengerPins(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const segment of raw.split(',')) {
    const s = segment.trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    const slug = idx >= 0 ? s.slice(0, idx).trim() : '';
    const pin = idx >= 0 ? s.slice(idx + 1).trim() : '';
    if (!slug || !pin) {
      // eslint-disable-next-line no-console
      console.warn(`[staff] malformed CERES_MESSENGER_PINS segment "${s}" — skipping`);
      continue;
    }
    map.set(slug, pin);
  }
  return map;
}

// Reconcile the agent table to the canonical STAFF list on boot. Idempotent:
// upserts names/roles/passwords and prunes stale logins. A missing password env
// skips just that account (never seeds a blank/default password); pruning is
// guarded so a misconfigured env can never delete the last working login.
async function syncStaff(): Promise<void> {
  let allProvisioned = true;
  for (const s of STAFF) {
    const pw = process.env[s.pwEnv];
    if (!pw) {
      allProvisioned = false;
      // eslint-disable-next-line no-console
      console.warn(`[staff] ${s.pwEnv} not set — skipping ${s.email}`);
      continue;
    }
    const existing = await prisma.agent.findUnique({
      where: { email: s.email },
      select: { passwordHash: true },
    });
    // Only (re)hash when the account is new or the env password actually changed —
    // bcrypt salts differ per call, so hashing every boot would rewrite the row for
    // no reason; verifyPassword still heals a rotated password.
    const passwordHash =
      existing && (await verifyPassword(pw, existing.passwordHash))
        ? existing.passwordHash
        : await hashPassword(pw);
    await prisma.agent.upsert({
      where: { email: s.email },
      update: { name: s.name, role: s.role, passwordHash },
      create: { email: s.email, name: s.name, role: s.role, passwordHash },
    });
  }

  // Each messenger logs in with their own PIN (env CERES_MESSENGER_PINS, "slug:pin,…").
  // Same per-account upsert mechanism as STAFF above; a messenger with no configured
  // PIN is skipped (warn) and marks the boot as not-fully-provisioned, same safety
  // semantics as a missing STAFF password.
  const pins = parseMessengerPins(process.env.CERES_MESSENGER_PINS ?? '');
  for (const m of MESSENGERS) {
    const pin = pins.get(m.slug);
    const email = messengerEmail(m.slug);
    if (!pin) {
      allProvisioned = false;
      // eslint-disable-next-line no-console
      console.warn(`[staff] no PIN configured for messenger "${m.slug}" — skipping ${email}`);
      continue;
    }
    const existing = await prisma.agent.findUnique({
      where: { email },
      select: { passwordHash: true },
    });
    const passwordHash =
      existing && (await verifyPassword(pin, existing.passwordHash))
        ? existing.passwordHash
        : await hashPassword(pin);
    await prisma.agent.upsert({
      where: { email },
      update: { name: m.name, role: 'messenger', passwordHash },
      create: { email, name: m.name, role: 'messenger', passwordHash },
    });
  }

  // Prune stale accounts only once EVERY canonical account (STAFF + messengers) is
  // provisioned, so the old logins keep working until the new ones are fully in
  // place (e.g. before CERES_MESSENGER_PINS is set) and a misconfigured env can
  // never lock everyone out. CRITICAL: the prune list must include messenger
  // emails, or every Ceres login would be deleted on each boot.
  const emails = [...STAFF.map((s) => s.email), ...MESSENGERS.map((m) => messengerEmail(m.slug))];
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
        const vecs = await embed(batch.map((m) => kbEmbeddingText(m)), 'document');
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

    // Pre-warm the draft prompt cache so the first post-deploy draft reads a warm cache
    // instead of paying the write premium (single shot, best-effort — see prewarm.ts).
    void prewarmDraftCache();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureSeeded failed', err);
  }
}
