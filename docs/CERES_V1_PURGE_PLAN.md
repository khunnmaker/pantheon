# Ceres — v1 purge (2026-07-19, owner-approved list)

Prod facts (verified in-container today): ZERO workflowVersion-1 CeresPaymentRequest rows
ever; carrier-cash movements = launch smoke only (last real 'refund' 07-06); 0 recurring
templates; `CEO_LINE_USER_ID` SET, `CERES_CEO_LINE_USER_ID` + `CERES_ALLOW_LEGACY_MEDIA_TOKENS`
NOT set. Nothing needs a wind-down window.

Owner decisions: (1) purge all of List A; (2) purge เบิกเงิน + รับเงินคืน manual cash forms
(keep ฝากเข้ากล่อง + เติมเงิน); (3) ประจำ recurring bills KEPT but its create button REWIRES
to the v2 request flow.

Phase A backend = Sol; Phase B frontend = sonnet. Sequential, this worktree only.
Guardrail for BOTH phases: the things that LOOK legacy but are v2-live must not be touched —
expense routes/queue (ตรวจใบเสร็จค่าใช้จ่าย), expense history/void, board + close + their math
(the type unions in computeBoard STAY — historical rows exist), movements deposit/topup,
exports, post-hoc expense AI, category admin.

## Phase A — backend (Sol, high)

1. `api/src/routes/ceres/requests.ts`:
   - v2-only creation: make `requestType` REQUIRED in the POST zod; delete the legacy
     (no-requestType) creation branch.
   - Delete legacy routes/branches: `POST /requests/:id/decide`, `POST /requests/:id/paid`,
     the legacy GET-list branch (treat every list as workflow-2 semantics; tolerate and
     ignore a `workflow` query param), and the workflowVersion-1 branches in the `:id` GET
     dispatcher and `/cancel` (a v1 row, should one ever appear, gets 404/409 — pick the
     existing error style).
   - Templates CRUD + `/templates/due` STAY untouched (read side feeds CEO missed-bills +
     digest; owner kept the feature).
2. `api/src/ceres/aiReview.ts`: delete `reviewPaymentRequest` (the v1 gate). ⚠️ BEFORE
   deleting any prompt constant, check which text `reviewStaffRequest` (v2) uses — if
   `POLICY_TEXT` is shared by the v2 screen, KEEP the constant and delete only the v1
   function; delete a prompt only if it becomes truly unreferenced.
3. `api/src/routes/ceres/statements.ts`: delete the v1 matching — the `'out'` lines ↔
   `CeresPaymentRequest(status:'paid')` block inside `autoMatchLines()` and the
   `paidRequestsUnreconciled` metric in `getStatementSummary()`. KEEP the `'in'` lines ↔
   CashMovement(topup/deposit) matching and the whole v2 transfer reconciliation.
4. `api/src/routes/ceres/ceo.ts` + `api/src/ceres/nightlyDigest.ts`: drop the v1 halves of
   the escalation OR-queries and the v1 `requestCounts`; serve v2-only shapes. Report the
   exact response-shape changes so Phase B can adjust consumers.
5. `api/src/routes/ceres/p1.ts` + `api/src/ceres/requestMoney.ts`: delete
   `POST /api/ceres/advances`, `POST /api/ceres/refunds`, and `createLegacyAdvance` (verify
   no other callers first). `POST/GET /movements` (deposit/topup) STAY.
6. Env cleanup: remove `CERES_CEO_LINE_USER_ID` (update its two fallback readers
   `api/src/line/owner.ts` and `api/src/routes/diana.ts` to `CEO_LINE_USER_ID` only) and
   `CERES_ALLOW_LEGACY_MEDIA_TOKENS` (+ its branch in `receiptLink.ts`) from `env.ts`.
7. Tests: delete/adjust tests of removed routes; ADD: POST /requests without requestType →
   400; /decide and /paid → 404; advances/refunds routes → 404; digest + ceo overview
   v2-only shapes. Run `npx vitest run ceres` (full ceres set), `npm run typecheck`,
   `npm run build` — all green, capture exit codes properly.

## Phase B — frontend (sonnet)

1. Delete `ceres/src/MdRequests.tsx` and every entry to it: mobile MoreMenu item
   "คำขอจ่ายเงินเดิม", desktop ประวัติ segment "คำขอเดิม" (History view simplifies to the
   expense history), any `goToRequestsWithPrefill` plumbing in `Md.tsx`.
2. Delete `ceres/src/Messenger.tsx` (already orphaned).
3. `ceres/src/MdMoney.tsx`: delete `AdvanceForm` + `RefundForm` (เบิกเงิน/รับเงินคืน).
   Keep ฝากเข้ากล่อง + เติมเงิน. Retitle the view/segment labels to match what remains
   (e.g. ฝาก/เติมเงิน) and update `MdBoard.tsx`'s opening-balance hint text to the new
   path wording. Keep the view key stable if other code references it.
4. `ceres/src/MdRecon.tsx`: remove the "กระทบยอดแบบเดิม" v1 section BUT preserve the
   เงินเข้า (topup/deposit) movement-matching UI — relocate/retitle it (e.g.
   "กระทบยอดเงินเข้า") so that shared capability survives intact.
5. Templates rewire (`ceres/src/MdTemplates.tsx`): "สร้างคำขอจ่าย" now opens the v2
   `RequestSheet` prefilled — requestType 'purchase' preselected (skip the type-picker
   step for prefill), amount + category from the template, reason = template name. Add a
   minimal optional `prefill` prop to `RequestSheet` rather than a new sheet; the normal
   staff flow must be byte-identical when the prop is absent (still no lazy defaults).
6. CEO mobile MoreMenu caption "เครื่องมือปฏิบัติการเดิม" → "เครื่องมือปฏิบัติการ".
7. `ceres/src/lib/api.ts`: remove client fns/types for deleted endpoints
   (legacy createRequest/listRequests/markRequestPaid/decide, createAdvance, createRefund);
   adjust CEO overview types to Phase A's reported shapes (`CeoOverview.tsx`,
   `CeoHome.tsx` RequestCountsSection simplification).
8. `docs/CERES_USER_GUIDE_TH.md`: update กล่องเงินสด wording (new ฝาก/เติมเงิน path for the
   opening balance), remove คำขอเดิม/กระทบยอดแบบเดิม references, note ประจำ's button now
   opens a v2 purchase request.
9. Verify: `cd ceres && npm run build` green (capture exit code); grep that no dangling
   imports/menu keys remain; `cd api && npx vitest run ceres` still green (api untouched
   by B).

## Acceptance
- Both builds + full ceres vitest green with explicit exit-code checks.
- No surface from the guardrail list changed except the two label/caption updates named.
- No new deps, no package-lock changes, no prisma schema/migration changes (pure removal —
  DB rows and tables stay; only code paths go).
