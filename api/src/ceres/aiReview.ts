import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { callClaude, llmAvailable } from '../llm/anthropic.js';
import { num, thaiDayKey } from '../routes/ceres/common.js';

export const POLICY_VERSION = 'ceres-policy-v1';
export const AI_MODEL = 'claude-sonnet-4-6'; // informational; anthropic.ts owns the real constant

// Cached-block policy text for the LLM judgment call (payee plausibility / category fit /
// reasonableness) — consulted ONLY when no deterministic rule fired (fail-closed design,
// see docs/CERES_BRIEF.md §7). Keep this versioned alongside POLICY_VERSION.
const POLICY_TEXT = `คุณคือ AI ผู้ตรวจสอบการจ่ายเงินของบริษัท (Ceres) ก่อนที่จะอนุมัติให้จ่ายเงินจากบัญชีบริษัท

บริษัทจ่ายเงินได้ตามปกติสำหรับ:
- ค่าสินค้า/วัตถุดิบจากซัพพลายเออร์
- ค่าน้ำ ค่าไฟ ค่าโทรศัพท์ ค่าอินเทอร์เน็ต และค่าสาธารณูปโภคอื่น
- ค่าขนส่ง/ค่าจัดส่งสินค้า (logistics)
- ค่าซ่อมบำรุง/ค่าน้ำมันยานพาหนะของบริษัท
- ค่าอุปกรณ์สำนักงาน/ของใช้สำนักงานทั่วไป
- ค่าธรรมเนียมราชการ/ภาษี/ค่าใบอนุญาต

ต้องส่งต่อให้ CEO พิจารณา (escalate) เมื่อ:
- ผู้รับเงิน (payee) ไม่คุ้นเคยหรือไม่เคยจ่ายมาก่อน
- รายการดูเหมือนเป็นค่าใช้จ่ายส่วนตัว ไม่เกี่ยวกับธุรกิจ
- จำนวนเงินกลมๆ ที่ดูน่าสงสัย (เช่น จำนวนสูงผิดปกติ หรือดูเหมือนตั้งตัวเลขขึ้นมาเอง)
- รายละเอียดคลุมเครือ ไม่ชัดเจนว่าเป็นค่าใช้จ่ายอะไร
- อะไรก็ตามที่ไม่ชัดเจนว่าเป็นรายจ่ายทางธุรกิจ

ตอบกลับเป็น JSON เท่านั้น รูปแบบนี้เท่านั้น ห้ามมีข้อความอื่นนอกจาก JSON:
{"verdict":"approve","reasoning":"เหตุผลสั้นๆ ภาษาไทย 1-3 ประโยค"}
หรือ
{"verdict":"escalate","reasoning":"เหตุผลสั้นๆ ภาษาไทย 1-3 ประโยค"}`;

// Cached-block policy text for the P1 post-hoc expense sanity call — petty-cash context
// (a messenger's daily entry: delivery fees, fuel, tolls, small supplies) with its OWN
// output contract (ok|flagged — NOT the payment-request approve|escalate vocabulary; the
// two must never share a prompt or the parser rejects every answer).
const EXPENSE_POLICY_TEXT = `คุณคือ AI ผู้ตรวจสอบรายการเบิกเงินสดย่อยประจำวันของบริษัท (Ceres) หลังจากที่ MD อนุมัติแล้ว
รายการเหล่านี้เป็นค่าใช้จ่ายรายวันของพนักงานส่งของ เช่น ค่าส่งของ/ค่าขนส่ง ค่าน้ำมัน ค่าทางด่วน และของใช้เล็กน้อย

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

function parseVerdict(raw: string): { verdict: 'approve' | 'escalate'; reasoning: string } | null {
  try {
    const obj = JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim()) as Record<string, unknown>;
    const verdict = obj.verdict;
    const reasoning = obj.reasoning;
    if ((verdict === 'approve' || verdict === 'escalate') && typeof reasoning === 'string' && reasoning.trim()) {
      return { verdict, reasoning };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeReview(subjectType: 'paymentRequest' | 'expense', subjectId: string, verdict: string, reasoning: string) {
  return prisma.ceresAIReview.create({
    data: { subjectType, subjectId, verdict, reasoning, policyVersion: POLICY_VERSION, model: AI_MODEL },
  });
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

// P2/P3 pre-payment GATE. Deterministic rules run first and are authoritative; the LLM is
// consulted ONLY when no rule fired. Fail-closed: any failure/ambiguity → escalate, never
// approve. Every exit path writes a CeresAIReview row.
export async function reviewPaymentRequest(
  requestId: string,
): Promise<{ verdict: 'approve' | 'escalate'; reasoning: string; reviewId: string }> {
  const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    const review = await writeReview('paymentRequest', requestId, 'escalate', 'ไม่พบคำขอนี้ — ส่งต่อ CEO (fail-closed)');
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }

  const amount = num(request.amount);
  const reasons: string[] = [];

  // 1. CEO threshold.
  if (amount > env.CERES_CEO_THRESHOLD) {
    reasons.push(`เกิน ${env.CERES_CEO_THRESHOLD} บาท — ต้องให้ CEO อนุมัติก่อนจ่ายเสมอ`);
  }

  // 2. Duplicate: same payee + same amount, approved/paid status, within the last 30 days.
  const payeeNorm = request.payee.trim().toLowerCase();
  if (payeeNorm) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const candidates = await prisma.ceresPaymentRequest.findMany({
      where: {
        id: { not: request.id },
        status: { in: ['ai_approved', 'ceo_approved', 'paid'] },
        createdAt: { gte: thirtyDaysAgo },
      },
    });
    const dup = candidates.find((c) => c.payee.trim().toLowerCase() === payeeNorm && num(c.amount) === amount);
    if (dup) {
      reasons.push(`อาจจ่ายซ้ำ: มีรายการ ${request.payee} จำนวนเดียวกันเมื่อ ${thaiDayKey(dup.createdAt)}`);
    }
  }

  // 3. Recurring template checks.
  if (request.recurringTemplateId) {
    const template = await prisma.ceresRecurringTemplate.findUnique({ where: { id: request.recurringTemplateId } });
    if (!template || !template.active) {
      reasons.push('ไม่พบเทมเพลตรายการประจำ หรือเทมเพลตถูกปิดใช้งาน');
    } else {
      const expected = num(template.expectedAmount);
      const tolerance = (expected * template.tolerancePct) / 100;
      if (amount < expected - tolerance || amount > expected + tolerance) {
        reasons.push(`จำนวนเงิน ${amount} บาท อยู่นอกช่วงที่คาดไว้ (${expected} บาท ± ${template.tolerancePct}%)`);
      }
      if (!request.billPeriod.trim()) {
        reasons.push('ไม่ระบุงวดบิล');
      } else {
        const already = await prisma.ceresPaymentRequest.findFirst({
          where: {
            id: { not: request.id },
            recurringTemplateId: request.recurringTemplateId,
            billPeriod: request.billPeriod,
            status: { in: ['ai_approved', 'ceo_approved', 'paid'] },
          },
        });
        if (already) {
          reasons.push(`งวด ${request.billPeriod} จ่ายแล้ว/รออยู่`);
        }
      }
    }
  }

  // 4. Category ceiling.
  const ceilingReason = await categoryCeilingReason(request.category, amount);
  if (ceilingReason) reasons.push(ceilingReason);

  if (reasons.length > 0) {
    const review = await writeReview('paymentRequest', requestId, 'escalate', reasons.join('; '));
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }

  if (!llmAvailable()) {
    const review = await writeReview('paymentRequest', requestId, 'escalate', 'AI ไม่พร้อมใช้งาน — ส่งต่อ CEO ตามหลัก fail-closed');
    return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
  }

  let template: { payee: string; expectedAmount: string; period: string } | null = null;
  if (request.recurringTemplateId) {
    const t = await prisma.ceresRecurringTemplate.findUnique({ where: { id: request.recurringTemplateId } });
    if (t) template = { payee: t.payee, expectedAmount: t.expectedAmount, period: t.period };
  }

  try {
    const userJson = JSON.stringify({
      payee: request.payee,
      amount: request.amount,
      entity: request.entity,
      category: request.category,
      detail: request.detail,
      requestedByName: request.requestedByName,
      template,
    });
    const raw = await callClaude(userJson, { cached: [POLICY_TEXT] });
    const parsed = parseVerdict(raw);
    if (!parsed) {
      const review = await writeReview('paymentRequest', requestId, 'escalate', 'คำตอบ AI ไม่ชัดเจน — ส่งต่อ CEO (fail-closed)');
      return { verdict: 'escalate', reasoning: review.reasoning, reviewId: review.id };
    }
    const review = await writeReview('paymentRequest', requestId, parsed.verdict, parsed.reasoning);
    return { verdict: parsed.verdict, reasoning: parsed.reasoning, reviewId: review.id };
  } catch {
    const review = await writeReview('paymentRequest', requestId, 'escalate', 'AI ขัดข้อง — ส่งต่อ CEO (fail-closed)');
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
        const raw = await callClaude(userJson, { cached: [EXPENSE_POLICY_TEXT] });
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
