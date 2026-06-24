import { prisma } from './prisma.js';
import { hashPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';

const STAFF = [
  { email: 'mind@prominent.local', name: 'คุณมายด์', role: 'agent' },
  { email: 'fah@prominent.local', name: 'คุณฟ้า', role: 'agent' },
  { email: 'nadeer@prominent.local', name: 'NaDeer', role: 'supervisor' },
] as const;

// Populate an EMPTY production database on boot so a fresh cloud deploy is usable
// without a manual seed step. Guarded by emptiness checks + upserts, so it never
// overwrites entries a supervisor later edits in the console. Staff creation waits
// until SEED_PASSWORD is set (avoids ever seeding a weak default password).
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

    if ((await prisma.agent.count()) === 0) {
      const pw = process.env.SEED_PASSWORD;
      if (!pw) {
        // eslint-disable-next-line no-console
        console.warn('[seed] SEED_PASSWORD not set — skipping staff creation (set it to create logins)');
      } else {
        const passwordHash = await hashPassword(pw);
        for (const s of STAFF) {
          await prisma.agent.upsert({
            where: { email: s.email },
            update: {},
            create: { email: s.email, name: s.name, role: s.role, passwordHash },
          });
        }
        // eslint-disable-next-line no-console
        console.log(`[seed] created ${STAFF.length} staff accounts`);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureSeeded failed', err);
  }
}
