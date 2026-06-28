import { prisma } from './prisma.js';
import { hashPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';

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
  const hashes = new Map<string, string>(); // one hash per distinct password
  let allProvisioned = true;
  for (const s of STAFF) {
    const pw = process.env[s.pwEnv];
    if (!pw) {
      allProvisioned = false;
      // eslint-disable-next-line no-console
      console.warn(`[staff] ${s.pwEnv} not set — skipping ${s.email}`);
      continue;
    }
    let passwordHash = hashes.get(pw);
    if (!passwordHash) {
      passwordHash = await hashPassword(pw);
      hashes.set(pw, passwordHash);
    }
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureSeeded failed', err);
  }
}
