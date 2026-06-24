import type { KbEntry } from '@prisma/client';
import type { DraftResult } from './parser.js';

export type SensitiveIntent = 'price_stock' | 'clinical' | null;

// Defense-in-depth ON TOP of the prompt rules. Thai + English/romanized terms,
// matched after normalization so spacing/zero-width/case tricks can't evade.
const PRICE_STOCK = [
  // Thai
  'ราคา', 'กี่บาท', 'เท่าไหร่', 'เท่าไร', 'บาท', 'ลดราคา', 'โปรโมชั่น', 'โปรโมชัน', 'มีของ',
  'สต็อก', 'สต๊อก', 'พร้อมส่ง', 'ของหมด', 'คงเหลือ', 'มีสินค้าไหม', 'มีของไหม', 'มูลค่า', 'งบ',
  // English / romanized
  'price', 'cost', 'howmuch', 'baht', 'thb', '฿', 'instock', 'stock', 'available', 'readytoship',
  'soldout', 'raka', 'taorai',
];
const CLINICAL = [
  // Thai
  'ปวด', 'อาการ', 'รักษา', 'วินิจฉัย', 'ฟันผุ', 'เหงือก', 'เลือดออก', 'อักเสบ', 'ถอนฟัน',
  'รากฟัน', 'เสียวฟัน', 'บวม', 'ติดเชื้อ', 'ควรทำยังไง', 'ควรทำอย่างไร', 'เป็นรู', 'หนอง',
  // English
  'pain', 'symptom', 'treat', 'diagnos', 'infect', 'swollen', 'cavity', 'gum', 'bleeding',
  'abscess', 'toothache',
];

// Lowercase, strip zero-width chars and ALL whitespace so spaced/zero-width/case
// tricks all collapse to a matchable form.
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[​‌‍﻿]/g, '')
    .replace(/\s+/g, '');
}

// A number adjacent to a currency unit (whitespace already stripped by normalize).
const PRICE_PATTERN = /[0-9๐-๙][0-9๐-๙,.]*(บาท|baht|thb|฿)/;

function matches(text: string, words: string[]): boolean {
  const t = normalize(text);
  return words.some((w) => t.includes(normalize(w)));
}

export function detectSensitiveIntent(text: string): SensitiveIntent {
  // Clinical first — a medical question must always reach a professional.
  if (matches(text, CLINICAL)) return 'clinical';
  if (matches(text, PRICE_STOCK) || PRICE_PATTERN.test(normalize(text))) return 'price_stock';
  return null;
}

// Does the text contain a number (price/qty/date)? The console requires an
// explicit confirm before sending any reply that contains numbers (spec §8).
export function hasNumbers(text: string): boolean {
  return /[0-9๐-๙]/.test(text || ''); // ASCII or Thai digits
}

const OVERRIDE: Record<'price_stock' | 'clinical', { draft: string; note: string }> = {
  price_stock: {
    draft: 'ขอเช็กข้อมูลให้สักครู่นะคะ เดี๋ยวเจ้าหน้าที่ยืนยันให้อีกครั้งค่ะ 😊',
    note: 'คำถามเกี่ยวกับราคา/สต็อก — ต้องให้เจ้าหน้าที่ยืนยันข้อมูลปัจจุบัน (ห้ามเดาตัวเลข)',
  },
  clinical: {
    draft: 'เรื่องนี้ขอให้ทันตแพทย์/ผู้เชี่ยวชาญดูแลให้นะคะ เดี๋ยวเจ้าหน้าที่ติดต่อกลับค่ะ',
    note: 'คำถามเชิงคลินิก/การรักษา — ต้องให้ทันตแพทย์หรือผู้เชี่ยวชาญตอบ',
  },
};

export interface GuardrailOutcome {
  result: DraftResult;
  triggered: boolean;
  reason: SensitiveIntent;
}

// Force needs_human when the question, a cited KB entry, OR the AI's own proposed
// draft makes a price/stock/clinical claim — so the AI can never originate a
// price/availability/medical answer to the customer.
export function applyGuardrails(
  result: DraftResult,
  question: string,
  citedKb: KbEntry[],
): GuardrailOutcome {
  const citedSensitivity = citedKb.map((k) => k.sensitivity);
  const kbClinical = citedSensitivity.includes('clinical');
  const kbPriceStock =
    citedSensitivity.includes('price_stock') || citedSensitivity.includes('no_auto');

  let reason: SensitiveIntent = detectSensitiveIntent(question);
  if (!reason && kbClinical) reason = 'clinical';
  if (!reason && kbPriceStock) reason = 'price_stock';
  // Backstop: scan the AI's own draft text — a "ready" draft must not itself
  // assert a price/stock/clinical answer (catches English/non-keyword fabrications).
  if (!reason && result.type === 'draft') reason = detectSensitiveIntent(result.draft);

  if (!reason) return { result, triggered: false, reason: null };

  const o = OVERRIDE[reason];
  // Keep the model's needs_human draft ONLY if it is number-free; otherwise use
  // the canned override so a model-guessed number never reaches the composer.
  const keepModelDraft = result.type === 'needs_human' && !!result.draft && !hasNumbers(result.draft);
  return {
    result: {
      type: 'needs_human',
      draft: keepModelDraft ? result.draft : o.draft,
      used_kb: result.used_kb,
      note: o.note,
    },
    triggered: true,
    reason,
  };
}
