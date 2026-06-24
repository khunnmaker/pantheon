import { prisma } from '../db/prisma.js';
import { hashPassword } from '../auth/password.js';
import { HISTORY_KB } from '../kb/historyKb.js';

// Shared password for seeded staff. Defaults to the demo password for local dev;
// set SEED_PASSWORD to a strong value before exposing the app to the internet.
const DEV_PASSWORD = process.env.SEED_PASSWORD || 'prominent123';

const STAFF = [
  { email: 'mind@prominent.local', name: 'คุณมายด์', role: 'agent' },
  { email: 'fah@prominent.local', name: 'คุณฟ้า', role: 'agent' },
  { email: 'nadeer@prominent.local', name: 'NaDeer', role: 'supervisor' },
] as const;

async function main() {
  const passwordHash = await hashPassword(DEV_PASSWORD);

  for (const s of STAFF) {
    await prisma.agent.upsert({
      where: { email: s.email },
      update: { name: s.name, role: s.role, passwordHash },
      create: { email: s.email, name: s.name, role: s.role, passwordHash },
    });
    // eslint-disable-next-line no-console
    console.log(`seeded ${s.role.padEnd(10)} ${s.email}  (${s.name})`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nDev password for all accounts: ${DEV_PASSWORD}`);

  // Retire any leftover placeholder sample KB (source 'manual') so it can't feed drafts.
  const archived = await prisma.kbEntry.updateMany({
    where: { source: 'manual', status: 'active' },
    data: { status: 'archived' },
  });
  if (archived.count) {
    // eslint-disable-next-line no-console
    console.log(`archived ${archived.count} placeholder sample KB entries`);
  }

  // Real knowledge base distilled from chat history (idempotent by fixed id).
  // NOTE: this re-applies the canonical answers — run it for initial setup, not
  // after supervisors have edited entries in the console (it would overwrite them).
  for (const k of HISTORY_KB) {
    await prisma.kbEntry.upsert({
      where: { id: k.id },
      update: {
        category: k.category,
        questionVariants: k.questionVariants,
        answer: k.answer,
        sensitivity: k.sensitivity,
        status: 'active',
        source: 'chat-history',
        lastVerifiedAt: new Date(),
      },
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
  console.log(`seeded ${HISTORY_KB.length} KB entries (chat-history)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
