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

// Price-like tokens (a number next to a currency unit), thousands-separators
// stripped so "2,000 บาท" and "2000บาท" compare equal.
function priceTokens(s: string): string[] {
  return normalize(s).replace(/,/g, '').match(/[0-9๐-๙]+(?:\.[0-9๐-๙]+)?(?:บาท|baht|thb|฿)/g) || [];
}

// True if every price the draft states also appears in a cited KB answer — i.e.
// the number was copied from supervisor-approved content, not invented by the AI.
// A draft with no price tokens is trivially grounded.
function pricesGrounded(draftText: string, citedKb: KbEntry[]): boolean {
  const tokens = priceTokens(draftText);
  if (tokens.length === 0) return true;
  const kbTokens = new Set(priceTokens(citedKb.map((k) => k.answer).join(' ')));
  return tokens.every((t) => kbTokens.has(t));
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

  // A cited KB entry that is itself sensitive → always escalate to staff, whatever
  // the model produced (the supervisor classified this topic as needing a human).
  let reason: SensitiveIntent = null;
  if (kbClinical) reason = 'clinical';
  else if (kbPriceStock) reason = 'price_stock';

  if (!reason) {
    // Backstop: the QUESTION or the AI's own DRAFT looks price/stock/clinical even
    // though no sensitive KB entry was cited (catches non-keyword fabrications).
    const qReason = detectSensitiveIntent(question);
    const dReason = result.type === 'draft' ? detectSensitiveIntent(result.draft) : null;
    reason = qReason || dReason;

    // Exception: a price/stock-looking answer whose every stated price is grounded
    // in a cited (supervisor-approved, non-sensitive) KB entry — e.g. the free-
    // shipping threshold — is NOT an AI guess. Trust it and let the draft through.
    if (reason === 'price_stock' && !!result.draft && pricesGrounded(result.draft, citedKb)) {
      return { result, triggered: false, reason: null };
    }
  }

  if (!reason) return { result, triggered: false, reason: null };

  const o = OVERRIDE[reason];
  // When escalating, keep the model's answer if it invents no price (every stated
  // price is grounded in cited KB) — so the answerable parts of a multi-question
  // burst, and grounded policy numbers, survive (still tagged needs_human for
  // review). Clinical always uses the canned text (no AI medical content); an
  // empty or price-inventing draft falls back to the canned text too.
  const keepModelDraft =
    reason !== 'clinical' && !!result.draft && pricesGrounded(result.draft, citedKb);
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
