# Ceres — Staff Home redesign + 3-tab nav + GM queue rename (2026-07-19)

Owner-approved (discussed first). Staff mobile app only + one GM label; desktop GM/CEO nav
untouched. All frontend except one verification. Fix the dangling "·" everywhere.

## 1. หน้าแรก (StaffHome) — stop mirroring คำขอของฉัน

Keep: top orange [ส่งคำขอเงิน] button, LINE-bind banner.

Replace the คำขอล่าสุด list with:

A. **"เงินเบิกที่กำลังปิดยอด"** — one card per MY v2 advance holding un-settled money
   (จ่ายแล้ว / กำลังปิดยอด states). Card contents:
   - amount + status pill (existing pill styles), subtitle WITHOUT dangling separator;
   - the 4 liquidation stats เบิกไป / ใช้ไป / คืนแล้ว / ค้าง (reuse RequestDetail's stat
     tile styling verbatim; ค้าง = the amber-highlight tile);
   - a **[+ เพิ่มค่าใช้จ่ายเบิก]** button on the card opening the SAME liquidation
     ExpenseSheet wiring RequestDetail uses (same props: advanceRequestId,
     defaultEntity=request.entity, defaultCategory only for old single-category advances
     — copy the exact invocation from RequestDetail.tsx; refresh the card's numbers after
     save);
   - tapping the card body → the existing RequestDetail view.
   - Data: per-advance GET /requests/:id/liquidation (same call RequestDetail makes) —
     staff hold at most a few open advances, parallel fetches are fine; no backend change.
   - Empty state: hide the section entirely when no open advances.

B. **"รอดำเนินการ"** — compact rows (no stat tiles) for MY requests in รอตรวจ/รอ GM/
   รอ CEO plus ไม่อนุมัติ from the last 7 days; tap → detail. Hide when empty.

C. **[ดูคำขอทั้งหมด]** button → คำขอของฉัน tab. Home shows NO general history list.

## 2. Dangling "·" bug (today's optional-reason change)

Wherever a request row renders `เบิกล่วงหน้า · {reason}` (StaffHome rows, MyRequests.tsx,
any shared row component): omit the separator + reason segment when reason is empty.

## 3. Tab bar 4 → 3

Remove the เพิ่มเติม tab from the STAFF bottom nav → หน้าแรก · คำขอของฉัน · ตั้งค่า.
First INVENTORY what the staff-role เพิ่มเติม/MoreMenu contains (check MoreMenu/StaffHome
code per role): the known item is "ค่าใช้จ่ายเงินเบิกเดิม" (v1 self-entry) — relocate it as
a LOW-KEY card at the BOTTOM of the คำขอของฉัน screen, styled muted/secondary, title
"ค่าใช้จ่ายเงินเบิกเดิม", hint "สำหรับเงินที่รับไว้แบบเดิม (ระบบเก่า)". If the staff MoreMenu
holds ANY other items, relocate them sensibly (settings-like → ตั้งค่า; money-like →
bottom of คำขอของฉัน) and LIST every relocation in your report. GM/CEO navigation
(mobile + desktop strip) stays byte-identical.

## 4. GM queue label — conditional rename

VERIFY in code first: Nee's "ตรวจค่าใช้จ่ายเดิม (ระบบเดิม)" section (the expense รอตรวจ
queue; endpoint /api/ceres/expenses?scope=all&status=pending) — do advance-linked
liquidation expenses (CeresExpense.advanceRequestId set) appear in it? Check the queue's
backend query filters and the frontend section.
- If YES (expected): rename the visible label(s) "ตรวจค่าใช้จ่ายเดิม (ระบบเดิม)" →
  "ตรวจใบเสร็จค่าใช้จ่าย" (drop every "(ระบบเดิม)" suffix on this queue, mobile + desktop).
  Do NOT change queue behavior.
- If NO: do NOT rename; flag it in your report and leave the label as-is.

## 5. Docs

docs/CERES_USER_GUIDE_TH.md: update the staff sections that mention the 4 tabs /
เพิ่มเติม (now 3 tabs; legacy entry at bottom of คำขอของฉัน), describe the new Home
(open-advance cards + เพิ่มค่าใช้จ่ายเบิก from Home), and the GM queue label if renamed.

## Acceptance

- `cd ceres && npm run build` green; `cd api && npx vitest run ceres` green (no api
  source changes expected; if §4 requires none, api/ is untouched).
- Styling copied verbatim from existing components (stat tiles, pills, cards, buttons) —
  no new style directions. Chips/rows wrap; no hidden horizontal scroll.
- GM/CEO surfaces pixel-identical except the §4 label.
- No new deps, no package-lock changes.
