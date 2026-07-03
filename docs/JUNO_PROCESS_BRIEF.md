# Juno v2 — the real finance process (RE check + cover letter + reconciliation)

> Self-contained build brief. Juno v1 is LIVE (see docs/JUNO_BRIEF.md + JUNO_DEPLOY.md):
> a finance app over the shared Minerva Postgres `Payment` table (LINE-slip income only),
> tabs รายการรับเงิน / ตรวจสอบยอด / รายงาน, supervisor-gated, deployed on Railway from `main`.
> This brief upgrades Juno to model the ACTUAL finance process below. Phase A is fully
> specified here; Phase B is outlined and gets its own detailed spec once sample bank files
> arrive.

## The company's real process (owner-confirmed, 2026-07-03)

1. Sales forward slips from the Minerva console → `Payment` rows appear in Juno. (LIVE)
2. **FIN issues an RE (receipt) in Express for every case**, then marks the payment
   checked in Juno. RE number format: `RE` + 7 digits, in practice `69xxxxx` (พ.ศ. year
   prefix + running number); written bare (no "RE") in working docs.
3. FIN prints a ¼-A4 **cover letter** and staples it to the printed RE for the physical
   file. Today they HANDWRITE it — Juno must print it instead.
4. The owner downloads bank files **every Wednesday and Saturday** — two sources ONLY:
   **KBIZ** (Kasikorn business banking statement CSV) and **K SHOP** (merchant app
   report). SCB existed in the past; NOT in scope.
5. **Juno reconciles** bank credit lines against checked (RE-carrying) payments.
6. Weekends the owner reviews reconciled receipts and **confirms them in Express**
   (marks the RE as paid). In Juno that's the final status.

Owner decisions locked:
- **FIN types the RE number into Juno at check time** (not imported from Express — an
  Express RE-report import is a possible future upgrade, do not build now).
- Reconciliation = **auto-match** checked payments ↔ imported bank transactions.
- Cover letter shows **two names** (LINE/customer name AND the official receipt name)
  plus **ประเภทลูกค้า** ∈ {โอนก่อนส่ง, เครดิต, เก็บปลายทาง} — both entered/confirmed by
  FIN in the check dialog. (Future CRM will feed these; design them as plain columns.)

Real-data facts that constrain the design (from the owner's reconciliation sheet):
- One bank credit can pay MANY REs (observed: 11 REs on one ฿27,803 transfer); one RE can
  be paid by TWO transfers ("มี 2 ยอดโอน"). Matching is many-to-many.
- The KBIZ statement contains a nightly lump `EDC/K SHOP/MYQR From KB000001748389 ...`
  = the day's K SHOP settlement. It MUST be auto-excluded (detail comes from the K SHOP
  file) or K SHOP income double-counts.
- Plenty of income has no LINE slip (K SHOP counter sales, cheque batch deposits,
  Shopee/Lazada settlements, บิล cash-book refs) → reconciliation must let the owner
  type RE/ref text onto a bank line that has no matching Payment.
- Negative statement amounts = outgoing; ignore for reconciliation.

---

# PHASE A — RE check dialog + cover-letter printing (build now)

## A1. Schema (ADD-only; one new migration; Minerva api stays the sole migrator)

In `api/prisma/schema.prisma`, add to `model Payment`:
```prisma
  // FIN check data (entered in Juno's check dialog when the RE is issued in Express)
  reNumber     String @default("") // receipt no., stored as BARE 7 digits (e.g. "6900123")
  receiptName  String @default("") // official name on the RE (may differ from customerName)
  customerType String @default("") // โอนก่อนส่ง | เครดิต | เก็บปลายทาง | "" (unset)
```
plus `@@index([reNumber])`.

New migration folder `api/prisma/migrations/20260703000000_juno_re_check/migration.sql`:
```sql
-- Juno phase A: FIN check data on Payment. ADDITIVE ONLY — safe on the shared live DB.
ALTER TABLE "Payment" ADD COLUMN "reNumber" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "receiptName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "customerType" TEXT NOT NULL DEFAULT '';
CREATE INDEX "Payment_reNumber_idx" ON "Payment"("reNumber");
```
(Timestamp must sort after every existing migration — check `ls api/prisma/migrations`.)

## A2. API (`api/src/routes/juno.ts`)

1. New route `POST /api/juno/payments/:id/verify` — the ONLY way to reach status
   `verified`:
   - body: `{ reNumber: string, receiptName?: string, customerType?: string }` (zod,
     safeParse+400).
   - Normalize reNumber: trim, strip a leading `RE`/`re`, then require `/^\d{7}$/` →
     else 400 `{ error: 'invalid_re' }`. Store bare digits.
   - customerType: zod enum of `['โอนก่อนส่ง', 'เครดิต', 'เก็บปลายทาง', '']`, default ''.
   - Reject if current status is `void` (409 `void_locked`, same rule as /status).
   - Update: `status: 'verified'`, `reNumber`, `receiptName` (default ''),
     `customerType`, `verifiedById: req.agent.id`, `verifiedAt: now`.
   - **Duplicate-RE guard (warn, not block):** after saving, count other non-void
     payments with the same reNumber; return `{ ok: true, payment, reDuplicates: n }`.
2. `POST /payments/:id/status`: reject a `verified` target with 409
   `{ error: 'use_verify' }` (the modal is mandatory); everything else unchanged.
   Moving verified→received keeps reNumber/receiptName/customerType (data is not lost;
   only the stamps clear, as today).
3. `toRow(...)`: include `reNumber`, `receiptName`, `customerType`.
4. `buildListWhere`: add `{ reNumber: { contains: term } }` to the search OR-list (and
   strip a leading "RE" from the term when it matches `/^re\d+/i` so typing "RE6900123"
   finds "6900123").
5. CSV export: add columns `reNumber`, `receiptName`, `customerType` (after `status`).

## A3. Juno UI (`juno/src/`)

1. `lib/api.ts`: extend `Payment` with the 3 fields; add
   `verifyPayment(id, { reNumber, receiptName, customerType })` calling the new route;
   type `CustomerType = 'โอนก่อนส่ง' | 'เครดิต' | 'เก็บปลายทาง' | ''`.
2. **Check dialog** (`Juno.tsx`): clicking ตรวจแล้ว in the drawer opens a small modal
   (not a browser prompt):
   - เลขที่ใบเสร็จ (RE): text input, autofocus, placeholder `เช่น 6900123`, live-strips a
     typed `RE` prefix, validates 7 digits, required.
   - ชื่อบนใบเสร็จ: text input, prefilled with the first line of `taxInvoice` if present
     else `customerName`.
   - ประเภทลูกค้า: three-choice segmented select (โอนก่อนส่ง / เครดิต / เก็บปลายทาง),
     no default — FIN picks each time (may leave unset).
   - Save → `verifyPayment` → applyUpdate. If the response has `reDuplicates > 0`, show
     an amber inline warning in the drawer: `เลข RE นี้ซ้ำกับรายการอื่น (n)` — informational.
   - Error surface follows the drawer's existing error pattern.
3. Drawer: show `RE {reNumber}` prominently next to the status badge once set (and
   receiptName/customerType in the field grid). Allow re-opening the dialog via a small
   แก้ไข button when already verified (calls the same route; server allows re-verify —
   status already `verified` is fine, it just updates fields and re-stamps).
4. Inbox table: new **RE** column (before สถานะ; hidden on <md like ธนาคาร is). Shown as
   bare digits.
5. Status label: rename บันทึกแล้ว → **ยืนยันใน Express** in STATUS_META (and the status
   filter dropdown). Everything else keeps its wording.

## A4. Cover letter printing (¼ A4, 4-up)

Goal: FIN never handwrites a cover again. Print styling lives in the Juno SPA.

1. New component `juno/src/PrintCovers.tsx` rendered as an overlay route/state from the
   main app (keep it simple: a `printQueue: Payment[]` state in `Juno.tsx`; when
   non-null, render `<PrintCovers payments={...} onDone={...}/>`).
2. Entry points:
   - Drawer: **พิมพ์ใบปะหน้า** button (single payment) — enabled when `reNumber` is set.
   - Inbox toolbar: **พิมพ์ใบปะหน้า** button — prints every row in the CURRENT filtered
     list with status `verified` (the daily flow: filter today + ตรวจแล้ว → one click →
     the whole stack prints). Confirm count in the button label: `พิมพ์ใบปะหน้า (n)`.
3. Layout: A4 portrait pages, each divided into a 2×2 grid of ¼-A4 (A6 105×148.5mm)
   covers, with light dashed cut guides between quadrants. CSS:
   `@page { size: A4 portrait; margin: 0 }`, quadrant = `w-[105mm] h-[148.5mm]` with
   ~8mm inner padding, `page-break-after` per 4. Trigger `window.print()` on mount, call
   `onDone` after `afterprint`. Screen view shows the same pages scrolled (so FIN can
   eyeball before printing).
4. Cover content (one payment per quadrant, Thai labels, clean sans, no logo asset —
   text header only):
   ```
   Prominent — ใบปะหน้าใบเสร็จ            (header, small, bold)
   เลขที่ใบเสร็จ:  RE 6900123              (LARGE — the filing key)
   วันที่:         03 ก.ค. 69 (Thai date of createdAt)
   ลูกค้า:         {customerName}   รหัส {customerCode}
   ชื่อบนใบเสร็จ:  {receiptName}
   ประเภทลูกค้า:   {customerType or "—"}
   จำนวนเงิน:      ฿12,345.00              (bold)
   ช่องทาง:        {bank}
   พนักงานขาย:     {salesName}
   ผู้จัดทำ: ______________                (blank line for signature)
   ```
   Keep the company header string in ONE constant (`COMPANY_HEADER`) — the owner may
   adjust the legal name later.
5. Font sizes chosen so the quadrant never overflows with long Thai names (truncate
   receiptName/customerName with ellipsis past 2 lines).

## A5. Verification gauntlet (all must pass before committing)

```
cd <worktree>/api  && npx prisma validate && npx prisma generate && npx tsc --noEmit
cd <worktree>/juno && npm install && npm run build
```
Grep checks: `reNumber` present in schema.prisma + migration + juno.ts toRow + api.ts
Payment type; `use_verify` in juno.ts; `ยืนยันใน Express` in Juno.tsx; no remaining path
sets status 'verified' outside the verify route.

---

# PHASE B — bank import + reconciliation (spec to follow; do NOT build yet)

Outline agreed with the owner (for context only):
- New tables `BankTxn` + `BankImport` (ADD-only). Import UI: upload the twice-weekly
  KBIZ CSV and K SHOP report; preview → apply (Vulcan's import pattern); dedupe
  re-uploaded overlapping ranges by content hash; auto-exclude negative amounts,
  balance/header rows, and the nightly `EDC/K SHOP/MYQR` settlement lump.
- KBIZ CSV format confirmed from a real sample ("K-DEPOSIT STATEMENT" header block; rows
  Date DD-MM-YY, Time, Descriptions, Withdrawal, Deposit, Balance, Channel, Details;
  quoted comma amounts). K SHOP raw export format PENDING a sample file from the owner.
- Matcher: auto-match checked payments (reNumber set) to credit lines by exact amount +
  same/adjacent Thai day, with sender-name similarity as a tiebreaker; many-to-many UI
  (select several payments for one line, several lines for one RE) for the rest; manual
  ref text (cheque no. / บิล / Shopee) on lines with no Payment.
- กระทบยอด tab: unmatched bank credits · checked-but-unmatched payments · matched
  pending Express-confirm, with weekend bulk-confirm (sets Payment → ยืนยันใน Express
  and stamps the line).
