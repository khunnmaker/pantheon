// Runnable driver for the Venus AI suggestion-card generator (api/src/venus/cards.ts).
// VENUS_BRIEF.md §7: "weekly AI batch writes one short Thai card ONLY for flagged
// customers" — intended to be wired into the same nightly/weekly scheduler as
// venus-recompute-stats.ts once one exists (run recompute FIRST, then this, so the cards
// narrate the freshest CustomerStats). For now, run manually or via a future admin route.
//
// Fail-soft: with no ANTHROPIC_API_KEY configured, this completes cleanly with 0 cards
// written and logs the skip count — it never throws just because the LLM isn't available
// (the rules-computed badges in the UI already carry the signal information).
//
// Usage:
//   npx tsx src/scripts/venus-generate-cards.ts
//   npx tsx src/scripts/venus-generate-cards.ts --limit 5   (cap how many customers to process, e.g. for a test run)
import { prisma } from '../db/prisma.js';
import { generateAllCards } from '../venus/cards.js';

function parseLimit(argv: string[]): number | undefined {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return undefined;
  const n = Number(argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  const result = await generateAllCards(prisma, { limit });
  console.log('candidates (customers with >=1 active signal)', result.candidates);
  console.log('written', result.written);
  console.log('skippedNoLlm', result.skippedNoLlm);
  console.log('skippedError', result.skippedError);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
