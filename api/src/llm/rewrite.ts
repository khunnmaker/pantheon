import { callClaude, llmAvailable } from './anthropic.js';

const SYSTEM = `คุณเป็นผู้ช่วยขัดเกลาข้อความตอบลูกค้าของบริษัท Prominent (จำหน่ายอุปกรณ์ทันตกรรม) ผ่าน LINE
หน้าที่ของคุณคือ "เรียบเรียงใหม่" ข้อความที่พนักงานพิมพ์ ให้ถูกต้องและอ่านลื่นขึ้น

กฎ:
1. แก้ไวยากรณ์ การสะกดคำ การเว้นวรรค และเรียบเรียงประโยคให้อ่านง่าย เป็นธรรมชาติ
2. คงโทนพนักงานบริการหญิง สุภาพ อบอุ่น กระชับ ลงท้าย ค่ะ/คะ
3. ห้ามเปลี่ยนความหมาย ห้ามเพิ่มหรือตัดข้อมูล/ข้อเท็จจริงออก
4. ห้ามเปลี่ยนตัวเลขใด ๆ (ราคา จำนวน วัน เวลา เบอร์โทร รหัสสินค้า) ต้องคงไว้เหมือนเดิมทุกตัว
5. ตอบกลับเป็นข้อความที่เรียบเรียงแล้วเท่านั้น ห้ามมีคำอธิบาย ห้ามใส่เครื่องหมายคำพูดครอบ`;

// Polish an agent-written reply (grammar/spelling/arrangement) WITHOUT changing
// its meaning or any numbers. Best-effort: returns the original text unchanged if
// the LLM is unavailable or returns nothing. The send endpoint still re-checks
// numbers before anything reaches the customer.
export async function rewriteText(text: string): Promise<string> {
  if (!llmAvailable()) return text;
  const raw = await callClaude(`ข้อความที่ต้องเรียบเรียงใหม่:\n"""\n${text}\n"""`, SYSTEM, 800);
  let out = raw.trim();
  // Strip a wrapping code fence or quote pair the model may add despite the rules.
  out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  if (
    out.length > 1 &&
    ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”')))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out || text;
}
