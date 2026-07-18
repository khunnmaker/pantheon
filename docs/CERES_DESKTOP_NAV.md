# Ceres desktop nav — tab grouping (2026-07-18)

Scope: `ceres/` frontend only, desktop (≥1024px) layout for roles **gm** and **ceo**
(bootstrap.role; raw agent.role `gm`/`supervisor`). Staff/messenger and all mobile (<1024px)
markup are untouched — verified via `git diff` returning 0 lines for every other component
file (StaffHome, NeeHome, CeoHome, CeoOverview, MoreMenu, all Nee*/Md* legacy screens,
Settings, Ceres.tsx, App.tsx).

Implementation lives entirely in `ceres/src/Md.tsx` (`ManagementApp`, shared by both
`NeeApp`/`CeoApp`): a `hidden lg:flex` grouped tab strip added below the existing header row,
copy-adapted from Juno's `juno/src/Juno.tsx` tabGroups pattern (small muted group captions,
thin vertical dividers, active-tab underline, red pill badges, horizontal-scroll overflow with
hidden scrollbar). The mobile bottom nav + "back to more" button are now `lg:hidden`; nothing
else about them changed. `ceres/src/AppSwitcher.tsx` is new, copy-adapted from
`juno/src/AppSwitcher.tsx` (CURRENT='ceres', Coins icon) — added to the header's brand slot so
Ceres has the same app-switcher chip as the rest of the suite. `ceres/src/lib/api.ts` gained
`apps: string[]` on `Agent` + a local `hasAppAccess()` mirroring the server
(api/src/auth/jwt.ts) and every other suite app's own copy of this helper (juno/vesta/apollo) —
additive only, the field was already on the wire, just unused by Ceres until now.

## Final grouping

**GM (Nee)** — lands on อนุมัติ (no big-button home on desktop):
`[ขั้น 1 · คำขอ] อนุมัติ(●queue) │ [ขั้น 2 · จ่ายเงิน] รอจ่าย(●fulfillment) · โอน/สลิป(●recon) │ [กล่องเงินสด] บอร์ด · ปิดวัน │ [ค่าใช้จ่ายเดิม] ตรวจค่าใช้จ่าย · เบิก/คืนเงิน · ประวัติค่าใช้จ่าย · คำขอจ่ายเงินเดิม · รายการประจำ │ [สรุป] ส่งออกข้อมูล · ตั้งค่า LINE`

**CEO (supervisor)** — lands on วันนี้ (oversight), leading tab is รอ CEO:
`[รอ CEO] รอ CEO(●escalations) │ [ภาพรวม] วันนี้ · ย้อนหลัง │ [ขั้น 2 · จ่ายเงิน] จ่าย/ซื้อ(●fulfillment) · โอน/สลิป(●recon) │ [กล่องเงินสด] บอร์ด · ปิดวัน │ [ค่าใช้จ่ายเดิม] ตรวจค่าใช้จ่าย · เบิก/คืนเงิน · ประวัติค่าใช้จ่าย · คำขอจ่ายเงินเดิม · รายการประจำ │ [สรุป] ส่งออกข้อมูล · ตั้งค่า LINE`

## Destination map (View key → component → source screen it replaces on desktop)

| Tab label | View key | Component | GM | CEO |
|---|---|---|---|---|
| อนุมัติ | `approvals` | NeeApprovalQueue | ✓ | — |
| รอจ่าย / จ่าย/ซื้อ | `fulfillment` / `legacy-fulfillment` | NeeFulfillmentQueue (same component, two role-gated View keys, pre-existing) | ✓ | ✓ |
| โอน/สลิป | `recon` | MdRecon (incl. TransferReconciliationPanel) | ✓ | ✓ |
| บอร์ด | `board` | MdBoard | ✓ | ✓ |
| ปิดวัน | `close` | MdClose | ✓ | ✓ |
| ตรวจค่าใช้จ่าย | `legacy-approval` | MdApproval | ✓ | ✓ |
| เบิก/คืนเงิน | `money` | MdMoney | ✓ | ✓ |
| ประวัติค่าใช้จ่าย | `expenses` | MdExpenses | ✓ | ✓ |
| คำขอจ่ายเงินเดิม | `requests` | MdRequests | ✓ | ✓ |
| รายการประจำ | `templates` | MdTemplates | ✓ | ✓ |
| ส่งออกข้อมูล | `exports` | WeeklyPackSection | ✓ | ✓ |
| ตั้งค่า LINE | `settings` | Settings | ✓ | ✓ |
| รอ CEO **(new view)** | `ceo-queue` | `EscalationsSection` (exported from CeoOverview.tsx, reused as-is) fed by `getCeoOverview(today).escalations` | — | ✓ |
| วันนี้ | `home` | CeoHome | — | ✓ |
| ย้อนหลัง | `ceo-history` | CeoOverview.tsx (date-picker + AI reviews + missed bills + request counts + weekly pack) | — | ✓ |

Every GM/CEO mobile destination (moreGroups + NeeHome/CeoHome shortcuts) has a 1:1 desktop tab.
The only NEW screen is `ceo-queue` — not a new endpoint, just `EscalationsSection` (already
exported by CeoOverview.tsx) given its own tab so the CEO desktop strip has a dedicated
"leading" queue tab per the design brief, separate from the "วันนี้" oversight dashboard
(which also shows escalations inline, same as it does today on mobile — intentionally kept,
matches how GM's mobile NeeHome card and the desktop อนุมัติ tab both already coexist).

## Badge sourcing (all reused, no new endpoints)
- อนุมัติ: `listStaffRequests('queue', 200).requests.length` — same call NeeHome already makes.
- รอจ่าย / จ่าย/ซื้อ: `listStaffRequests('all', 300)` filtered `approvalStatus==='approved' && fulfillmentStatus==='unfulfilled'` — same filter NeeHome/NeeFulfillmentQueue already use.
- โอน/สลิป (GM): `getTransferReconciliation()` unmatched count — same call NeeHome already makes.
- โอน/สลิป (CEO): `getCeoOverview(today).transferReconciliation.unmatched` — already part of the CeoHome fetch, no extra call.
- รอ CEO: `getCeoOverview(today).escalations.length` — same call CeoHome already makes.

Badges are gated on `isDesktop` (a `window.matchMedia('(min-width: 1024px)')` hook local to
Md.tsx) so mobile never pays for the extra requests, and re-fetch on every tab switch for a
"live" count without adding a push channel.

## Judgment calls worth a second look
1. **Active-tab color is amber, not Juno's green.** The brief's reference screenshot is Juno
   (emerald brand); Ceres is amber everywhere else in this same header (logo, buttons, mobile
   bottom-nav active state). Recoloring only the new desktop strip to green would clash with
   the rest of the app, so the strip uses Ceres's own `amber-600/700` — grammar copied
   (captions, dividers, underline, bold, red badges), color kept app-consistent. Easy to flip
   to emerald if the owner actually wants literal color parity with Juno.
2. **GM's mobile home (NeeHome, 4 cards) is not reachable from the desktop strip at all** —
   its content (approval/fulfillment/recon counts + cash balance) is now covered by tab badges
   + the บอร์ด tab, so a `#home` hash or default landing on desktop silently redirects gm to
   อนุมัติ. CEO's `home` (CeoHome) stays mapped as the "วันนี้" tab since it's a dashboard, not a
   big-button screen, and the brief says CEO should land there.
3. **Header subtitle left as `· CEO`/`· GM`** (role indicator) rather than swapped for a
   Juno-style system description string (`· ระบบการเงิน`) — arguably more useful, and the
   portal link / user name / ออก were already present and already matched Juno's chrome.
4. **AppSwitcher + `apps`/`hasAppAccess` addition to `lib/api.ts`** is new surface not
   explicitly requested by the acceptance criteria, but the design brief specifically named the
   "▾ app-switcher chip" as part of the header to align — flagging in case the owner would
   rather keep Ceres's `Agent` type untouched and skip the switcher for now.

## Verification
- `npm ci` at worktree root (workspaces; no lockfile touched).
- `cd ceres && npm run typecheck` → clean (`tsc -b`, no errors).
- `cd ceres && npm run build` → clean (`tsc -b && vite build`, dist emitted, only the
  pre-existing >500kB chunk-size warning, unrelated to this change).
- No ceres/juno frontend test framework exists (confirmed via search) — nothing to run there.
- No new backend endpoint was added, so no new API tests were needed; the API/backend was not
  touched at all (0-line diff), and this fresh worktree has no `.env`/DB configured to run the
  existing Postgres-backed `api` vitest suite, which is unrelated to this change regardless.
- `git diff` against every mobile-only component (StaffHome, NeeHome, CeoHome, CeoOverview,
  MoreMenu, all Nee*/Md* screens, Settings, Ceres.tsx, App.tsx) returns 0 lines — mobile markup
  is byte-for-byte unchanged.
