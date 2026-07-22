# Ceres desktop nav — flat tab strip (2026-07-18, CEO one-flow update 2026-07-21)

Scope: `ceres/` frontend, desktop (≥1024px) layout for roles **gm** and **ceo**
(bootstrap.role; raw agent.role `gm`/`supervisor`), plus the GM mobile shortcut into the
shared staff request flow.

The strip lives in `ceres/src/Md.tsx` (`ManagementApp`, shared by both `NeeApp`/`CeoApp`): a
`hidden lg:flex` FLAT tab strip below the existing header row — 7 tabs for GM, 7 for CEO (the
CEO strip was 8 tabs until the 2026-07-21 CEO one-flow update folded รอ CEO into ภาพรวม — see
"CEO one-flow" below), no group captions and no divider bars (simplified down from the earlier
14-tab grouped strip; see git history for that version). Same visual grammar as before: amber
active-tab underline, red pill count badges, horizontal-scroll overflow via `lg:flex-wrap`
fallback. The mobile bottom nav + "back to more" button are still `lg:hidden`; nothing about
mobile changed.

## Final strip

**GM (Nee)** — lands on อนุมัติ (no big-button home on desktop):
`อนุมัติ(●queue+legacy) · เบิกล่วงหน้า(●fulfillment) · โอน/สลิป(●recon) · กล่องเงินสด · ประวัติ · ของฉัน · อื่นๆ`

**CEO (supervisor)** — lands on ภาพรวม (oversight — now leads with the escalations queue, no
separate รอ CEO tab):
`ภาพรวม(●escalations) · เบิกล่วงหน้า(●fulfillment) · โอน/สลิป(●recon) · กล่องเงินสด · ประวัติ · ของฉัน · อื่นๆ`

Tab renamed รอจ่าย → **เบิกล่วงหน้า** for both roles (Ceres approve-is-pay one-flow,
2026-07-22 — see that section below); the `View` keys (`fulfillment` / `legacy-fulfillment`)
and hashes are unchanged, only the label + page content re-centered.

## CEO one-flow (2026-07-21)

Three changes landed together on the CEO side of this strip:

1. **รอจ่าย label unified.** CEO's fulfillment tab was named "จ่าย/ซื้อ" (and the matching
   MoreMenu entry under "เครื่องมือปฏิบัติการ" too); both now say **"รอจ่าย"**, matching GM's
   tab for the identical `NeeFulfillmentQueue` destination. Same rename in
   `docs/CERES_USER_GUIDE_TH.md`.
2. **"อนุมัติและจ่ายเลย" on the CEO escalation queue.** `EscalationCard` (in `CeoOverview.tsx`,
   shared by `EscalationsSection`) mirrors `NeeApprovalQueue.tsx`'s GM combined action: a full
   width amber "อนุมัติและจ่ายเลย" button sits above the "CEO อนุมัติ"/"ปฏิเสธ" pair. Tapping it
   calls `ceoDecisionV2(id, 'approve')`, then folds the SAME card in place into the shared
   `PayPanel.tsx` (one-tap cash lane, slip-mandatory transfer, receipt-mandatory two-step
   purchase, `insufficient_cash` balance message) — identical mechanics to the GM lane, just
   reached through the CEO decision endpoint instead of the GM one. Unlike the GM version there
   is **no forward/amount gate**: every card in the CEO queue is already the final decision
   (escalated for >฿5k or an AI flag — `decideStaffRequestByCeo()` always resolves `approve` to
   `'approved'`, never to a further-pending state), so the combined button is always offered.
   `EscalationsSection` owns a local `paying: Record<id, StaffRequest>` map (mirrors
   `NeeApprovalQueue`'s `paying` state) so the fold survives across `escalations` prop
   refreshes; `EscalationCard` gets a separate `payBusy` flag so the plain "CEO อนุมัติ"
   button's spinner never cross-fires with the combined button's. Applies wherever
   `EscalationsSection`/`EscalationCard` render — desktop ภาพรวม, mobile CeoHome, and mobile
   ภาพรวมย้อนหลัง (`ceo-history`) — since it's the shared card itself, not new nav (the "mobile
   untouched" rule for this pass's other two changes doesn't apply here).
3. **รอ CEO tab folded into ภาพรวม.** CEO strip drops from 8 tabs to 7: `EscalationsSection` was
   already the first section `CeoOverview` renders (see its component body), so no markup moved
   — removing the redundant standalone `ceo-queue` tab/view was the entire change. Its red pill
   count (`ceoBadges.queue`) now sits on the ภาพรวม tab instead. The `ceo-queue` `View` key is
   kept (see the type's own comment in `Md.tsx`) purely so a stale/shared `#ceo-queue` hash
   still resolves somewhere sane: `ceoQueueRedirect` sends it to `home` (ภาพรวม) — ungated by
   `isDesktop`, unlike the other `desktop*Redirect` consts, because `ceo-queue` was never a
   mobile destination either and mobile's `CeoHome` also renders `EscalationsSection` near its
   top, so `home` is a reasonable landing there too.

## Ceres approve-is-pay one-flow (2026-07-22)

Owner directive: "อนุมัติ = จ่าย" — GM/CEO approval of an advance or reimbursement no longer
has a separate combined-action button; อนุมัติ itself now asks the lane and approves + pays in
ONE server transaction (`POST /api/ceres/requests/:id/decide-and-pay`, see
`api/src/ceres/requestDecideAndPay.ts`). Four changes:

1. **The 2026-07-21 "อนุมัติและจ่ายเลย" combined-action button is GONE** from both
   `NeeApprovalQueue.tsx`'s GM card and `CeoOverview.tsx`'s `EscalationCard` — there is no
   longer a plain decide-only path shown alongside a separate pay-fold button. Instead, the
   plain **"อนุมัติ"** tap itself (for a card whose predicate would have approved directly —
   the same `!forward`/no-amount-gate logic as before) makes NO API call: it just expands the
   shared `PayPanel` in place (new `mode="decideAndPay"` prop — see `PayPanel.tsx`), which asks
   จ่ายเงินสด (one tap) / โอนเงิน (slip + confirm) / ยกเลิก (true no-op, no call made yet). The
   lane tap is what actually calls the composite endpoint. Cards whose predicate escalates
   (GM: `willForward`; CEO: none, every card is final) keep a plain decide-only button — no
   lane question, since there's nothing to pay yet on the GM side, and the CEO side gets its
   own three-way choice below instead.
2. **CEO's lane question gets a third choice — "ให้ GM จ่ายทีหลัง".** `PayPanel` gained an
   `extraAction` prop (label + onClick + busy), rendered as an extra full-width button on the
   un-expanded lane-choice screen only (never on the transfer-expanded or purchase screens).
   `EscalationCard` is the only caller that passes it: `onClick` runs the PLAIN `ceoDecisionV2`
   approve (no payment) for a CEO approving remotely with no cash/slip in hand — the request
   then lands in the residual pay-queue for the GM to record the hand-over.
3. **PayPanel is prop-switched, not forked.** `mode?: 'fulfill' | 'decideAndPay'` (default
   `'fulfill'`) picks which endpoint the lane tap drives — `fulfillStaffRequest` (existing,
   request already approved) vs the new `decideAndPayStaffRequest` (request still
   pending_nee/pending_ceo). Same component, same error mapping, same evidence rules — it
   can't drift between the รอจ่าย queue's plain fulfillment and the one-flow's approve+pay.
   `decideAndPayStaffRequest`'s `outcome: 'escalated'` result (GM's prediction turned out
   wrong — AI verdict flipped between load and tap) still resolves `onDone` with no error, just
   different wording ("ส่งต่อ CEO แล้ว รออนุมัติก่อนจ่าย" instead of "อนุมัติและจ่ายเงินแล้ว").
4. **รอจ่าย tab renamed เบิกล่วงหน้า and re-centered** (`NeeFulfillmentQueue.tsx`, `Md.tsx`'s
   tab labels + MoreMenu entry). Primary/headline section is now
   "เงินเบิกล่วงหน้าที่ยังไม่ปิดยอด" (outstanding advances awaiting liquidation — unchanged
   component, `LiquidationCard`, just moved to the top with its count in the section header).
   The old รอจ่ายเงิน pay-queue section (`FulfillCard`, `toFulfill` filter — unchanged) moved
   BELOW it, retitled "รอจ่าย/รอใบเสร็จ", and now renders ONLY when non-empty — normally
   invisible, since approve+pay for advance/reimbursement no longer leaves anything sitting in
   it. Purchases (still receipt-mandatory two-step) and CEO's "ให้ GM จ่ายทีหลัง" hand-overs
   are what can still populate it. View keys/hashes (`fulfillment`, `legacy-fulfillment`)
   untouched; the tab badge (`gmCounts.fulfillment` / `ceoBadges.fulfillment`) already sourced
   from the SAME `approvalStatus==='approved' && fulfillmentStatus==='unfulfilled'` filter as
   the residual section, so no badge-wiring change was needed — see "Badge sourcing" below.

Backend shape: `POST /api/ceres/requests/:id/decide-and-pay { decision:'approve', lane,
transferSlipUploadId?, note?, idempotencyKey? }`. Advance/reimbursement only (purchase → 400
`invalid_request_type`, keeping its mandatory-receipt two-step via the existing
`nee/ceo-decision` → `fulfill` routes, both untouched). Runs the decision write and the
`recordRequestMoneyEventInTx` payment inside ONE `prisma.$transaction` — a GM escalation
commits the decision alone (no money moves); any money-side failure (`insufficient_cash`,
missing transfer slip) rolls back the decision too, so the request lands back exactly at
pending_nee/pending_ceo. Idempotent replay (same `idempotencyKey`) short-circuits before the
decision write, returning the first call's result unchanged. See
`api/src/ceres/requestDecideAndPay.ts` and its test file `api/test/ceresDecideAndPay.test.ts`.

## Destination map (Tab → View key → component(s))

| Tab label | View key | Component | GM | CEO |
|---|---|---|---|---|
| อนุมัติ | `approvals` (desktop) | **Composed**: `NeeApprovalQueue` (v2 queue) + section header + `MdApproval` (legacy expense check) below | ✓ | — |
| เบิกล่วงหน้า | `fulfillment` / `legacy-fulfillment` | NeeFulfillmentQueue (same component, two role-gated View keys, pre-existing) — labeled "จ่าย/ซื้อ" (CEO) until the 2026-07-21 unify-with-GM rename, then "รอจ่าย" (both) until the 2026-07-22 approve-is-pay tab refocus renamed it again and re-centered its content (see that section below) | ✓ | ✓ |
| โอน/สลิป | `recon` | MdRecon (incl. TransferReconciliationPanel) | ✓ | ✓ |
| กล่องเงินสด | `cashbox` | **Composed**: internal segmented control, ritual order — บอร์ด (MdBoard, default) · ฝากเงิน (MdMoney) · ปิดวัน (MdClose) | ✓ | ✓ |
| ประวัติ | `history` | **Composed**: internal segmented control — ค่าใช้จ่าย (MdExpenses, default) · คำขอเดิม (MdRequests) | ✓ | ✓ |
| ของฉัน | `my-submit` | StaffHome `embeddedView="home"` (submit button + recent 5 + "ดูคำขอทั้งหมด" → `my-requests`) — single tab, replaces the old ส่งคำขอ/คำขอ pair | ✓ | ✓ |
| อื่นๆ | `other` | **Composed**: internal segmented control — ประจำ (MdTemplates, default) · ส่งออก (WeeklyPackSection) · ตั้งค่า (Settings) | ✓ | ✓ |
| ภาพรวม | `home` | **CeoOverview** with `showDailyOutflow`, `EscalationsSection` FIRST (รออนุมัติ queue, was its own รอ CEO tab until the 2026-07-21 merge) then date-picker + cash + daily outflow by lane/type + AI reviews + flagged expenses + missed bills + settlement + request counts + weekly pack, defaulting to today. Replaces the old separate วันนี้ (CeoHome) / ย้อนหลัง (CeoOverview) pair with no content loss — see "Judgment calls" below. | — | ✓ |

Every tab maps onto an EXISTING mobile destination (moreGroups, or NeeHome/CeoHome's
shortcuts) or a composed screen built purely from existing components — nothing new was added
except the internal segmented controls and the `ApprovalsComposedView` header divider text.

### Old individual keys still work — mapped/redirected on desktop, untouched on mobile

Mobile (<1024px) keeps every individual view key exactly as before: role homes (NeeHome/
CeoHome/StaffHome), MoreMenu, and each bare screen (`board`, `money`, `close`, `expenses`,
`requests`, `templates`, `legacy-approval`, `ceo-history`, `my-requests`, ...) render
byte-for-byte unchanged — none of that markup was touched.

On desktop, a handful of `desktop*Redirect` consts in `ManagementApp` fold the old individual
keys into whichever composed tab now contains them, so a stale hash, a MoreMenu-style
`setView('money')`, or a prefill/badge-tap flow (`goToApprovalWithPrefill`,
`goToRequestsWithPrefill`) never dead-ends — it lands on the composed tab, pre-primed to the
right internal segment:

- `board` / `money` / `close` → `cashbox` tab, segment primed to match.
- `expenses` / `requests` → `history` tab, segment primed to match.
- `templates` / `exports` / `settings` → `other` tab, segment primed to match.
- `legacy-approval` → `approvals` tab **for GM only** (CEO has no composed อนุมัติ destination
  in the 7-tab strip — see judgment call below).
- `ceo-history` → `home` tab (now CeoOverview on desktop, same component `ceo-history` already
  rendered).
- `ceo-queue` → `home` tab (2026-07-21 — the old รอ CEO tab folded into ภาพรวม; unlike the
  redirects above this one is NOT gated on `isDesktop`, since `ceo-queue` was never reachable
  from mobile UI either and `home` is a sane landing on both viewports for CEO).
- `home` (gm only) → `approvals` tab (pre-existing redirect, unchanged).

## Badge sourcing (all reused, no new endpoints)
- อนุมัติ (GM): `listStaffRequests('queue', 200).requests.length` (same call NeeHome already
  makes) **+** `listExpenses({ scope: 'all', status: 'pending' }).expenses.length` (same
  default call MdApproval itself makes) — v2 queue count plus legacy pending-expense count,
  summed into one badge.
- เบิกล่วงหน้า: `listStaffRequests('all', 300)` filtered `approvalStatus==='approved' && fulfillmentStatus==='unfulfilled'` — same filter NeeHome/NeeFulfillmentQueue already use. Since the 2026-07-22 approve-is-pay one-flow this filter is now the RESIDUAL pay-queue only (purchases awaiting receipt, CEO-approved-remotely hand-overs) — outstanding advances awaiting liquidation are NOT counted here (they're the tab's headline content, not its badge). The badge is normally 0/absent.
- โอน/สลิป (GM): `getTransferReconciliation()` unmatched count — same call NeeHome already makes.
- โอน/สลิป (CEO): `getCeoOverview(today).transferReconciliation.unmatched` — already part of the CeoHome/CeoOverview fetch, no extra call.
- ภาพรวม (CEO): `getCeoOverview(today).escalations.length` — same call CeoHome already makes; moved here from the old รอ CEO tab (2026-07-21) with no new call.
- กล่องเงินสด / ประวัติ / ของฉัน / อื่นๆ: no badge.

Badges are gated on `isDesktop` (a `window.matchMedia('(min-width: 1024px)')` hook local to
Md.tsx) so mobile never pays for the extra requests, and re-fetch on every tab switch for a
"live" count without adding a push channel.

## Judgment calls worth a second look
1. **CEO's ภาพรวม tab uses CeoOverview, not CeoHome** — CeoOverview already defaults its date
   picker to today, and adds AI reviews, missed bills, request-count chips, and the weekly CSV
   pack that CeoHome lacked. CeoHome's "รายจ่ายวันนี้ ตามช่องทาง/ประเภท" breakdown was
   preserved by extraction: it now lives as `DailyOutflowSection` (exported from
   CeoOverview.tsx, identical markup; CeoHome renders the extracted component so mobile output
   is unchanged) and the desktop ภาพรวม tab renders it via CeoOverview's `showDailyOutflow`
   prop. The data was already on the wire — `getCeoOverview(date)` returns `dailyOutflow`
   scoped to the requested day (api/src/routes/ceres/ceo.ts `dailyOutflowSummary(range)`) —
   so it follows the date picker with zero API changes; when the picked date isn't today the
   section title swaps to "รายจ่ายตามช่องทาง/ประเภท" (no "วันนี้"). `showDailyOutflow`
   defaults off so the mobile ภาพรวมย้อนหลัง screen (`ceo-history`) stays byte-identical.
   CeoHome's other extra, the small "กระทบยอดโอนเงิน" unmatched-count widget, is superseded by
   the dedicated โอน/สลิป tab (MdRecon), which shows strictly more detail — not a real loss.
2. **CEO has no "อนุมัติ" composed destination.** The CEO strip has no tab for the legacy
   expense-check screen (MdApproval) — only GM's อนุมัติ composes it in. If CEO reaches
   `legacy-approval` (MoreMenu on mobile, or a badge-tap from MdBoard's "รอตรวจ" party chip
   inside the CEO's own กล่องเงินสด tab), it renders standalone on desktop too (same bare
   `MdApproval` mobile already used) rather than redirecting into a tab that doesn't exist for
   CEO — functional, not a dead end, but no strip tab lights up while it's showing.
3. **ของฉัน merges the old ส่งคำขอ/คำขอ pair into StaffHome's `embeddedView="home"`** (submit
   button + recent 5 + status list), per the owner's spec. The old auto-open-the-compose-sheet
   behavior (`openRequestOnMount`) is now a one-shot flag (`autoOpenOwnRequest`) set only by
   NeeHome/CeoHome's mobile "ส่งคำขอเงิน" shortcut before navigating — the desktop ของฉัน tab
   click itself does NOT auto-pop the sheet (it's a normal browsable landing now, not a
   "compose immediately" shortcut), matching "the submit button + status list" wording.
4. **Active-tab color is amber** (Ceres's own brand color) — unchanged from the prior grouped
   strip, kept for consistency with the rest of this header/nav.
5. **รอ CEO folding into ภาพรวม didn't need to move any markup** (2026-07-21) — `EscalationsSection`
   was already the first thing `CeoOverview` rendered (see `CeoOverview.tsx`'s own component
   body), so CEO's escalations queue was ALWAYS at the top of the old ภาพรวม tab's content too;
   removing the separate รอ CEO tab just stopped duplicating it as its own destination. The one
   real behavior change is `EscalationCard` itself gaining the "อนุมัติและจ่ายเลย" combined
   action (see the "CEO one-flow" section above) — that lands on every screen the card renders
   on (desktop ภาพรวม, mobile CeoHome, mobile ceo-history), not just the merged tab.

## Verification
- `npm ci` at worktree root (workspaces; no lockfile touched).
- `cd ceres && npm run typecheck` → clean (`tsc -b`, no errors).
- `cd ceres && npm run build` → clean (`tsc -b && vite build`, dist emitted, only the
  pre-existing >500kB chunk-size warning, unrelated to this change).
- No ceres/juno frontend test framework exists (confirmed via search) — nothing to run there.
- No new backend endpoint was added, so no new API tests were needed; the API/backend was not
  touched at all (0-line diff).
- `git diff` against every mobile-only component (StaffHome, NeeHome, MoreMenu, all Nee*/Md*
  screens, Settings, Ceres.tsx, App.tsx) returns 0 lines. CeoHome.tsx's only diff is the
  DailyOutflowSection extraction (identical rendered markup); CeoOverview.tsx gained the
  extracted section + the default-off `showDailyOutflow` prop (mobile `ceo-history` renders
  without it — output unchanged). Source files changed: `ceres/src/Md.tsx`,
  `ceres/src/CeoHome.tsx`, `ceres/src/CeoOverview.tsx`.

## Verification — 2026-07-21 CEO one-flow
- `npm ci` at worktree root (workspaces; no lockfile touched).
- `cd ceres && npm run build` (`tsc -b && vite build`) → exit 0, clean, only the same
  pre-existing >500kB chunk-size warning as before.
- No ceres/juno frontend test framework exists — nothing to run.
- No backend endpoint added or changed — `api/` diff is 0 lines; the CEO pay-fold reuses the
  existing `ceo-decision` and `fulfill` endpoints exactly as `NeeApprovalQueue.tsx` already
  reuses `nee-decision` and `fulfill` (both already allow role `ceo` per
  `requireCeresRole('gm', 'ceo')` on `/fulfill` — confirmed by reading
  `api/src/routes/ceres/requests.ts`, not edited).
- Source files changed: `ceres/src/CeoOverview.tsx` (EscalationsSection/EscalationCard gain
  the pay-fold — see "CEO one-flow" above), `ceres/src/Md.tsx` (7-tab CEO strip, รอจ่าย
  rename, ceo-queue redirect, badge/effect cleanup), `docs/CERES_DESKTOP_NAV.md`,
  `docs/CERES_USER_GUIDE_TH.md`. `ceres/src/CeoHome.tsx` untouched (0-line diff) — it already
  rendered `EscalationsSection` near its top, so it inherits the pay-fold behavior for free
  with no changes of its own, matching the brief's "mobile CeoHome untouched" rule for the
  nav-merge itself.

## Verification — 2026-07-22 approve-is-pay one-flow
- Backend: `cd api && npm run build` (`tsc -p tsconfig.json`) → exit 0, clean.
- Backend: `cd api && npx vitest run` → 681 passed (663 pre-existing + 18 new in
  `test/ceresDecideAndPay.test.ts`), 0 failed. `api/.env` copied from `.env.example` (dummy
  values) to satisfy the env schema — matches the repo's existing test convention.
- Frontend: `cd ceres && npm run typecheck` (`tsc -b`) → clean.
- Frontend: `cd ceres && npm run build` (`tsc -b && vite build`) → exit 0, clean, only the
  same pre-existing >500kB chunk-size warning as before.
- No ceres/juno frontend test framework exists — nothing to run there.
- Source files changed: `api/src/ceres/requestDecideAndPay.ts` (new), `api/src/ceres/requestService.ts`
  (additive `invalid_request_type` error code), `api/src/routes/ceres/requests.ts` (new
  `/decide-and-pay` route), `api/test/ceresDecideAndPay.test.ts` (new); `ceres/src/lib/api.ts`
  (`decideAndPayStaffRequest` client + `DecideAndPayResult` type), `ceres/src/PayPanel.tsx`
  (`mode`/`extraAction` props), `ceres/src/NeeApprovalQueue.tsx` (amber button removed, อนุมัติ
  opens the inline lane question), `ceres/src/CeoOverview.tsx` (`EscalationCard` same
  replacement + third "ให้ GM จ่ายทีหลัง" choice, `paying`-map plumbing removed),
  `ceres/src/NeeFulfillmentQueue.tsx` (section order/visibility flip, header rename), `ceres/src/Md.tsx`
  (tab label rename to "เบิกล่วงหน้า" for GM/CEO + MoreMenu + mobile bottom-nav "Advance"),
  `docs/CERES_USER_GUIDE_TH.md`, `docs/CERES_DESKTOP_NAV.md`.
