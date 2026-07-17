const POLITE_PARTICLES = new Set(['ค่ะ', 'คะ', 'นะคะ', 'ครับ', 'นะครับ']);

// These terms signal reusable policy/product knowledge. Their presence protects an edit from
// the transactional filter; false negatives are preferable to dropping a real correction.
const FACT_KEYWORDS = [
  'ไม่มีจำหน่าย',
  'ไม่จำหน่าย',
  'มีจำหน่าย',
  'จัดส่งฟรี',
  'ค่าจัดส่ง',
  'รับประกัน',
  'ผลิต',
  'นำเข้า',
  'ประเทศ',
  'แหล่งผลิต',
  'ขนาด',
  'บรรจุ',
  'แพ็ก',
  'ขั้นต่ำ',
  'วิธีใช้',
  'ใช้กับ',
] as const;

const ORDER_ACK_RE = /ขอบคุณที่ส่งสลิป|รายการตามนี้|ขอสรุปรายการ|ได้รับเรียบร้อย/u;
const STRONG_SLIP_ACK_RE = /ขอบคุณที่ส่งสลิป/u;
const BULLET_LINE_RE = /^\s*(?:[-*•▪◦–—]|\d+[.)]|(?:จำนวน|qty)\s*[:：]?|[x×]\s*\d)/iu;
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

function containsFactKeyword(text: string): boolean {
  return FACT_KEYWORDS.some((keyword) => text.includes(keyword));
}

function looksLikeTransactionalAck(text: string): boolean {
  if (!ORDER_ACK_RE.test(text) || containsFactKeyword(text)) return false;
  const hasBulletishList = text.split(/\r?\n/u).some((line) => BULLET_LINE_RE.test(line));
  // A slip thank-you is unambiguously transactional even without a list. The broader summary
  // phrases require list structure so ordinary prose containing "ได้รับเรียบร้อย" is retained.
  return STRONG_SLIP_ACK_RE.test(text) || hasBulletishList;
}

function normalizedTokenSets(text: string): { digits: Set<string>; content: Set<string> } {
  const normalized = text
    .normalize('NFC')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('th-TH');
  const digits = new Set(normalized.match(/\d+(?:[,.]\d+)*/gu) ?? []);
  const content = new Set<string>();
  for (const part of segmenter.segment(normalized)) {
    const token = part.segment.trim();
    if (!part.isWordLike || !token || POLITE_PARTICLES.has(token) || /^\d/u.test(token)) continue;
    content.add(token);
  }
  return { digits, content };
}

function isSubset<T>(subset: Set<T>, superset: Set<T>): boolean {
  return [...subset].every((value) => superset.has(value));
}

function isToneOnlyEdit(aiDraft: string, finalAnswer: string): boolean {
  const draft = normalizedTokenSets(aiDraft);
  const final = normalizedTokenSets(finalAnswer);
  if (final.content.size === 0) return false;
  return isSubset(final.digits, draft.digits) && isSubset(final.content, draft.content);
}

export type LearningCaptureDecision =
  | { capture: true }
  | { capture: false; reason: 'transactional_ack' | 'tone_only' };

// Conservative, deterministic queue admission. This intentionally has no LLM dependency and
// only rejects two high-confidence noise shapes; everything uncertain remains reviewable.
export function learningCaptureDecision(aiDraft: string, finalAnswer: string): LearningCaptureDecision {
  if (looksLikeTransactionalAck(finalAnswer)) return { capture: false, reason: 'transactional_ack' };
  if (isToneOnlyEdit(aiDraft, finalAnswer)) return { capture: false, reason: 'tone_only' };
  return { capture: true };
}
