// Regression test for the Venus AI suggestion-card pipeline (api/src/venus/cards.ts). Same
// plain-script style as test-venus-stats.ts (no test framework in this repo) — exits 1 on any
// failure.
//
// Covers TWO things, per VENUS_BRIEF.md §7 verification requirements:
//   1. activeSignals() — pure function, no DB, no LLM: a stats row with a reorderDue + a
//      meaningful trend produces the expected signal list; an empty/quiet stats row produces
//      no signals at all (-> no card, per the brief).
//   2. The build+store path with a MOCKED Claude response (there is no ANTHROPIC_API_KEY in
//      this environment) — verifies buildCard() shapes the mock response correctly and that
//      writing it via prisma.venusCard.upsert lands with the exact signalsJson intact. This
//      exercises everything EXCEPT the real Anthropic network call, which cannot be verified
///     until a key is configured (see the fail-soft run of venus-generate-cards.ts for that).
//
// Requires DATABASE_URL pointed at venus_test (this script writes and then deletes ONE
// VenusCard row for a throwaway customer code, never touching real data):
//   export DATABASE_URL='postgresql://minerva:minerva@localhost:5433/venus_test?schema=public'
//   npx tsx src/scripts/test-venus-cards.ts
import { prisma } from '../db/prisma.js';
import { activeSignals, buildCard, type Signal } from '../venus/cards.js';
import type { CustomerStats } from '@prisma/client';

let failed = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    failed++;
  }
}

type StatsShape = Pick<CustomerStats, 'segment' | 'r' | 'f' | 'trendDir' | 'trendPct' | 'reorderDue'>;

// ─── activeSignals() ───

// A customer with a reorder-due item AND a meaningful upward trend -> both should surface.
{
  const stats: StatsShape = {
    segment: 'ลูกค้าประจำ',
    r: 10,
    f: 12,
    trendDir: 'up',
    trendPct: 45.2,
    reorderDue: [
      { sku: '01-05-01', name: 'NATURAL ABRASIVE 10KG', dueSinceDays: 68, medianGapDays: 4, lastPurchase: '2026-04-24', purchaseCount: 6 },
    ] as unknown as object,
  };
  const signals = activeSignals(stats);
  check(signals.length === 2, `activeSignals: reorder+trend row yields 2 signals (got ${signals.length})`);
  check(signals.some((s) => s.kind === 'reorder_due' && s.sku === '01-05-01'), 'activeSignals: reorder_due signal present with correct sku');
  check(signals.some((s) => s.kind === 'trend' && s.dir === 'up' && s.pct === 45.2), 'activeSignals: trend signal present with correct dir/pct');
}

// เสี่ยงหาย segment alone (no reorder, no trend) should still surface a segment signal.
{
  const stats: StatsShape = {
    segment: 'เสี่ยงหาย', r: 120, f: 25, trendDir: 'flat', trendPct: 0, reorderDue: null,
  };
  const signals = activeSignals(stats);
  check(signals.length === 1 && signals[0].kind === 'segment', `activeSignals: เสี่ยงหาย alone yields 1 segment signal (got ${JSON.stringify(signals)})`);
}

// A quiet customer (no reorder, small/no trend, ordinary segment) -> NO signals -> no card.
{
  const stats: StatsShape = {
    segment: 'ลูกค้าประจำ', r: 15, f: 8, trendDir: 'flat', trendPct: 2, reorderDue: null,
  };
  const signals = activeSignals(stats);
  check(signals.length === 0, `activeSignals: quiet customer yields 0 signals (got ${signals.length})`);
}

// Trend below the meaningful threshold (<=20%) must NOT surface, even if directionally up.
{
  const stats: StatsShape = {
    segment: 'ลูกค้าประจำ', r: 15, f: 8, trendDir: 'up', trendPct: 12, reorderDue: null,
  };
  const signals = activeSignals(stats);
  check(signals.length === 0, `activeSignals: sub-threshold trend (12%) yields 0 signals (got ${signals.length})`);
}

// null stats (customer never computed) -> no signals.
check(activeSignals(null).length === 0, 'activeSignals(null) returns empty array');

// Reorder list is capped and sorted by dueSinceDays desc (a heavy buyer can have dozens of
// due items — the card must not try to narrate all of them).
{
  const many = Array.from({ length: 10 }, (_, i) => ({
    sku: `SKU-${i}`, name: `Product ${i}`, dueSinceDays: i * 5, medianGapDays: 10, lastPurchase: '2026-01-01', purchaseCount: 4,
  }));
  const stats: StatsShape = { segment: 'ลูกค้าประจำ', r: 10, f: 8, trendDir: 'flat', trendPct: 0, reorderDue: many as unknown as object };
  const signals = activeSignals(stats);
  const reorderSignals = signals.filter((s) => s.kind === 'reorder_due');
  check(reorderSignals.length === 5, `activeSignals: reorder items capped at 5 (got ${reorderSignals.length})`);
  check(reorderSignals[0].kind === 'reorder_due' && reorderSignals[0].sku === 'SKU-9', 'activeSignals: capped reorder items sorted by dueSinceDays desc (most overdue first)');
}

// ─── buildCard() with a MOCKED Claude caller ───

async function testBuildCardAndStore() {
  const mockText = 'ลูกค้าถึงรอบสั่งซื้อ NATURAL ABRASIVE 10KG แล้ว และยอดซื้อ 90 วันล่าสุดเพิ่มขึ้นชัดเจน ลองติดต่อสอบถามได้';
  let capturedSystem = '';
  let capturedUser = '';
  const mockCaller = async (user: string, system: string) => {
    capturedUser = user;
    capturedSystem = system;
    return mockText;
  };

  const stats: StatsShape = {
    segment: 'ลูกค้าประจำ',
    r: 5,
    f: 20,
    trendDir: 'up',
    trendPct: 33.4,
    reorderDue: [
      { sku: '01-05-01', name: 'NATURAL ABRASIVE 10KG', dueSinceDays: 68, medianGapDays: 4, lastPurchase: '2026-04-24', purchaseCount: 6 },
    ] as unknown as object,
  };

  const built = await buildCard(stats, 'claude-sonnet-4-6-test', mockCaller);
  check(built !== null, 'buildCard: returns a result for a customer with active signals');
  if (!built) return;
  check(built.text === mockText, 'buildCard: text matches the mocked LLM response verbatim');
  check(built.signals.length === 2, `buildCard: signals array carries both signals (got ${built.signals.length})`);
  check(capturedSystem.includes('ห้ามคิดตัวเลข') || capturedSystem.includes('restate'), 'buildCard: system prompt carries the restate-only guardrail');
  check(capturedUser.includes('NATURAL ABRASIVE 10KG'), 'buildCard: user turn carries the signal data (product name)');
  check(!capturedSystem.includes('NATURAL ABRASIVE'), 'buildCard: system turn stays free of customer-specific data (data boundary)');

  // buildCard() with NO signals must return null without calling the LLM at all.
  const quietStats: StatsShape = { segment: 'ลูกค้าประจำ', r: 15, f: 8, trendDir: 'flat', trendPct: 0, reorderDue: null };
  let mockCalledForQuiet = false;
  const built2 = await buildCard(quietStats, 'claude-sonnet-4-6-test', async () => {
    mockCalledForQuiet = true;
    return 'should not happen';
  });
  check(built2 === null, 'buildCard: returns null for a customer with no active signals');
  check(!mockCalledForQuiet, 'buildCard: does not call the LLM at all when there are no signals');

  // Store path: upsert into VenusCard on a throwaway test customer code, then read back and
  // verify the exact signalsJson round-trips. Cleaned up unconditionally in `finally`.
  const testCode = '__test_venus_card__';
  try {
    await prisma.venusCard.upsert({
      where: { customerCode: testCode },
      create: {
        customerCode: testCode,
        text: built.text,
        signalsJson: built.signals as unknown as object,
        model: built.model,
      },
      update: {
        text: built.text,
        signalsJson: built.signals as unknown as object,
        model: built.model,
        createdAt: new Date(),
      },
    });
    const row = await prisma.venusCard.findUnique({ where: { customerCode: testCode } });
    check(row !== null, 'store: VenusCard row exists after upsert');
    check(row?.text === mockText, 'store: stored text matches the built card text');
    check(row?.model === 'claude-sonnet-4-6-test', 'store: stored model id matches');
    const storedSignals = row?.signalsJson as unknown as Signal[];
    check(Array.isArray(storedSignals) && storedSignals.length === 2, `store: signalsJson round-trips as an array of 2 (got ${JSON.stringify(storedSignals)})`);
    check(
      storedSignals?.some((s) => s.kind === 'reorder_due' && s.sku === '01-05-01'),
      'store: signalsJson retains the exact reorder signal (audit trail)',
    );
  } finally {
    await prisma.venusCard.deleteMany({ where: { customerCode: testCode } });
  }
}

testBuildCardAndStore()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failed > 0) {
      console.error(`\n${failed} check(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log('\nAll checks PASSED');
    }
  });
