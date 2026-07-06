import type { PrismaClient } from '@prisma/client';
import { callClaude, llmAvailable } from '../llm/anthropic.js';
import type { CustomerStats } from '@prisma/client';
import type { ReorderDueItem } from './stats.js';

// Venus AI suggestion cards (VENUS_BRIEF.md §7). This is the weekly narration LAYER on top
// of the already-computed, deterministic signals in CustomerStats (stats.ts) — it never
// computes anything itself. "Rules compute, AI writes": the rules layer (reorderDue/trend/
// segment, already shown as badges in CustomerDetail.tsx) is the product; the AI card just
// turns a signal list into one readable Thai sentence or two for a sales rep. Fail-soft by
// design: if the LLM is unavailable or errors, the customer is skipped — the badges already
// carry the information, nothing is lost.
//
// Complaint-tagging from LINE chats is a SEPARATE later stage (VENUS_BRIEF.md §7 precaution
// #3) — deliberately NOT a signal source here.

// How many reorder-due items to surface per card. A customer can have dozens of SKUs due at
// once (e.g. a big/frequent buyer) — feeding all of them to the LLM would blow the prompt and
// produce an unreadable card, so we take the most-overdue few. The full list still lives on
// CustomerStats/the productCycles table for reps who want it; the card is a highlight, not a
// replacement for it.
const MAX_REORDER_ITEMS_IN_SIGNAL = 5;

// Trend is only worth mentioning to a rep when it's a real move, not noise. Mirrors the
// thresholds CustomerDetail.tsx already uses for the trend SignalBadge (>|20%|) so the AI
// card and the rules badges never disagree about what counts as "worth a mention".
const TREND_PCT_THRESHOLD = 20;

export type SignalKind = 'reorder_due' | 'trend' | 'segment';

export interface ReorderSignal {
  kind: 'reorder_due';
  sku: string;
  name: string | null;
  dueSinceDays: number;
  medianGapDays: number;
}
export interface TrendSignal {
  kind: 'trend';
  dir: 'up' | 'down';
  pct: number;
}
export interface SegmentSignal {
  kind: 'segment';
  segment: string;
  // Free-text evidence, same wording style as the churn precaution in routes/venus.ts
  // (real computed numbers only — r/f, never invented).
  evidence: string;
}
// Extension point for later enrichment (VENUS_BRIEF.md §7): cross-sell-gap signals (Minerva's
// bought-together pairs the customer lacks) and big-ticket-anniversary signals (equipment
// service/upgrade timing) both belong in this union once built. Add a new `kind` + interface
// above, extend the union, and push instances of it in activeSignals() below — nothing else
// in the generator or the storage/endpoint layer needs to change (both are signal-shape-agnostic).
export type Signal = ReorderSignal | TrendSignal | SegmentSignal;

// A segment worth flagging to a rep on its own (VENUS_BRIEF.md §7: "segment transitions worth
// mentioning") — เสี่ยงหาย is the one that needs a human to notice and act; the churn precaution
// row already shows this same evidence, so the wording matches (routes/venus.ts churnPrecaution).
function segmentSignal(stats: Pick<CustomerStats, 'segment' | 'r' | 'f'>): SegmentSignal | null {
  if (stats.segment !== 'เสี่ยงหาย') return null;
  if (stats.r == null) return null;
  return {
    kind: 'segment',
    segment: stats.segment,
    evidence: `หายไป ${stats.r} วัน (เคยซื้อ ${stats.f ?? 0} ครั้งในช่วงข้อมูล)`,
  };
}

// Build the deterministic signal list for one customer from ALREADY-COMPUTED CustomerStats
// fields only — no new computation happens here, this just selects+shapes what's already on
// the row. A customer with an empty list gets no card (see cards should only be generated for
// customers with >=1 active signal, VENUS_BRIEF.md §7).
export function activeSignals(
  stats: Pick<CustomerStats, 'segment' | 'r' | 'f' | 'trendDir' | 'trendPct' | 'reorderDue'> | null,
): Signal[] {
  if (!stats) return [];
  const signals: Signal[] = [];

  const reorderItems = Array.isArray(stats.reorderDue) ? (stats.reorderDue as unknown as ReorderDueItem[]) : [];
  const topReorder = [...reorderItems]
    .sort((a, b) => b.dueSinceDays - a.dueSinceDays)
    .slice(0, MAX_REORDER_ITEMS_IN_SIGNAL);
  for (const item of topReorder) {
    signals.push({
      kind: 'reorder_due',
      sku: item.sku,
      name: item.name,
      dueSinceDays: item.dueSinceDays,
      medianGapDays: item.medianGapDays,
    });
  }

  if (stats.trendDir === 'up' && (stats.trendPct ?? 0) > TREND_PCT_THRESHOLD) {
    signals.push({ kind: 'trend', dir: 'up', pct: stats.trendPct ?? 0 });
  } else if (stats.trendDir === 'down' && (stats.trendPct ?? 0) < -TREND_PCT_THRESHOLD) {
    signals.push({ kind: 'trend', dir: 'down', pct: stats.trendPct ?? 0 });
  }

  const seg = segmentSignal(stats);
  if (seg) signals.push(seg);

  return signals;
}

// Compact purchase summary as DATA for the user turn — top products by purchase count (from
// the same reorderDue-independent per-SKU aggregation productCycles already does in
// routes/venus.ts) is overkill to duplicate here; the card only needs enough context to sound
// grounded, not the full timeline. Kept intentionally small (name + segment + last purchase),
// same "compact" wording as the brief ("a compact purchase summary").
export interface PurchaseSummary {
  segment: string | null;
  lastPurchase: string | null; // ISO date, or null if never
  purchaseCount: number | null; // F score (purchases within the RFM window)
}

function buildPurchaseSummary(stats: Pick<CustomerStats, 'segment' | 'f' | 'r'>): PurchaseSummary {
  let lastPurchase: string | null = null;
  if (stats.r != null) {
    const d = new Date(Date.now() - stats.r * 86400000);
    lastPurchase = d.toISOString().slice(0, 10);
  }
  return {
    segment: stats.segment ?? null,
    lastPurchase,
    purchaseCount: stats.f ?? null,
  };
}

// SYSTEM turn (trusted, cached-eligible): the restate-only guardrail lives here, not in the
// user turn — this is the boundary the model is instructed to respect BEFORE it ever sees the
// data. Mirrors the Ceres aiReview.ts JSON-only-output convention, adapted to plain Thai text
// output (no JSON needed here — the whole response IS the card text).
const CARD_SYSTEM_PROMPT = `คุณคือผู้ช่วยเขียนคำแนะนำสั้นๆ ภาษาไทยสำหรับพนักงานขาย (sales rep) ของบริษัทอุปกรณ์ทันตกรรม

คุณจะได้รับ "สัญญาณ" (signals) ที่คำนวณไว้แล้วจากระบบ พร้อมสรุปการซื้อของลูกค้าโดยย่อ

กติกาที่ต้องทำตามเคร่งครัด:
- เขียนคำแนะนำสั้นๆ ภาษาไทย 1-2 ประโยคเท่านั้น สำหรับพนักงานขายอ่านก่อนติดต่อลูกค้า
- ใช้ได้เฉพาะข้อมูลที่ให้มาเท่านั้น ห้ามคิดตัวเลข ราคา หรือชื่อสินค้าขึ้นเองเด็ดขาด — คุณอาจ "เล่าซ้ำ" (restate) สัญญาณที่ได้รับเท่านั้น ห้ามเพิ่มเติมข้อมูลใดๆ ที่ไม่มีอยู่ในสัญญาณ
- ถ้ามีหลายสัญญาณ ให้เลือกเน้นสิ่งที่สำคัญที่สุด 1-2 อย่าง ไม่ต้องพูดถึงทุกสัญญาณ
- ห้ามมีคำทักทายหรือคำลงท้าย (เช่น "สวัสดีครับ", "ขอบคุณครับ") ตอบเฉพาะเนื้อหาคำแนะนำเท่านั้น
- ห้ามตอบเป็น JSON หรือ markdown ตอบเป็นข้อความธรรมดา (plain text) เท่านั้น`;

function formatSignalForPrompt(s: Signal): string {
  switch (s.kind) {
    case 'reorder_due':
      return `ถึงรอบสั่งซื้อ: ${s.name ?? s.sku} (รหัส ${s.sku}) เลยรอบมาแล้ว ${s.dueSinceDays} วัน (ปกติซื้อทุก ${s.medianGapDays} วัน)`;
    case 'trend':
      return s.dir === 'up'
        ? `ยอดซื้อ 90 วันล่าสุดเพิ่มขึ้น ${s.pct.toFixed(0)}% เทียบกับ 90 วันก่อนหน้า`
        : `ยอดซื้อ 90 วันล่าสุดลดลง ${Math.abs(s.pct).toFixed(0)}% เทียบกับ 90 วันก่อนหน้า`;
    case 'segment':
      return `กลุ่มลูกค้า: ${s.segment} — ${s.evidence}`;
  }
}

function buildUserPrompt(signals: Signal[], summary: PurchaseSummary): string {
  const lines: string[] = [];
  lines.push('สัญญาณที่คำนวณไว้แล้ว (ใช้ได้เฉพาะข้อมูลนี้เท่านั้น):');
  for (const s of signals) lines.push(`- ${formatSignalForPrompt(s)}`);
  lines.push('');
  lines.push('สรุปการซื้อโดยย่อ:');
  lines.push(`- กลุ่มลูกค้า: ${summary.segment ?? 'ไม่ทราบ'}`);
  lines.push(`- ซื้อล่าสุด: ${summary.lastPurchase ?? 'ไม่ทราบ'}`);
  lines.push(`- จำนวนครั้งที่ซื้อ (ในช่วงข้อมูล): ${summary.purchaseCount ?? 'ไม่ทราบ'}`);
  return lines.join('\n');
}

export interface CardBuildResult {
  text: string;
  signals: Signal[];
  model: string;
}

// Calls the LLM (via the shared anthropic.ts wrapper) and returns the built card, or null if
// there's nothing to say (no signals) — the caller (generator script / a future route) is
// responsible for catching LLM errors and skipping (fail-soft), matching aiReview.ts's
// try/catch-around-callClaude shape. This function itself does not catch — it's a thin,
// testable prompt-build + call + shape step; callers decide fail-soft behavior.
export async function buildCard(
  stats: Pick<CustomerStats, 'segment' | 'r' | 'f' | 'trendDir' | 'trendPct' | 'reorderDue'>,
  modelId: string,
  caller: (user: string, system: string) => Promise<string> = (user, system) => callClaude(user, system),
): Promise<CardBuildResult | null> {
  const signals = activeSignals(stats);
  if (signals.length === 0) return null;

  const summary = buildPurchaseSummary(stats);
  const userPrompt = buildUserPrompt(signals, summary);
  const raw = await caller(userPrompt, CARD_SYSTEM_PROMPT);
  const text = raw.trim();
  if (!text) return null;

  return { text, signals, model: modelId };
}

// Model id recorded on the card for audit — anthropic.ts owns the real constant used in the
// actual API call; this is just what gets stamped on the row (same "informational" pattern as
// aiReview.ts's AI_MODEL constant).
export const CARD_MODEL_ID = 'claude-sonnet-4-6';

export interface GenerateAllResult {
  candidates: number; // customers with >=1 active signal
  written: number; // cards actually stored
  skippedNoLlm: number; // skipped because no API key / LLM unavailable
  skippedError: number; // skipped because the LLM call itself errored
}

// Batch driver: for every customer with a CustomerStats row and >=1 active signal, build +
// store a card. FAIL-SOFT at the batch level: if the LLM isn't configured at all, every
// candidate is counted as skippedNoLlm and the function returns cleanly (0 cards written,
// no throw) — this is the path exercised in the no-API-key verification environment. An
// individual LLM error (bad response, network) only skips THAT customer, never aborts the
// batch (same reasoning as Ceres's reviewExpensePostHoc: one failure must not block everyone
// else queued behind it).
export async function generateAllCards(
  prisma: PrismaClient,
  opts: { limit?: number } = {},
): Promise<GenerateAllResult> {
  const result: GenerateAllResult = { candidates: 0, written: 0, skippedNoLlm: 0, skippedError: 0 };

  const allStats = await prisma.customerStats.findMany({
    select: { customerCode: true, segment: true, r: true, f: true, trendDir: true, trendPct: true, reorderDue: true },
  });

  const candidates = allStats.filter((s) => activeSignals(s).length > 0);
  result.candidates = candidates.length;

  const llmUp = llmAvailable();
  const slice = opts.limit != null ? candidates.slice(0, opts.limit) : candidates;

  for (const stats of slice) {
    if (!llmUp) {
      result.skippedNoLlm++;
      continue;
    }
    try {
      const built = await buildCard(stats, CARD_MODEL_ID);
      if (!built) continue; // no signals (shouldn't happen given the candidates filter, but defensive)
      await prisma.venusCard.upsert({
        where: { customerCode: stats.customerCode },
        create: {
          customerCode: stats.customerCode,
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
      result.written++;
    } catch {
      // Fail-soft per customer: skip, never throw — the rules badges already carry the
      // signal information regardless of whether the AI narration succeeded.
      result.skippedError++;
    }
  }

  return result;
}
