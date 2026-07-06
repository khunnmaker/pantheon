// Regression test for the pure-computation pieces of the Venus analytics engine
// (api/src/venus/stats.ts): quintile scoring and the Thai-segment mapping rule. No test
// framework in this repo (see test-parse-oeson.ts precedent) — plain script, exits 1 on
// any failure. The DB-backed half of the engine (recomputeStats itself, which reads
// SaleDoc/SaleLine via Prisma) is exercised against a real hand-built dataset as part of
// the end-to-end verification on venus_test (not here — no DB fixture story exists yet in
// this repo for plain scripts).
//
//   npx tsx src/scripts/test-venus-stats.ts
import { segmentFor, quintileScores } from '../venus/stats.js';

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    failed++;
  }
}

// ─── quintileScores ───

// 10 customers, ascending values 1..10. Non-inverted: lowest values get score 1, highest
// get score 5, in even quintile buckets of 2 each.
{
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const scores = quintileScores(values, false);
  check(JSON.stringify(scores) === JSON.stringify([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]), `quintileScores ascending non-inverted (got ${JSON.stringify(scores)})`);
}

// Same values, inverted (Recency direction): lowest "days since last purchase" (best) gets
// the HIGHEST score.
{
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const scores = quintileScores(values, true);
  check(JSON.stringify(scores) === JSON.stringify([5, 5, 4, 4, 3, 3, 2, 2, 1, 1]), `quintileScores ascending inverted (got ${JSON.stringify(scores)})`);
}

// Order independence: scores follow the VALUE, not array position.
{
  const values = [10, 1, 5]; // customer A=10 (best), B=1 (worst), C=5 (mid)
  const scores = quintileScores(values, false);
  check(scores[1] < scores[2] && scores[2] < scores[0], `quintileScores respects value order regardless of array position (got ${JSON.stringify(scores)})`);
}

// Empty input.
check(quintileScores([], false).length === 0, 'quintileScores([]) returns empty array');

// ─── segmentFor ───

// Champions: high across the board.
check(segmentFor(5, 5, 5) === 'ลูกค้าชั้นดี', 'segmentFor(5,5,5) === ลูกค้าชั้นดี');
check(segmentFor(4, 4, 4) === 'ลูกค้าชั้นดี', 'segmentFor(4,4,4) === ลูกค้าชั้นดี (boundary >=4)');

// Lost: barely bought before, long gone.
check(segmentFor(1, 1, 1) === 'หายไปแล้ว', 'segmentFor(1,1,1) === หายไปแล้ว');
check(segmentFor(2, 2, 5) === 'หายไปแล้ว', 'segmentFor(2,2,5) === หายไปแล้ว (M ignored when R,F both low)');

// At-risk: USED to buy a lot (high F) but recency has stretched (low R) — the "quietly
// fading" case named explicitly in the brief.
check(segmentFor(1, 5, 5) === 'เสี่ยงหาย', 'segmentFor(1,5,5) === เสี่ยงหาย (high F/M history, R stretching)');
check(segmentFor(2, 3, 1) === 'เสี่ยงหาย', 'segmentFor(2,3,1) === เสี่ยงหาย (boundary F>=3)');

// New: recent, but not enough history yet to call loyal.
check(segmentFor(5, 1, 1) === 'มาใหม่', 'segmentFor(5,1,1) === มาใหม่');
check(segmentFor(4, 2, 3) === 'มาใหม่', 'segmentFor(4,2,3) === มาใหม่ (boundary R>=4, F<=2)');

// Loyal: the steady middle — everything that doesn't hit another rule.
check(segmentFor(3, 3, 3) === 'ลูกค้าประจำ', 'segmentFor(3,3,3) === ลูกค้าประจำ');
check(segmentFor(3, 4, 2) === 'ลูกค้าประจำ', 'segmentFor(3,4,2) === ลูกค้าประจำ (not champion: M<4; not at-risk: R=3)');

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
}
