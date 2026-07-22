import { prisma } from '../db/prisma.js';
import { callClaude, llmAvailable } from '../llm/anthropic.js';
import { num, thaiDayKey } from '../routes/ceres/common.js';

export const POLICY_VERSION = 'ceres-policy-v3'; // v3: staff-request pre-screen gets a Thai-BE-aware today's-date anchor (see todayThailandLabel below)
export const AI_MODEL = 'claude-sonnet-4-6'; // informational; anthropic.ts owns the real constant

// Cached-block policy text for the P1 post-hoc expense sanity call — petty-cash context
// (a messenger's daily entry: delivery fees, fuel, tolls, small supplies) with its OWN
// output contract (ok|flagged — NOT the payment-request approve|escalate vocabulary; the
// two must never share a prompt or the parser rejects every answer).
const EXPENSE_POLICY_TEXT = `คุณคือ AI ผู้ตรวจสอบรายการเบิกเงินสดย่อยประจำวันของบริษัท (Ceres) หลังจากที่ GM อนุมัติแล้ว
รายการเหล่านี้มาจากพนักงานทุกบทบาทในกลุ่มบริษัท (สำนักงาน ฝ่ายขาย คลินิก และเมสเซนเจอร์) เช่น ค่าเดินทาง ค่าน้ำมัน/ทางด่วน อุปกรณ์สำนักงาน ของใช้สิ้นเปลือง อาหาร/รับรองลูกค้า งานซ่อมเล็กน้อย และค่าขนส่งของเมสเซนเจอร์ ให้ประเมินความสมเหตุสมผลเทียบกับบันทึกและบทบาทของผู้ขอโดยไม่สันนิษฐานว่าเป็นงานส่งของ และส่งต่อรายการส่วนตัว ฟุ่มเฟือย หรือผิดปกติให้ผู้บริหารพิจารณา

ให้ทำเครื่องหมายผิดปกติ (flagged) เมื่อ:
- รายการดูเหมือนเป็นค่าใช้จ่ายส่วนตัว ไม่เกี่ยวกับงาน
- จำนวนเงินไม่สมเหตุสมผลกับหมวดหมู่ (เช่น ค่าทางด่วนหลายพันบาท)
- ชื่อร้าน/ผู้ขายที่อ่านได้จากใบเสร็จ (OCR) ไม่สอดคล้องกับหมวดหมู่ที่ระบุ
- รายละเอียดคลุมเครือหรือขัดแย้งกันเอง

ถ้ารายการดูปกติและสมเหตุสมผล ให้ตอบ ok

ตอบกลับเป็น JSON เท่านั้น รูปแบบนี้เท่านั้น ห้ามมีข้อความอื่นนอกจาก JSON:
{"verdict":"ok","reasoning":"เหตุผลสั้นๆ ภาษาไทย 1-2 ประโยค"}
หรือ
{"verdict":"flagged","reasoning":"เหตุผลสั้นๆ ภาษาไทย 1-2 ประโยค"}`;

// V2 is a pre-screen, not an approver. `approve` is deliberately absent from this
// contract and is treated as malformed output if a model returns it.
//
// Buddhist Era bug (fixed 2026-07-22): Thai receipts print their year in the Buddhist Era
// (พ.ศ. = ค.ศ. + 543) and readReceipt.ts's OCR deliberately does NOT convert it ("ตามรูปแบบเดิม
// ไม่ต้องแปลง") — evidence.ocrDate below is that raw, unconverted string. Without an explicit
// BE/CE hint and a current-date anchor, the model has no way to tell a same-day receipt
// (e.g. "22 กรกฎาคม พ.ศ. 2569" = 2026-07-22) from an actual future date, and escalated it as
// one. The `today` field on the payload (see todayThailandLabel below) gives the model a
// concrete reference point in both calendars for every call.
const STAFF_REQUEST_POLICY_TEXT = `You pre-screen an internal company money request before a human manager reviews it.
Return JSON only in exactly one of these forms:
{"verdict":"clear","reasoning":"brief Thai reasoning"}
{"verdict":"escalate","reasoning":"brief Thai reasoning"}
Escalate anything ambiguous, personal, inconsistent, implausible, or insufficiently evidenced.
You never approve requests. A human manager must decide every request.

Thai receipts commonly print their year in the Buddhist Era (พ.ศ. = ค.ศ. + 543), e.g. a receipt
dated "22 กรกฎาคม พ.ศ. 2569" is 22 July 2026 (ค.ศ.) — convert a พ.ศ.-looking year before judging
whether evidence.ocrDate is in the future or stale. The payload's "today" field gives the current
date in both calendars — use it as your reference point. Never escalate a request solely because
its OCR date's year number looks large; check whether it converts to a sensible ค.ศ. date first.`;

// Today's date in Bangkok time (UTC+7, no DST), given in both calendars — injected into every
// pre-screen call so the model always has a concrete "now" to judge evidence.ocrDate against
// instead of guessing from training-data recency. Thai year = Gregorian year + 543.
export function todayThailandLabel(): string {
  const ce = thaiDayKey(new Date()); // "YYYY-MM-DD", Bangkok-local
  const beYear = Number(ce.slice(0, 4)) + 543;
  return `Today is ${ce} (ค.ศ.) = พ.ศ. ${beYear}.`;
}

async function writeReview(subjectType: 'paymentRequest' | 'expense', subjectId: string, verdict: string, reasoning: string) {
  return prisma.ceresAIReview.create({
    data: { subjectType, subjectId, verdict, reasoning, policyVersion: POLICY_VERSION, model: AI_MODEL },
  });
}

export async function writeStaffRequestEscalation(requestId: string, reasoning: string) {
  return writeReview('paymentRequest', requestId, 'escalate', reasoning);
}

// Category ceiling check shared by both reviewers: category has a non-empty ceiling and
// the amount exceeds it.
async function categoryCeilingReason(category: string, amount: number): Promise<string | null> {
  const cat = await prisma.ceresCategory.findUnique({ where: { name: category } });
  if (!cat || !cat.ceiling) return null;
  const ceiling = num(cat.ceiling);
  if (amount > ceiling) {
    return `เกินเพดานหมวด "${category}" (${ceiling} บาท)`;
  }
  return null;
}

// V2 staff-request pre-screen.
// Every path writes an immutable CeresAIReview and V2 never writes an `approve` verdict.
export async function reviewStaffRequest(
  requestId: string,
): Promise<{ verdict: 'clear' | 'escalate'; reasoning: string; reviewId: string | null }> {
  const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request || request.workflowVersion !== 2) {
    const review = await writeStaffRequestEscalation(requestId, 'ไม่พบคำขอเวอร์ชัน 2 — ส่งต่อผู้บริหาร (fail-closed)');
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }
  if (request.requestType === 'advance') {
    console.warn({ event: 'ceres_ai_review_skipped_by_policy', requestId }, '[ceres] advance AI review skipped by policy');
    return { verdict: 'clear', reasoning: 'skipped_by_policy', reviewId: null };
  }

  const amount = num(request.amount);
  const reasons: string[] = [];

  // Reimbursements are the one request type whose evidence is mandatory at submission.
  // This also fail-closes malformed/backfilled rows that somehow bypass route validation.
  if (request.requestType === 'reimbursement' && !request.requestPhotoUploadId) {
    reasons.push('คำขอเบิกคืนไม่มีใบเสร็จ');
  }

  if (request.requestPhotoSha) {
    const [duplicateRequest, duplicateExpense] = await Promise.all([
      prisma.ceresPaymentRequest.findFirst({
        where: {
          id: { not: request.id },
          workflowVersion: 2,
          requestPhotoSha: request.requestPhotoSha,
          approvalStatus: { notIn: ['rejected', 'cancelled', 'void'] },
        },
        select: { id: true },
      }),
      prisma.ceresExpense.findFirst({
        where: { receiptSha: request.requestPhotoSha, status: { notIn: ['rejected', 'void'] } },
        select: { id: true },
      }),
    ]);
    if (duplicateRequest || duplicateExpense) reasons.push('พบหลักฐานรูปเดียวกันถูกใช้ซ้ำ');
  }

  if (request.ocrAmount && num(request.ocrAmount) !== amount) {
    reasons.push(`ยอดคำขอไม่ตรงกับ OCR (${request.ocrAmount} บาท)`);
  }

  const ceilingReason = await categoryCeilingReason(request.category, amount);
  if (ceilingReason) reasons.push(ceilingReason);

  if (reasons.length > 0) {
    const review = await writeStaffRequestEscalation(requestId, reasons.join('; '));
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }

  if (!llmAvailable()) {
    const review = await writeStaffRequestEscalation(requestId, 'AI ไม่พร้อมใช้งาน — ส่งต่อผู้บริหารตามหลัก fail-closed');
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }

  try {
    const raw = await callClaude(JSON.stringify({
      today: todayThailandLabel(),
      requestType: request.requestType,
      amount: request.amount,
      entity: request.entity,
      category: request.category,
      reason: request.detail,
      requestedByName: request.requestedByName,
      evidence: request.requestPhotoUploadId ? {
        ocrAmount: request.ocrAmount,
        ocrVendor: request.ocrVendor,
        ocrDate: request.ocrDate,
      } : null,
    }), { cached: [STAFF_REQUEST_POLICY_TEXT] });
    const obj = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim()) as Record<string, unknown>;
    const verdict = obj.verdict;
    const reasoning = obj.reasoning;
    if ((verdict !== 'clear' && verdict !== 'escalate') || typeof reasoning !== 'string' || !reasoning.trim()) {
      const review = await writeStaffRequestEscalation(requestId, 'คำตอบ AI ไม่ถูกต้อง — ส่งต่อผู้บริหาร (fail-closed)');
      return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
    }
    const review = await writeReview('paymentRequest', requestId, verdict, reasoning);
    return { verdict, reasoning, reviewId: review.id };
  } catch {
    const review = await writeStaffRequestEscalation(requestId, 'AI ขัดข้อง — ส่งต่อผู้บริหาร (fail-closed)');
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }
}

// P1 post-hoc second pair of eyes AFTER Nee approves. Advisory only — never blocks anyone,
// never throws. Deterministic flags run first; an LLM sanity call only runs when nothing
// flagged, and its own failure is NOT fail-closed here (post-hoc, CEO sees everything nightly
// anyway) — it defaults to 'ok'.
export async function reviewExpensePostHoc(expenseId: string): Promise<void> {
  try {
    const expense = await prisma.ceresExpense.findUnique({ where: { id: expenseId } });
    if (!expense) return;

    const amount = num(expense.amount);
    const flags: string[] = [];

    if (!expense.receiptUploadId) flags.push('ไม่มีใบเสร็จ');

    if (expense.ocrAmount && num(expense.ocrAmount) !== amount) {
      flags.push(`ยอดไม่ตรงกับ OCR (อ่านได้ ${expense.ocrAmount})`);
    }

    if (expense.receiptSha) {
      const dupReceipt = await prisma.ceresExpense.findFirst({
        where: { id: { not: expense.id }, receiptSha: expense.receiptSha, status: { notIn: ['rejected', 'void'] } },
      });
      if (dupReceipt) flags.push('ใบเสร็จรูปเดียวกันถูกใช้ซ้ำ');
    }

    if (expense.partyName) {
      const dayKey = thaiDayKey(expense.spentAt);
      const candidates = await prisma.ceresExpense.findMany({
        where: {
          id: { not: expense.id },
          partyName: expense.partyName,
          status: { notIn: ['rejected', 'void'] },
        },
      });
      const dup = candidates.find((c) => num(c.amount) === amount && thaiDayKey(c.spentAt) === dayKey);
      if (dup) flags.push('อาจบันทึกซ้ำ');
    }

    const ceilingReason = await categoryCeilingReason(expense.category, amount);
    if (ceilingReason) flags.push(ceilingReason);

    let verdict: 'ok' | 'flagged';
    let reasoning: string;

    if (flags.length > 0) {
      verdict = 'flagged';
      reasoning = flags.join('; ');
    } else if (!llmAvailable()) {
      verdict = 'ok';
      reasoning = 'ผ่านการตรวจตามกฎอัตโนมัติ (AI ไม่พร้อมใช้งาน)';
    } else {
      try {
        const userJson = JSON.stringify({
          partyName: expense.partyName,
          entity: expense.entity,
          category: expense.category,
          customerNote: expense.customerNote,
          amount: expense.amount,
          ocrVendor: expense.ocrVendor,
          note: expense.note,
        });
        const raw = await callClaude(
          userJson,
          { cached: [EXPENSE_POLICY_TEXT] },
          undefined,
          undefined,
          { app: 'ceres', feature: 'expense-check' },
        );
        const obj = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim()) as Record<string, unknown>;
        const v = obj.verdict;
        const r = obj.reasoning;
        if ((v === 'ok' || v === 'flagged') && typeof r === 'string' && r.trim()) {
          verdict = v;
          reasoning = r;
        } else {
          verdict = 'ok';
          reasoning = 'ผ่านการตรวจตามกฎอัตโนมัติ (คำตอบ AI ไม่ชัดเจน)';
        }
      } catch {
        verdict = 'ok';
        reasoning = 'ผ่านการตรวจตามกฎอัตโนมัติ (AI ไม่พร้อมใช้งาน)';
      }
    }

    const review = await writeReview('expense', expenseId, verdict, reasoning);
    await prisma.ceresExpense.update({
      where: { id: expenseId },
      data: { aiVerdict: verdict, aiReviewId: review.id },
    });
  } catch {
    // Post-hoc is fire-and-forget advisory — never throw, never block the caller.
  }
}
