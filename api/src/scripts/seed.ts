import { prisma } from '../db/prisma.js';
import { hashPassword } from '../auth/password.js';
import { SAMPLE_KB } from '../kb/sampleKb.js';

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

  // Sample knowledge base (idempotent by fixed id). Replace with real FAQs later.
  for (const k of SAMPLE_KB) {
    await prisma.kbEntry.upsert({
      where: { id: k.id },
      update: {
        category: k.category,
        questionVariants: k.questionVariants,
        answer: k.answer,
        sensitivity: k.sensitivity,
        status: 'active',
        source: 'manual',
      },
      create: {
        id: k.id,
        category: k.category,
        questionVariants: k.questionVariants,
        answer: k.answer,
        sensitivity: k.sensitivity,
        status: 'active',
        source: 'manual',
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`seeded ${SAMPLE_KB.length} KB entries`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
