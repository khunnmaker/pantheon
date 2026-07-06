// Runnable driver for the Venus analytics engine (api/src/venus/stats.ts). Intended to be
// wired into a nightly scheduler later (VENUS_BRIEF.md §6: "nightly job (also on-demand
// after an import)") — for now, run manually or via POST /api/venus/recompute.
//
// Usage: npx tsx src/scripts/venus-recompute-stats.ts
import { prisma } from '../db/prisma.js';
import { recomputeStats } from '../venus/stats.js';

async function main() {
  const result = await recomputeStats(prisma);
  console.log('customersProcessed', result.customersProcessed);
  console.log('segmentCounts', result.segmentCounts);
  console.log('dataCoverage', result.dataCoverage);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
