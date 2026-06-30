import { prisma } from './prisma.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';
import { embed, embeddingsAvailable, storeKbEmbedding, kbEmbeddingText } from '../memory/embeddings.js';

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

// Reconcile the agent table to the canonical STAFF list on boot. Idempotent:
// upserts names/roles/passwords and prunes stale logins. A missing password env
// skips just that account (never seeds a blank/default password); pruning is
// guarded so a misconfigured env can never delete the last working login.
async function syncStaff(): Promise<void> {
  const emails = STAFF.map((s) => s.email);
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
// Backfill missing KB embeddings (best-effort, batched). The kb_embedding table exists from
// the M3 pgvector migration but was never populated; semantic retrieval needs it. Idempotent:
// only embeds active entries that have no row yet, so it's a near no-op after the first run.
async function backfillKbEmbeddings(): Promise<void> {
  if (!embeddingsAvailable()) return;
  try {
    const missing = await prisma.$queryRaw<{ id: string; questionVariants: string[]; answer: string }[]>`
      SELECT k.id, k."questionVariants", k.answer
      FROM "KbEntry" k
      LEFT JOIN kb_embedding ke ON ke.kb_id = k.id
      WHERE k.status = 'active' AND ke.kb_id IS NULL`;
    if (!missing.length) return;
    const CHUNK = 64; // bound the Voyage request payload
    let done = 0;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const batch = missing.slice(i, i + CHUNK);
      try {
        const vecs = await embed(batch.map((m) => kbEmbeddingText(m)), 'document');
        // allSettled + the vecs[j] guard so one bad row/store never aborts the whole run;
        // anything left unembedded is just retried on the next boot.
        const results = await Promise.allSettled(
          batch.map((m, j) => (vecs[j] ? storeKbEmbedding(m.id, vecs[j]) : Promise.reject(new Error('no vector')))),
        );
        done += results.filter((r) => r.status === 'fulfilled').length;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[seed] KB embedding chunk failed (will retry next boot)', err);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[seed] backfilled ${done}/${missing.length} KB embeddings`);
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
    // Populate any missing KB embeddings in the background (never blocks boot/readiness).
    void backfillKbEmbeddings();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureSeeded failed', err);
  }
}
