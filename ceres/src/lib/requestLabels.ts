// Shared display-label mapping for StaffRequest.requestType — SSOT for every screen that
// renders a v2 request's type (queues, history, exports, detail, CEO overview). See the
// ขอเบิก front-door merge (2026-07-21, owner decision): staff pick between "เบิกล่วงหน้า" and
// "ขอเบิก" at the front door; the payer toggle underneath ขอเบิก decides reimbursement vs
// purchase on the wire (see RequestSheet.tsx). The backend request types are UNCHANGED —
// still exactly advance/reimbursement/purchase — only the display language merges. Every
// render site must import from here rather than keep its own สำรองจ่าย/ขอให้ซื้อ copy so the
// mapping can never drift or leave a stale name on one screen (naming symmetry, owner rule).
import type { V2RequestType } from './api';

// Full display label for a request's TYPE — advance unchanged; reimbursement/purchase both
// read as "ขอเบิก" with a payer-side qualifier so the two backend types still read distinctly
// without resurrecting the old สำรองจ่าย-ขอคืน / ขอให้ซื้อ names anywhere in the UI.
export const REQUEST_TYPE_LABEL: Record<V2RequestType, string> = {
  advance: 'เบิกล่วงหน้า',
  reimbursement: 'ขอเบิก · จ่ายเองแล้ว',
  purchase: 'ขอเบิก · ให้บริษัทจ่าย',
};

// The payer toggle shown inside RequestSheet once ขอเบิก is picked at the front door — NO
// pre-selection on a brand-new request (owner "no lazy defaults" rule); only an edit of an
// existing reimbursement/purchase request or a template prefill (purchase side) pre-sets it,
// per the same contextual-inherit exception the rest of the form already follows.
export type PayerChoice = 'reimbursement' | 'purchase';

export const PAYER_CHOICE_LABEL: Record<PayerChoice, string> = {
  reimbursement: 'จ่ายเองไปแล้ว · ขอคืนเงิน (แนบใบเสร็จ)',
  purchase: 'ยังไม่จ่าย · ให้บริษัทจ่ายให้',
};
