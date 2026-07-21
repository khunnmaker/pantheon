# Ceres desktop nav — flat tab strip (2026-07-18)

Scope: `ceres/` frontend, desktop (≥1024px) layout for roles **gm** and **ceo**
(bootstrap.role; raw agent.role `gm`/`supervisor`), plus the GM mobile shortcut into the
shared staff request flow.

The strip lives in `ceres/src/Md.tsx` (`ManagementApp`, shared by both `NeeApp`/`CeoApp`): a
`hidden lg:flex` FLAT tab strip below the existing header row — 7 tabs for GM, 8 for CEO, no
group captions and no divider bars (simplified down from the earlier 14-tab grouped strip; see
git history for that version). Same visual grammar as before: amber active-tab underline, red
pill count badges, horizontal-scroll overflow via `lg:flex-wrap` fallback. The mobile bottom
nav + "back to more" button are still `lg:hidden`; nothing about mobile changed.

## Final strip

**GM (Nee)** — lands on อนุมัติ (no big-button home on desktop):
`อนุมัติ(●queue+legacy) · รอจ่าย(●fulfillment) · โอน/สลิป(●recon) · กล่องเงินสด · ประวัติ · ของฉัน · อื่นๆ`

**CEO (supervisor)** — lands on ภาพรวม (oversight), leading tab is รอ CEO:
`รอ CEO(●escalations) · ภาพรวม · จ่าย/ซื้อ(●fulfillment) · โอน/สลิป(●recon) · กล่องเงินสด · ประวัติ · ของฉัน · อื่นๆ`

## Destination map (Tab → View key → component(s))

| Tab label | View key | Component | GM | CEO |
|---|---|---|---|---|
| อนุมัติ | `approvals` (desktop) | **Composed**: `NeeApprovalQueue` (v2 queue) + section header + `MdApproval` (legacy expense check) below | ✓ | — |
| รอจ่าย / จ่าย/ซื้อ | `fulfillment` / `legacy-fulfillment` | NeeFulfillmentQueue (same component, two role-gated View keys, pre-existing) | ✓ | ✓ |
| โอน/สลิป | `recon` | MdRecon (incl. TransferReconciliationPanel) | ✓ | ✓ |
| กล่องเงินสด | `cashbox` | **Composed**: internal segmented control, ritual order — บอร์ด (MdBoard, default) · ฝากเงิน (MdMoney) · ปิดวัน (MdClose) | ✓ | ✓ |
| ประวัติ | `history` | **Composed**: internal segmented control — ค่าใช้จ่าย (MdExpenses, default) · คำขอเดิม (MdRequests) | ✓ | ✓ |
| ของฉัน | `my-submit` | StaffHome `embeddedView="home"` (submit button + recent 5 + "ดูคำขอทั้งหมด" → `my-requests`) — single tab, replaces the old ส่งคำขอ/คำขอ pair | ✓ | ✓ |
| อื่นๆ | `other` | **Composed**: internal segmented control — ประจำ (MdTemplates, default) · ส่งออก (WeeklyPackSection) · ตั้งค่า (Settings) | ✓ | ✓ |
| รอ CEO | `ceo-queue` | `EscalationsSection` (exported from CeoOverview.tsx, reused as-is) fed by `getCeoOverview(today).escalations` | — | ✓ |
| ภาพรวม | `home` | **CeoOverview** with `showDailyOutflow` (date-picker + escalations + cash + daily outflow by lane/type + AI reviews + flagged expenses + missed bills + settlement + request counts + weekly pack), defaulting to today. Replaces the old separate วันนี้ (CeoHome) / ย้อนหลัง (CeoOverview) pair with no content loss — see "Judgment calls" below. | — | ✓ |

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
  in the new 8-tab strip — see judgment call below).
- `ceo-history` → `home` tab (now CeoOverview on desktop, same component `ceo-history` already
  rendered).
- `home` (gm only) → `approvals` tab (pre-existing redirect, unchanged).

## Badge sourcing (all reused, no new endpoints)
- อนุมัติ (GM): `listStaffRequests('queue', 200).requests.length` (same call NeeHome already
  makes) **+** `listExpenses({ scope: 'all', status: 'pending' }).expenses.length` (same
  default call MdApproval itself makes) — v2 queue count plus legacy pending-expense count,
  summed into one badge.
- รอจ่าย / จ่าย/ซื้อ: `listStaffRequests('all', 300)` filtered `approvalStatus==='approved' && fulfillmentStatus==='unfulfilled'` — same filter NeeHome/NeeFulfillmentQueue already use.
- โอน/สลิป (GM): `getTransferReconciliation()` unmatched count — same call NeeHome already makes.
- โอน/สลิป (CEO): `getCeoOverview(today).transferReconciliation.unmatched` — already part of the CeoHome/CeoOverview fetch, no extra call.
- รอ CEO: `getCeoOverview(today).escalations.length` — same call CeoHome already makes.
- กล่องเงินสด / ประวัติ / ของฉัน / อื่นๆ / ภาพรวม: no badge.

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
2. **CEO has no "อนุมัติ" composed destination.** The new 8-tab CEO strip has no tab for the
   legacy expense-check screen (MdApproval) — only GM's อนุมัติ composes it in. If CEO reaches
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
