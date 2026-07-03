import { prisma } from './prisma.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';
import { embed, embeddingsAvailable, storeKbEmbedding, kbEmbeddingText, kbTextHash } from '../memory/embeddings.js';
import { prewarmDraftCache } from '../llm/prewarm.js';
import { env } from '../env.js';

// Canonical staff list — the single source of truth for who can log in.
// Synced on every boot (see syncStaff): names/roles come from here, passwords
// from the named env var, and any account NOT listed here is removed. Passwords
// are never committed — only the env-var NAME lives in code.
//   SEED_PASSWORD  — admin/supervisor login
//   STAFF_PASSWORD — shared team (agent) login
const STAFF = [
  { email: 'drm@prominent.local', name: 'Dr. M', role: 'supervisor', pwEnv: 'SEED_PASSWORD' },
  { email: 'nadeer@prominent.local', name: 'NaDeer', role: 'agent', pwEnv: 'STAFF_PASSWORD' },
  { email: 'anny@prominent.local', name: 'Anny', role: 'agent', pwEnv: 'STAFF_PASSWORD' },
  { email: 'noey@prominent.local', name: 'Noey', role: 'agent', pwEnv: 'STAFF_PASSWORD' },
] as const;

// Weak/common 6-digit PINs — still accepted (never lock someone out over this) but
// worth a boot-log nudge to change them. Never paired with the actual value in a log.
const WEAK_PINS = new Set([
  '123456', '654321', '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999', '112233', '121212',
]);

// Parse AGENT_PINS ("name:pin,name:pin") → Map of email local-part → 6-digit PIN. Invalid
// entries are warned and skipped (a malformed env must never lock anyone out — the agent
// just falls back to STAFF_PASSWORD). Weak PINs are accepted but warned.
export function parseAgentPins(raw: string): Map<string, string> {
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
      console.warn(`[staff] AGENT_PINS entry ignored (want name:6digits): ${name || '(blank)'}:******`);
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

// Reconcile the agent table to the canonical STAFF list on boot. Idempotent:
// upserts names/roles/passwords and prunes stale logins. A missing password env
// skips just that account (never seeds a blank/default password); pruning is
// guarded so a misconfigured env can never delete the last working login.
//
// Agents may log in with a per-person PIN (AGENT_PINS) instead of the shared
// STAFF_PASSWORD; the supervisor (Dr. M) always uses SEED_PASSWORD and never
// consults the PIN map. Kept self-contained/surgical — a sibling app's boot-sync
// additions land in this file later.
async function syncStaff(): Promise<void> {
  const pins = parseAgentPins(env.AGENT_PINS);
  const emails = STAFF.map((s) => s.email);
  let allProvisioned = true;
  for (const s of STAFF) {
    const localPart = s.email.split('@')[0];
    // Agents check their PIN first, falling back to the shared STAFF_PASSWORD; the
    // supervisor is never eligible for a PIN.
    const pw = s.role === 'agent' ? (pins.get(localPart) ?? process.env[s.pwEnv]) : process.env[s.pwEnv];
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
    // Only (re)hash when the account is new or the effective password actually changed —
    // bcrypt salts differ per call, so hashing every boot would rewrite the row for
    // no reason; verifyPassword still heals a rotated password/PIN.
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
  // Prune stale accounts only once EVERY canonical account is provisioned, so the
  // old logins keep working until the new ones are fully in place (e.g. before
  // STAFF_PASSWORD is set) and a misconfigured env can never lock everyone out.
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
