import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db/prisma.js';

interface ProposedEntry {
  id: string;
  category: string;
  questionVariants: string[];
  answer: string;
  sensitivity: string;
  status?: string;
  source?: string;
}

// Load the KB distilled from real chat history (kb-proposed.json at the repo root,
// reviewed/approved by the owner). Archives the placeholder sample KB so the live
// KB is exactly the approved set.
async function main() {
  const file = path.resolve(process.cwd(), '..', 'kb-proposed.json');
  const entries: ProposedEntry[] = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Retire the seeded sample KB (source 'manual') so it stops feeding drafts.
  const archived = await prisma.kbEntry.updateMany({
    where: { source: 'manual', status: 'active' },
    data: { status: 'archived' },
  });

  let loaded = 0;
  for (const e of entries) {
    await prisma.kbEntry.upsert({
      where: { id: e.id },
      update: {
        category: e.category,
        questionVariants: e.questionVariants,
        answer: e.answer,
        sensitivity: e.sensitivity,
        status: 'active',
        source: 'chat-history',
        lastVerifiedAt: new Date(),
      },
      create: {
        id: e.id,
        category: e.category,
        questionVariants: e.questionVariants,
        answer: e.answer,
        sensitivity: e.sensitivity,
        status: 'active',
        source: 'chat-history',
      },
    });
    loaded++;
  }

  const active = await prisma.kbEntry.count({ where: { status: 'active' } });
  // eslint-disable-next-line no-console
  console.log(`archived ${archived.count} sample entries; loaded ${loaded}; active KB now ${active}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
