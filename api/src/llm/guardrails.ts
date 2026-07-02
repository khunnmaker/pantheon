import type { KbEntry } from '@prisma/client';
import type { DraftResult } from './parser.js';

export type SensitiveIntent = 'price_stock' | 'clinical' | 'payment' | null;

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
// Payment/transfer/account questions — the AI must never quote a bank account or confirm a
// payment itself; these always go to staff (the owner's "payment stays human" lane).
const PAYMENT = [
  // Thai — transfer / account / methods
  'โอน', 'สลิป', 'ชำระ', 'จ่ายเงิน', 'เงินสด', 'เลขบัญชี', 'เลขที่บัญชี', 'บัญชีธนาคาร', 'โอนเข้าบัญชี',
  'พร้อมเพย์', 'เก็บเงินปลายทาง', 'เก็บปลายทาง', 'มัดจำ', 'หลักฐานการโอน', 'ยอดชำระ',
  'บัตรเครดิต', 'บัตรเดบิต', 'รับบัตร', 'สแกนจ่าย', 'คิวอาร์',
  // English / romanized
  'promptpay', 'transfer', 'payment', 'bankaccount', 'qrcode', 'creditcard', 'debitcard', 'cod', 'cashondelivery',
];
// Payment ACTIONS the AI must never originate even inside an otherwise-answerable payment topic:
// disclosing a bank/PromptPay number, or confirming a transfer was received. These stay human.
const PAY_CONFIRM = [
  'ยอดเข้า', 'เงินเข้า', 'ได้รับเงิน', 'ได้รับยอด', 'ได้รับการชำระ', 'โอนเข้าเรียบร้อย',
  'ชำระเรียบร้อย', 'ตรวจสอบยอด', 'เช็กยอด', 'เช็คยอด',
];
const ACCOUNT_NUMBER = /[0-9๐-๙]{9,}/; // account / PromptPay length run (Thai accounts 10, PromptPay 10-13; only consulted in payment context)

// Lowercase, strip zero-width chars and ALL whitespace so spaced/zero-width/case
// tricks all collapse to a matchable form.
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[​‌‍﻿]/g, '')
    .replace(/\s+/g, '');
}

// A number adjacent to a currency unit, either postfix ("1500บาท") or prefix ("฿1500")
// (whitespace already stripped by normalize).
const PRICE_PATTERN = /[0-9๐-๙][0-9๐-๙,.]*(บาท|baht|thb|฿)|(?:บาท|baht|thb|฿)[0-9๐-๙]/;

function matches(text: string, words: string[]): boolean {
  const t = normalize(text);
  return words.some((w) => t.includes(normalize(w)));
}

export function detectSensitiveIntent(text: string): SensitiveIntent {
  // Clinical first — a medical question must always reach a professional.
  if (matches(text, CLINICAL)) return 'clinical';
  // Payment before price: "โอนเงินค่าสินค้า" is a payment matter, not a price quote.
  if (matches(text, PAYMENT)) return 'payment';
  if (matches(text, PRICE_STOCK) || PRICE_PATTERN.test(normalize(text))) return 'price_stock';
  return null;
}

// Does the text contain a number (price/qty/date)? The console requires an
// explicit confirm before sending any reply that contains numbers (spec §8).
export function hasNumbers(text: string): boolean {
  return /[0-9๐-๙]/.test(text || ''); // ASCII or Thai digits
}

// Price-like tokens in BOTH notations — postfix "1500บาท"/"1500฿" and prefix "฿1500"/"thb1500"
// — canonicalized to "<digits>บาท" so grounding comparison works across notations. Thousands
// separators stripped so "2,000 บาท" and "2000บาท" compare equal.
function priceTokens(s: string): string[] {
  const t = normalize(s).replace(/,/g, '');
  const post = t.match(/[0-9๐-๙]+(?:\.[0-9๐-๙]+)?(?=บาท|baht|thb|฿)/g) || [];
  // Prefix notation is ฿/THB/baht only — Thai never writes "บาท1500", and including บาท here
  // would turn "50 บาท 3 วัน" (whitespace-stripped) into a spurious "3บาท" token.
  const pre = t.match(/(?<=฿|thb|baht)[0-9๐-๙]+(?:\.[0-9๐-๙]+)?/g) || [];
  return [...post, ...pre].map((n) => `${n}บาท`);
}

// True if the text quotes a PRICE (a number next to a currency unit). Gates the
// send-time confirm so non-price numbers (dates, times, phone, quantities) don't nag.
export function hasPrice(text: string): boolean {
  return priceTokens(text).length > 0;
}

// True if every price the draft states also appears in a cited KB answer OR in
// the matched catalog products (extraGroundedText) — i.e. the number was copied
// from approved content / the price list, not invented. No price tokens = grounded.
function pricesGrounded(draftText: string, citedKb: KbEntry[], extraGroundedText = ''): boolean {
  const tokens = priceTokens(draftText);
  if (tokens.length === 0) return true;
  const grounded = new Set([
    ...priceTokens(citedKb.map((k) => k.answer).join(' ')),
    ...priceTokens(extraGroundedText),
  ]);
  return tokens.every((t) => grounded.has(t));
}

// Payment ACTIONS the AI must never originate: confirming a transfer was received (PAY_CONFIRM)
// or quoting a bank/PromptPay-length number. Price tokens (both notations) are stripped FIRST so
// a grounded big-ticket price ("125,000 บาท") isn't mistaken for an account number, and the run
// must be 9+ digits (Thai accounts 10, PromptPay 10-13) so order/tracking refs don't over-trigger.
function originatesPaymentAction(text: string): { accountNumber: boolean; confirmsPayment: boolean } {
  const norm = normalize(text);
  const confirmsPayment = PAY_CONFIRM.some((w) => norm.includes(normalize(w)));
  let t = norm.replace(/,/g, '');
  t = t.replace(/[0-9๐-๙]+(?:\.[0-9๐-๙]+)?(?:บาท|baht|thb|฿)/g, '');
  // Prefix strip is ฿/THB/baht only — stripping "บาท<digits>" could mask a REAL account
  // number that happens to follow the word บาท ("...เงินบาท 1234567890").
  t = t.replace(/(?:฿|thb|baht)[0-9๐-๙]+(?:\.[0-9๐-๙]+)?/g, '');
  t = t.replace(/[.\-]/g, '');
  return { accountNumber: ACCOUNT_NUMBER.test(t), confirmsPayment };
}

const OVERRIDE: Record<'price_stock' | 'clinical' | 'payment', { draft: string; note: string }> = {
  price_stock: {
    draft: 'ขอเช็กข้อมูลให้สักครู่นะคะ เดี๋ยวเจ้าหน้าที่ยืนยันให้อีกครั้งค่ะ 😊',
    note: 'คำถามเกี่ยวกับราคา/สต็อก — ต้องให้เจ้าหน้าที่ยืนยันข้อมูลปัจจุบัน (ห้ามเดาตัวเลข)',
  },
  clinical: {
    draft: 'เรื่องนี้ขอให้ทันตแพทย์/ผู้เชี่ยวชาญดูแลให้นะคะ เดี๋ยวเจ้าหน้าที่ติดต่อกลับค่ะ',
    note: 'คำถามเชิงคลินิก/การรักษา — ต้องให้ทันตแพทย์หรือผู้เชี่ยวชาญตอบ',
  },
  payment: {
    draft: 'เรื่องการชำระเงิน/โอนเงิน ขอเจ้าหน้าที่ยืนยันรายละเอียดให้นะคะ เดี๋ยวติดต่อกลับค่ะ',
    note: 'คำถามเกี่ยวกับการชำระเงิน/โอน/เลขบัญชี — ต้องให้เจ้าหน้าที่ยืนยัน (ห้าม AI ให้เลขบัญชีหรือยืนยันการชำระเอง)',
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
  groundedPriceText = '', // matched catalog product prices (M4) — trusted like KB
  groundedStock = false, // a matched product carries stock data → availability is grounded (M5)
): GuardrailOutcome {
  const sens = citedKb.map((k) => k.sensitivity);
  const kbClinical = sens.includes('clinical');
  const kbNoAuto = sens.includes('no_auto');
  const kbPriceStock = sens.includes('price_stock');

  const qReason = detectSensitiveIntent(question);
  const dReason = result.type === 'draft' ? detectSensitiveIntent(result.draft) : null;

  // Every price the draft states is grounded in cited KB or the matched catalog
  // products (a draft with no price tokens is trivially grounded).
  const grounded = pricesGrounded(result.draft, citedKb, groundedPriceText);
  // Does the draft actually QUOTE a grounded price? — distinguishes a real price
  // answer (allowed) from a stock/availability reply that only defers (escalate).
  const statesGroundedPrice = priceTokens(result.draft).length > 0 && grounded;

  const escalate = (
    reason: 'price_stock' | 'clinical' | 'payment',
    opts?: { keepDraft?: boolean },
  ): GuardrailOutcome => {
    const o = OVERRIDE[reason];
    // Keep the model's text only if it invents no price (grounded) and isn't clinical or
    // payment — so a polite "we'll check" and answerable parts survive, but the AI never
    // originates a bank account / payment confirmation or a clinical answer. Callers can
    // override via opts.keepDraft (e.g. an account-number hit that should stay visible to staff).
    const keep = (opts?.keepDraft ?? (reason !== 'clinical' && reason !== 'payment')) && !!result.draft && grounded;
    return {
      result: { type: 'needs_human', draft: keep ? result.draft : o.draft, used_kb: result.used_kb, note: o.note },
      triggered: true,
      reason,
    };
  };

  // 1. Clinical always reaches a professional — no exceptions.
  if (kbClinical || qReason === 'clinical' || dReason === 'clinical') return escalate('clinical');
  // 2. A KB topic a supervisor marked no_auto always escalates — checked before the payment
  //    pass so a supervisor's no_auto marking can never be bypassed by a payment-grounded pass.
  if (kbNoAuto) return escalate('price_stock');
  // 3. Payment: the AI MAY answer payment-method policy that's grounded in an APPROVED
  //    PAYMENT-RELATED KB entry (how to pay / cards / COD — the team marks those entries
  //    'normal' on purpose), but must NEVER originate a bank/PromptPay number or confirm a
  //    transfer was received — those stay human, even when KB-grounded. Any price quoted must
  //    still be grounded (no invented numbers). Citing an unrelated 'normal' KB entry does not
  //    count — the citation must actually be about payment.
  if (qReason === 'payment' || dReason === 'payment') {
    if (result.type === 'draft') {
      const action = originatesPaymentAction(result.draft);
      // AI confirming money was received → always replace with the canned deferral.
      if (action.confirmsPayment) return escalate('payment');
      // A bank-account-length digit run → flag for a human but KEEP the draft text (grounded
      // permitting) so a correct answer that merely contains a long ref/phone isn't lost.
      if (action.accountNumber) return escalate('payment', { keepDraft: true });
    }
    const paymentKb = citedKb.some((k) => matches([...k.questionVariants, k.answer].join(' '), PAYMENT));
    if (paymentKb && grounded) return { result, triggered: false, reason: null };
    return escalate('payment');
  }
  // 4. Price/stock: a grounded price answer (KB or catalog) OR an availability answer
  //    backed by real stock data passes — provided any price quoted is grounded (no
  //    invented numbers). Anything else price/stock-looking defers to staff.
  if (kbPriceStock || qReason === 'price_stock' || dReason === 'price_stock') {
    if (grounded && (statesGroundedPrice || groundedStock)) return { result, triggered: false, reason: null };
    return escalate('price_stock');
  }
  return { result, triggered: false, reason: null };
}
