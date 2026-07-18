# Ceres — Simplified เบิกล่วงหน้า (advance) lane (2026-07-19)

Owner directive (Fable-authored plan): advances are the "quick money up front" lane —
the precise accounting happens later at liquidation (เคลียร์เงิน), where every expense
entry already gets its own category + receipt. So for requestType `advance` ONLY:

1. **NO AI pre-screen** — the request goes straight to the GM queue. (Owner explicitly
   reversed his 07-18 all-requests-pass-AI rule for advances only.)
2. **Reason optional** — เหตุผล may be empty.
3. **Multi-GROUP selection replaces the single category** — the requester picks ≥1
   category GROUP (the 7 group labels), not a specific category.

UNCHANGED (explicit): reimbursement + purchase keep AI screen, required reason, and the
single-category two-stage picker. The deterministic **>฿5,000 strictly-greater → CEO**
escalation still applies to advances (it is code, not AI). GM approval flow, payment
lanes, liquidation flow, and the negative-box close guard are untouched.

Phase A (backend) = Sol; Phase B (frontend) = sonnet. Sequential, this worktree only.

## Phase A — backend (Sol, high)

1. **Schema** (`api/prisma/schema.prisma`, model `CeresPaymentRequest`): add
   `categoryGroups String @default("")` — a JSON string array of group names, e.g.
   `["งานขนส่ง (เมสเซนเจอร์)","ยานพาหนะ/เดินทาง"]`. Used only by v2 advances; all other
   rows keep `""`. Migration = plain ADD COLUMN with default (no data backfill, NO
   CREATE INDEX CONCURRENTLY). Old advances keep their `category` string.

2. **Create/edit validation** (`api/src/ceres/requestService.ts` + the v2 zod schema in
   `api/src/routes/ceres/requests.ts`):
   - advance: accept `categoryGroups: string[]` (1..7, each trimmed non-empty);
     validate every entry against the DISTINCT `group` values of ACTIVE CeresCategory
     rows → else `invalid_group`. `category` becomes optional/'' for advance.
     `reason` optional for advance (store trimmed, may be '').
   - reimbursement/purchase: byte-identical behavior to today (category required +
     active-check, reason required, categoryGroups must be absent/empty).
   - edit path: same rules; an UNCHANGED categoryGroups value on edit is accepted even
     if a group has since vanished (mirror the existing unchanged-category tolerance).

3. **AI skip** (`requestService.ts` / `aiReview.ts`): on create, an advance NEVER enters
   `ai_review_pending` — it lands directly in the same status a clean AI pass produces
   (pending GM decision), with a `CeresRequestEvent` payload noting
   `ai: 'skipped_by_policy'`. No `CeresAIReview` row. Consequences to verify in code:
   the ai_review_pending 409 decision-gate simply never fires for advances;
   `ageStuckAIReviews` untouched; `reviewStaffRequest` must never be invoked for an
   advance (guard it — return early with a log if called). The deterministic >5k CEO
   requirement must still attach to advances exactly as today (test it).

4. **Read surfaces**: wherever v2 request `category` is serialized (list/detail
   endpoints, `exports.ts` requests.csv, nightly digest if it prints category), an
   advance with categoryGroups shows the groups joined with " · " in the existing
   category field/column (fallback: old advances keep their stored category). Add a
   tiny shared helper (e.g. `requestCategoryLabel(req)`) rather than five ad-hoc joins.

5. **Tests** (vitest, existing ceres patterns): advance create w/ 2 groups →
   status = pending GM (never ai_review_pending), event notes skip, no AI review row;
   `invalid_group` on unknown/inactive-only group; reason '' accepted for advance,
   still rejected for purchase; reimbursement still enters ai_review_pending;
   >5,001 advance still requires CEO after GM approve; edit keeps unchanged groups.
   Run: prisma generate, `npx vitest run ceres`, `npm run typecheck`, `npm run build`.

Phase A does NOT touch `ceres/` frontend.

## Phase B — frontend (sonnet)

1. **api.ts**: request payload/type gains `categoryGroups?: string[]`; expose the
   joined label logic for display parity if the backend serializes it (prefer using
   the backend-provided label; do not duplicate join logic if the API already sends it).

2. **RequestSheet.tsx** — advance form only:
   - Replace the CategoryPicker with a **multi-select group chip row**: the 7 group
     labels (derive distinct groups from `bootstrap.categories` in sortOrder), toggle
     on tap, soft-amber selected state (copy the open-group chip classes from
     CategoryPicker verbatim), helper line "เลือกได้มากกว่า 1 กลุ่ม". ≥1 required —
     inline error "เลือกกลุ่มอย่างน้อย 1 กลุ่ม" per the form's existing pattern.
   - เหตุผล field: label becomes "เหตุผล (ไม่บังคับ)", validation removed for advance.
   - reimbursement/purchase paths: pixel-identical to today (CategoryPicker + required
     reason). Editing an OLD advance (has category, empty groups): show its category
     as a read-only note and require picking groups only if the user changes anything
     relevant — simplest acceptable: prefill groups with the group of its category.
3. **Display surfaces** (`MyRequests.tsx`, `RequestDetail.tsx`, GM/CEO queues): show
   the joined groups where category shows today for advances (use the API-provided
   label per B1). `RequestDetail` liquidation: keep `defaultEntity`, but do NOT pass a
   `defaultCategory` for group-based advances (staff picks per expense — consistent
   with the no-defaults rule).
4. **GM queue note**: advances show no "เหตุผลจาก AI" — ensure the AI block renders
   nothing (not a broken empty card) for advances.
5. **Docs** (`docs/CERES_USER_GUIDE_TH.md`): update the advance rows: no AI step, reason
   optional, multi-group selection; GM section: advances arrive without an AI verdict.

## Shared acceptance
- api + ceres builds green; targeted ceres vitest green; no lockfile changes; no new deps.
- Reimbursement/purchase flows and all pre-existing requests render exactly as before.
