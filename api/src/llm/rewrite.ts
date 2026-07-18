import { callClaude, llmAvailable } from './anthropic.js';

const SYSTEM = `คุณเป็นผู้ช่วยขัดเกลาข้อความตอบลูกค้าของบริษัท Prominent (จำหน่ายอุปกรณ์ทันตกรรม) ผ่าน LINE
หน้าที่ของคุณคือ "เรียบเรียงใหม่" ข้อความที่พนักงานพิมพ์ ให้ถูกต้องและอ่านลื่นขึ้น

กฎ:
1. แก้ไวยากรณ์ การสะกดคำ การเว้นวรรค และเรียบเรียงประโยคให้อ่านง่าย เป็นธรรมชาติ
2. คงโทนพนักงานบริการหญิง สุภาพ อบอุ่น กระชับ ลงท้าย ค่ะ/คะ — ใช้คำแทนบริษัทว่า "เรา" (เลี่ยง "ทางเรา" ซ้ำ ๆ)
3. ห้ามเปลี่ยนความหมาย ห้ามเพิ่มหรือตัดข้อมูล/ข้อเท็จจริงออก
4. ห้ามเปลี่ยนตัวเลขใด ๆ (ราคา จำนวน วัน เวลา เบอร์โทร รหัสสินค้า) ต้องคงไว้เหมือนเดิมทุกตัว

ตอบกลับเป็น JSON เท่านั้น รูปแบบ:
{"text":"<ข้อความที่เรียบเรียงแล้ว สำหรับส่งให้ลูกค้าได้ทันที>","note":"<ข้อสังเกต/คำเตือนถึงพนักงาน ถ้ามี; ถ้าไม่มีให้เว้นว่าง>"}

สำคัญที่สุด: ช่อง "text" ต้องเป็นข้อความที่ส่งให้ลูกค้าได้ทันทีเท่านั้น
ห้ามมีคำอธิบาย คำเตือน หมายเหตุ เครื่องหมาย --- หรือสัญลักษณ์ ⚠️ ในช่อง "text" เด็ดขาด
หากต้นฉบับกำกวม/ไม่ครบถ้วน ให้เรียบเรียงเท่าที่ทำได้ แล้วใส่ข้อสังเกตไว้ในช่อง "note" เท่านั้น`;

export interface RewriteResult {
  text: string;
  note: string | null;
}

// Polish an agent-written reply WITHOUT changing meaning or numbers. Returns the
// clean customer-facing text plus an optional staff-only note (never mixed into
// the text — so a caveat can't be sent to the customer by mistake).
export async function rewriteText(input: string): Promise<RewriteResult> {
  if (!llmAvailable()) return { text: input, note: null };
  const raw = await callClaude(
    `ข้อความที่ต้องเรียบเรียงใหม่:\n"""\n${input}\n"""`,
    SYSTEM,
    900,
    undefined,
    { app: 'minerva', feature: 'rewrite' },
  );
  const parsed = parseRewrite(raw);
  return { text: parsed.text || input, note: parsed.note };
}

function parseRewrite(raw: string): RewriteResult {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { text?: unknown; note?: unknown };
      const text = typeof o.text === 'string' ? stripMeta(o.text.trim()) : '';
      const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim() : null;
      // Honor the parsed result even when text is empty — the caller falls back to
      // the original input, so the raw JSON never leaks into the reply box.
      return { text, note };
    } catch {
      /* fall through to plain-text handling */
    }
  }
  return { text: stripMeta(raw.trim()), note: null };
}

// Safety net: never let a "---" rule or "⚠️" warning section reach the customer box,
// even if the model ignores the JSON format.
function stripMeta(s: string): string {
  let t = s
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  const cut = t.search(/\n\s*(?:-{3,}|⚠|\*{3,})/);
  if (cut !== -1) t = t.slice(0, cut).trim();
  return t;
}
