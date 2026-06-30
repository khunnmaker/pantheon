import { callClaude, llmAvailable } from './anthropic.js';

// Knowledge distillation for KB promotion. The draft pipeline treats KB entries as
// FACTS and rephrases them in Minerva's own warm voice (prompt.ts rule 6), so the KB
// must store clean reusable knowledge — never the staff member's raw informal text,
// tone, or customer-specific details. See [[kb-learn-knowledge-not-tone]].
const SYSTEM = `คุณเป็นผู้ช่วยสร้าง "คลังความรู้ (KB)" ให้ AI ตอบลูกค้าของบริษัท Prominent (จำหน่ายอุปกรณ์ทันตกรรม)
หน้าที่: รับ "คำถามลูกค้า" + "คำตอบที่พนักงานอนุมัติแล้ว" แล้วสกัดเป็น "ข้อเท็จจริง/ความรู้ที่นำกลับมาใช้ซ้ำได้"

กฎ:
1. เก็บเฉพาะข้อเท็จจริง/นโยบาย/สเปก/ขั้นตอน ที่ใช้ตอบคำถามทำนองเดียวกันในอนาคตได้
2. ตัดทิ้ง: คำทักทาย คำลงท้าย ค่ะ/คะ ชื่อลูกค้า เลขออเดอร์ ข้อมูลเฉพาะรายนั้น และโทนการพิมพ์ของพนักงาน
3. เขียนเป็นภาษาไทยกลาง ๆ กระชับ เป็นกลาง — ไม่ต้องมีโทนบริการ เพราะ AI จะเรียบเรียงโทนเองตอนตอบจริง
4. ห้ามเปลี่ยนตัวเลขใด ๆ (ราคา จำนวน วัน เวลา เบอร์โทร รหัสสินค้า) ต้องคงไว้เหมือนเดิมทุกตัว
5. ถ้าคำตอบเป็นเรื่องเฉพาะลูกค้ารายนี้ล้วน ๆ ไม่มีความรู้ทั่วไปที่ใช้ซ้ำได้ ให้ generalizable=false (อย่าฝืนสกัด)

ตอบกลับเป็น JSON เท่านั้น:
{"fact":"<ข้อเท็จจริงที่สกัดได้ พร้อมเก็บเข้าคลังความรู้>","questionVariants":["<คำถามแบบอื่นที่ความรู้นี้ตอบได้ 1-3 แบบ>"],"generalizable":true}`;

export interface DistilledKnowledge {
  fact: string;
  questionVariants: string[];
  generalizable: boolean;
}

// Distill a supervisor-approved reply into reusable KB knowledge: facts only, no tone/PII.
// Falls back to the verbatim answer if the LLM is unavailable or returns nothing parseable,
// so promotion never breaks (matches the loop's safe-default discipline).
export async function distillKnowledge(question: string, answer: string): Promise<DistilledKnowledge> {
  const fallback: DistilledKnowledge = { fact: answer.trim(), questionVariants: [], generalizable: true };
  if (!llmAvailable()) return fallback;
  try {
    const raw = await callClaude(
      `คำถามลูกค้า:\n"""\n${question}\n"""\n\nคำตอบที่พนักงานอนุมัติ:\n"""\n${answer}\n"""`,
      SYSTEM,
      700,
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const o = JSON.parse(m[0]) as { fact?: unknown; questionVariants?: unknown; generalizable?: unknown };
    const fact = typeof o.fact === 'string' ? o.fact.trim() : '';
    const questionVariants = Array.isArray(o.questionVariants)
      ? o.questionVariants.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
      : [];
    const generalizable = o.generalizable !== false; // default true unless explicitly false
    if (!fact) {
      // No fact extracted: if the model still thinks it's generalizable, fall back to the
      // verbatim answer (preserve prior behavior); otherwise signal "skip" to the caller.
      return generalizable ? fallback : { fact: '', questionVariants, generalizable: false };
    }
    return { fact, questionVariants, generalizable };
  } catch {
    return fallback;
  }
}
