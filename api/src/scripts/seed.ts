import { prisma } from '../db/prisma.js';
import { hashPassword } from '../auth/password.js';

// Dev-only shared password for all seeded staff. Change for any real deployment.
const DEV_PASSWORD = 'prominent123';

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
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
