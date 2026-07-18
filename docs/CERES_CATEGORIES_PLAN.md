# Ceres — General Expense Categories + No Lazy Defaults (2026-07-18)

Owner-approved plan (Fable-authored). Two phases, ONE worktree, sequential executors:
Phase A (backend) = Sol; Phase B (frontend) = sonnet. Executors: do ONLY your phase.

## Problem

Ceres's category list is the old GAS messenger set (11 rows in `CeresCategory`, seeded in
`api/src/db/ensureCeres.ts`). All staff roles see it on every form, and the v2 request sheet
(`ceres/src/RequestSheet.tsx`) PRE-SELECTS the first category ("ค่าขนส่ง SD") plus the first
entity. Owner wants: (1) general grouped categories for all staff, messenger's kept;
(2) NO pre-selected defaults anywhere a lazy wrong answer could be recorded;
(3) a GM/CEO admin screen so future category changes need no dev session.

## Target category catalog (owner-approved — use VERBATIM)

`group` = new String column on `CeresCategory`. Existing rows KEEP their exact `name`
(free-text history references them). sortOrder renumbered as below (10s spacing).

| sortOrder | name | group | kind | notes |
|---|---|---|---|---|
| 10 | ค่าขนส่ง SD | งานขนส่ง (เมสเซนเจอร์) | shipping | existing |
| 20 | ค่าขนส่ง J&T | งานขนส่ง (เมสเซนเจอร์) | shipping | existing |
| 30 | ค่าขนส่ง LALAMOVE Prom | งานขนส่ง (เมสเซนเจอร์) | shipping | existing |
| 40 | ค่าขนส่ง LALAMOVE Dentalport | งานขนส่ง (เมสเซนเจอร์) | shipping | existing |
| 50 | ค่าขนส่งทั่วไป | งานขนส่ง (เมสเซนเจอร์) | shipping | existing |
| 60 | ค่าไปรษณีย์ | งานขนส่ง (เมสเซนเจอร์) | general | existing |
| 110 | ค่าน้ำมัน | ยานพาหนะ/เดินทาง | fuel | existing |
| 120 | ค่าทางด่วน | ยานพาหนะ/เดินทาง | toll | existing |
| 130 | ค่าซ่อมบำรุงรถ | ยานพาหนะ/เดินทาง | general | existing |
| 140 | ค่าเดินทาง (แท็กซี่/วิน/รถสาธารณะ) | ยานพาหนะ/เดินทาง | general | NEW |
| 150 | ค่าที่จอดรถ | ยานพาหนะ/เดินทาง | general | NEW |
| 210 | ค่าเอกสาร/ธุรการ | สำนักงาน/ธุรการ | general | existing |
| 220 | อุปกรณ์/เครื่องเขียนสำนักงาน | สำนักงาน/ธุรการ | general | NEW |
| 230 | ค่าถ่ายเอกสาร/พิมพ์งาน | สำนักงาน/ธุรการ | general | NEW |
| 310 | ของใช้สิ้นเปลือง | ของใช้/วัสดุ | general | NEW |
| 320 | อุปกรณ์/เครื่องมือ | ของใช้/วัสดุ | general | NEW |
| 410 | ค่าอาหารและเครื่องดื่ม | อาหาร/รับรอง | general | NEW |
| 420 | ค่ารับรองลูกค้า | อาหาร/รับรอง | general | NEW |
| 510 | ค่าซ่อมแซม/บำรุงสถานที่ | สถานที่/ซ่อมแซม | general | NEW |
| 910 | อื่นๆ | อื่นๆ | general | existing |

All NEW rows: `ceiling ''`, `needsCustomerNote false`, `active true`. Existing rows keep
their current `ceiling`/`needsCustomerNote` values untouched (only `group` + `sortOrder` change).

Group display order = ascending sortOrder of first member (i.e. table order above).

---

## Phase A — backend (Sol, high)

1. **Schema** (`api/prisma/schema.prisma`, model `CeresCategory` ~line 1123): add
   `group String @default("")`. NOTE: `group` is a reserved SQL word — Prisma quotes its
   identifiers, but any RAW SQL in the migration must write `"group"`.

2. **Migration** (new `api/prisma/migrations/<ts>_ceres_category_groups/migration.sql`):
   - `ALTER TABLE ... ADD COLUMN "group" TEXT NOT NULL DEFAULT '';`
   - `UPDATE` each of the 11 existing rows BY NAME → set `"group"` + `"sortOrder"` per table.
   - `INSERT` the 9 NEW rows with explicit readable ids (e.g. `cerescat_travel_public`),
     `ON CONFLICT ("name") DO NOTHING` (idempotent vs dev DBs where seed may differ).
   - ⚠️ NEVER `CREATE INDEX CONCURRENTLY` (Prisma wraps migrations in one tx — known
     deploy-killer in this repo). No index changes are needed at all.

3. **Seed** (`api/src/db/ensureCeres.ts:13-27`): replace the starter list with the FULL
   20-row catalog above (fresh DBs match prod). Keep the count===0 guard as is.

4. **Bootstrap** (`api/src/routes/ceres/p1.ts:54`): ensure the categories payload includes
   `group` (if the query returns full rows it already does — verify the serialized response).

5. **Admin CRUD** (new `api/src/routes/ceres/categories.ts`, mounted like siblings; role
   gate gm + ceo ONLY — messenger gets 403; follow the existing ceres auth middleware
   pattern in `api/src/ceres/auth.ts`):
   - `GET /api/ceres/admin/categories` — ALL rows incl. inactive, sortOrder asc.
   - `POST /api/ceres/admin/categories` — `{name, group, ceiling?, needsCustomerNote?}`;
     zod: name 1–100 trimmed, group 1–100 trimmed, ceiling = '' or numeric string ≥ 0;
     duplicate name → 409 `{error:'duplicate_name'}`; sortOrder = (max within that group,
     else global max) + 10.
   - `PATCH /api/ceres/admin/categories/:id` — any of `{name, group, ceiling,
     needsCustomerNote, active}`. Rename allowed (history keeps old free-text string —
     that is accepted behavior). Duplicate name → 409. Deactivating is the ONLY removal
     (no DELETE route). Refuse deactivating the last active category (400).
   - `POST /api/ceres/admin/categories/:id/move` — `{direction:'up'|'down'}` swaps
     sortOrder with the adjacent row IN THE SAME GROUP (no-op at the edge).
6. **AI policy text** (`api/src/ceres/aiReview.ts:38-39`, `EXPENSE_POLICY_TEXT`): replace
   ONLY the messenger-framing sentence ("รายการเหล่านี้เป็นค่าใช้จ่ายรายวันของพนักงานส่งของ …")
   with general framing: expenses come from staff of ALL roles across the company group
   (office/sales/clinic/messenger) — travel, fuel/tolls, office supplies, consumables,
   meals/client entertaining, small repairs, and messenger shipping; plausibility must be
   judged against the requester's memo/role, not assume delivery work; personal, luxury, or
   unusual items escalate. Keep EVERYTHING else (fail-closed rules, >5k escalation,
   per-category ceilings via `categoryCeilingReason`) byte-identical.

7. **Tests** (vitest, follow existing ceres test patterns): admin route auth (messenger
   403, gm ok), create/rename/duplicate-409/deactivate/move, bootstrap carries `group`,
   v2 `createStaffRequest` accepts a NEW category name and still rejects inactive/unknown
   (`invalid_category`). Run the targeted ceres suites + `tsc`/build. If the full suite
   needs Docker and Docker is unavailable, targeted suites are acceptable — SAY SO.

Phase A does NOT touch `ceres/` frontend.

## Phase B — frontend (sonnet)

API client (`ceres/src/lib/api.ts`): add `group: string` to `Category`; add admin fns
(`adminListCategories`, `adminCreateCategory`, `adminUpdateCategory`, `adminMoveCategory`).

1. **Grouped picker, no default** — new shared `ceres/src/components/CategoryPicker.tsx`:
   renders `bootstrap.categories` grouped by `group` (order = sortOrder), a small header
   label per group, chips styled EXACTLY like the existing category chips in
   `RequestSheet.tsx:345-361` (copy classes verbatim — do not invent styling). Empty
   `value` = nothing selected. Use it in: `RequestSheet.tsx`, `ExpenseSheet.tsx`,
   `MdRequests.tsx` (RequestForm), `MdTemplates.tsx` (TemplateDialog).

2. **Remove lazy defaults** (keep contextual ones — editing an item, liquidation
   `defaultCategory`/`defaultEntity` from `RequestDetail.tsx:353-362`, refund's inherited
   `fundingLane` at `NeeFulfillmentQueue.tsx:526` all STAY):
   - `RequestSheet.tsx:56` entity → `''` for new; `:57-63` category → `''` for new
     (delete the `categories[0]?.id` fallback + the "secondary, defaulted" comment).
   - `ExpenseSheet.tsx:35` entity → `''` unless `editing`/`defaultEntity`.
   - `MdRequests.tsx:348` entity → `''`. `MdTemplates.tsx:160` entity → `''`.
   - `NeeFulfillmentQueue.tsx:276` FulfillForm lane → no preselection (`null`), explicit
     tap required.
   - Validation: submit blocked until entity/category/lane chosen — follow each form's
     EXISTING inline-error pattern; Thai hints: เลือกบริษัท / เลือกหมวดหมู่ / เลือกช่องทางจ่าย.
     Ensure zod payloads never send `''` silently.

3. **Admin screen "จัดการหมวดหมู่"** — inside the existing ตั้งค่า (Settings) surface,
   visible to gm + ceo only (hide for messenger; locate the existing settings screen and
   role plumbing — do not build a new route unless settings genuinely has none). Features:
   grouped list (inactive rows dimmed in a collapsed "ปิดใช้งาน" section), add dialog
   (name, group free-text + datalist of existing groups, ceiling, needsCustomerNote),
   edit dialog (same + active toggle; hint that renaming does not rewrite old records),
   ↑/↓ reorder within group. Styling: reuse Ceres's existing light/amber dialog + button
   classes from neighboring Md* files VERBATIM (owner rule: match siblings, never invent
   a new style direction).

4. **Docs** — `docs/CERES_USER_GUIDE_TH.md`: update the category mentions (grouped picker,
   nothing pre-selected — ผู้ขอต้องเลือกเอง), add a short GM subsection for จัดการหมวดหมู่.

Phase B does NOT touch `api/` except reading route shapes.

## Shared acceptance

- `npm run build` green in `api/` and `ceres/`; targeted vitest green.
- Mobile forms keep working (pickers are shared; that is intended) — no nav changes.
- No new deps. No package-lock regeneration (Windows lockfile hazard).
- History untouched: existing expense/request rows keep their old category strings.
