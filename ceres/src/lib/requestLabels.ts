// Shared display-label mapping for StaffRequest.(requestType, advanceVariant) — SSOT for
// every screen that renders a v2 request's kind (queues, history, exports, detail, CEO
// overview). See the 4-button request chooser (2026-07-23, owner-confirmed design):
// staff pick between FOUR named kinds up front — เบิกล่วงหน้า / เบิกย้อนหลัง / เบิกเงินไปซื้อ /
// ขอให้บริษัทซื้อ (see RequestSheet.tsx). On the wire this is still only requestType
// (advance/reimbursement/purchase) plus the additive advanceVariant column (only meaningful
// when requestType === 'advance') — every render site must import from here rather than
// keep its own copy so the mapping can never drift or leave a stale name on one screen
// (naming symmetry, owner rule).
import type { AdvanceVariant, V2RequestType } from './api';

// The four request "kinds" the chooser presents — each is a (requestType, advanceVariant)
// pair on the wire; advanceVariant only ever applies when requestType === 'advance'.
export type RequestKind = 'advance' | 'advance_purchase' | 'reimbursement' | 'purchase';

// `advanceVariant` may be missing/undefined on an old cached object that predates this
// column (pre-2026-07-23) — treated the same as null (a plain float advance), same
// fallback the server's own normalizeRequestInput uses.
export function requestKindOf(requestType: V2RequestType, advanceVariant?: AdvanceVariant | null): RequestKind {
  if (requestType === 'advance') return advanceVariant === 'purchase' ? 'advance_purchase' : 'advance';
  return requestType;
}

export function requestTypeOfKind(kind: RequestKind): V2RequestType {
  return kind === 'advance_purchase' ? 'advance' : kind;
}

export function advanceVariantOfKind(kind: RequestKind): AdvanceVariant | null {
  return kind === 'advance_purchase' ? 'purchase' : null;
}

export const REQUEST_KIND_LABEL: Record<RequestKind, string> = {
  advance: 'เบิกล่วงหน้า',
  advance_purchase: 'เบิกเงินไปซื้อ',
  reimbursement: 'เบิกย้อนหลัง',
  purchase: 'ขอให้บริษัทซื้อ',
};

// One-line hint shown under each of the chooser's 4 buttons (RequestSheet.tsx).
export const REQUEST_KIND_HINT: Record<RequestKind, string> = {
  advance: 'ขอเงินสดไว้ใช้จ่ายหลายรายการ ปิดยอดทีหลัง',
  reimbursement: 'จ่ายเองไปแล้ว แนบใบเสร็จขอคืนเงิน',
  advance_purchase: 'รู้ว่าจะซื้ออะไร ขอเงินไปจ่าย แล้วนำใบเสร็จ+เงินทอนมาคืน',
  purchase: 'แจ้งของที่ต้องการ ให้บริษัทเป็นคนซื้อให้',
};

// Order the 4 chooser buttons render in (2×2 grid on mobile) — เบิกล่วงหน้า / เบิกย้อนหลัง on
// row 1, เบิกเงินไปซื้อ / ขอให้บริษัทซื้อ on row 2 (mirrors the old front-door pairing: "get
// cash now" kinds first, "buy something specific" kinds second).
export const REQUEST_KIND_ORDER: readonly RequestKind[] = ['advance', 'reimbursement', 'advance_purchase', 'purchase'];

// Full display label for a request's kind — the one function every render site should call.
export function requestKindLabel(requestType: V2RequestType, advanceVariant?: AdvanceVariant | null): string {
  return REQUEST_KIND_LABEL[requestKindOf(requestType, advanceVariant ?? null)];
}

// Backward-compat base map keyed by requestType ALONE (no variant dimension) — for the one
// remaining call site that doesn't have advanceVariant to hand: CeoOverview's daily-outflow-
// by-lane/type bucket, which the backend groups by requestType only (see
// api/src/ceres/nightlyDigest.ts) — both advance variants bucket together under เบิกล่วงหน้า
// there, same as before this feature existed.
export const REQUEST_TYPE_LABEL: Record<V2RequestType, string> = {
  advance: REQUEST_KIND_LABEL.advance,
  reimbursement: REQUEST_KIND_LABEL.reimbursement,
  purchase: REQUEST_KIND_LABEL.purchase,
};
