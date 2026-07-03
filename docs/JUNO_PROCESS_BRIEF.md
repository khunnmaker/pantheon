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

# PHASE B — bank import + reconciliation (FULL SPEC; build on top of Phase A)

Real sample files (owner's actual exports, on the build machine — use for testing, do
NOT commit them): `C:\Users\khunn\Downloads\Bank\KBiz.csv` and
`C:\Users\khunn\Downloads\Bank\KShop.csv`.

## B0. File formats (confirmed from the real samples)

**K SHOP** (`KShop.csv`, UTF-8 with BOM, LF):
```
TRANSACTION REPORT - payment,
Request Date :,03-07-2026,
Merchant ID :,KB000001748389,
Shop Name :,พรอมมิเน้นท์,No. of Payment transaction :,23,
Shop Owner :,<name>,No. of Void transaction :,0,
No.,Date Time,Transaction ID,Transaction Type,Amount,From Account,To Account,Source of Fund,Customer,Item,Original Transaction ID,
1,01-07-2026 09:21:29,EMPKB000001748389004,Payment,8820.00,บจก. เพชรสมุทร,KB000001748389,"TMBThanachart Bank","-",-,EMPKB000001748389004,
...
,,,Total (THB),88787.60,
,,,*ยอดเงินที่แสดง...,
```
- Data rows = rows whose first cell is numeric. Footer (Total/note) rows skipped.
- Date Time `DD-MM-YYYY HH:MM:SS` (Gregorian), Thai local time (+07:00).
- `From Account` = PAYER NAME (Thai or EN — a strong match signal vs
  `Payment.senderName`). `Source of Fund` = payer's bank (quoted). K PLUS rows have a
  numeric Transaction ID with the terminal id in the LAST column; card/QR rows repeat
  the terminal (EMPKB...003/004/005) in both.
- `Transaction Type`: `Payment` → income row. `Void` → do NOT store; count as excluded
  and surface the count in the preview note.
- Amounts are GROSS (pre-fee/VAT — footer note) → they equal what the customer paid,
  i.e. they match Payment.amount; the KBIZ settlement lump is net and is excluded anyway.

**KBIZ statement** (`KBiz.csv`; UTF-8; may or may not carry a BOM — handle both; if
decoding yields U+FFFD, retry as windows-874):
- Title lines: `รายการเดินบัญชี...` + `K-DEPOSIT STATEMENT OF <SAVING|CURRENT> ACCOUNT
  (WITH DETAIL)` — accept both account kinds.
- Header block (Ref/Account incl. a MULTI-LINE quoted address cell/Account Number/
  Period/Branch/totals) — must be parsed with a real CSV reader that handles quoted
  newlines; do not split on raw \n.
- Column header row contains `Date` and `Descriptions` (Time header is `Time/Ent.Date`
  or `Time/Eff.Date` — don't depend on it). Every data row starts with an EMPTY first
  cell; fields at indexes: 1=Date `DD-MM-YY` (Gregorian 26→2026), 2=Time `HH:MM` (empty
  on balance rows), 3=Descriptions, 4=Withdrawal, 6=Deposit, 8=Balance, 10=Channel,
  12=Details. Amounts quoted with thousands commas.
- Row handling: skip `Beginning Balance`; **skip rows whose Channel is
  `EDC/K SHOP/MYQR`** (the nightly K SHOP settlement lump — its detail arrives in the
  K SHOP file; count as excluded); Deposit-nonempty → direction `in`, else `out`
  (Withdrawal/Fee/Payment rows). Store `out` rows too (future expenses project) but the
  recon UI only surfaces `in`.
- Deposit varieties seen (all direction `in`): Transfer Deposit (`From X####/NAME++` in
  Details), Cash Deposit (branch channel, `Ref Code ...`), Automatic Deposit
  (`From SMART <BANK> X#### <INSTITUTION>++` — hospitals etc., no LINE slip),
  Cheque Deposit (`<BANK> #### Cheque No. ########`).
- Best-effort extraction from Details for matching: `payerName` = text after the last
  `X####␣` up to `++`; `payerBank` = token after `From` when it is a known bank code
  (SCB/KTB/BBL/TTB/BAY/GSB/LHBANK/KK/KBANK...); cheque rows: `refHint` = the cheque no.

## B1. Schema (ADD-only migration `..._juno_bank_recon`, timestamp after Phase A's)

```prisma
model BankImport {
  id         String   @id @default(cuid())
  source     String   // kbiz | kshop
  fileName   String   @default("")
  importedAt DateTime @default(now())
  importedBy String?
  rowsParsed Int @default(0)
  txnsNew    Int @default(0)
  txnsDup    Int @default(0)   // already in DB (overlapping export ranges are NORMAL)
  txnsExcluded Int @default(0) // K SHOP lump, voids, balance rows
  note       String @default("")
}
model BankTxn {
  id          String  @id @default(cuid())
  source      String  // kbiz | kshop
  txnAt       DateTime
  amount      String  @default("") // baht "1234.56" (house String style)
  direction   String  @default("in") // in | out
  channel     String  @default("")
  description String  @default("") // KBIZ Descriptions / kshop "Payment"
  details     String  @default("") // KBIZ Details / kshop payer·bank·terminal
  payerName   String  @default("")
  payerBank   String  @default("")
  dedupeKey   String  @unique // sha256("source|txnAt ISO|amount|details") + "|n" suffix on within-file collisions
  importId    String
  matchStatus String  @default("unmatched") // unmatched | matched
  refText     String  @default("") // manual refs (cheque no. / บิล 38/13 / Shopee / RE list) — setting it marks matched
  expressConfirmedAt   DateTime?
  expressConfirmedById String?
  @@index([txnAt]) @@index([matchStatus]) @@index([direction])
}
model PaymentBankMatch {
  id          String   @id @default(cuid())
  paymentId   String
  bankTxnId   String
  createdAt   DateTime @default(now())
  createdById String?
  @@unique([paymentId, bankTxnId])
  @@index([paymentId]) @@index([bankTxnId])
}
```
Plus on `Payment`: `reconciled Boolean @default(false)` (denormalized: true while ≥1
match link exists) + `@@index([reconciled])`.

## B2. Parsers — `api/src/bank/parseKbiz.ts`, `api/src/bank/parseKshop.ts`

- Use a small robust CSV tokenizer that handles quoted fields with embedded commas AND
  newlines (write one ~30-line function; no new deps unless `iconv-lite` is needed for
  the 874 fallback — it is already a dependency via Vulcan's Express import; reuse).
- Auto-detect source from content: first line containing `TRANSACTION REPORT` → kshop;
  `K-DEPOSIT STATEMENT` → kbiz. Reject unknown files with a clear error.
- Output per row: `{ txnAt: Date, amount: string, direction, channel, description,
  details, payerName, payerBank }` + per-file counts { parsed, excluded } and the
  detected period. Timestamps built with explicit `+07:00`.
- Commit SANITIZED fixtures (6–10 rows each, fake names, structure identical incl. the
  EDC lump, a Fee, a Cheque Deposit, an Automatic SMART row, a K PLUS kshop row, a Void
  row, an identical-duplicate pair) under `api/src/bank/fixtures/`, and a runnable check
  `api/src/scripts/checkBankParsers.ts` (tsx) asserting expected counts/fields on the
  fixtures, and ALSO parsing the real files from `C:\Users\khunn\Downloads\Bank\` when
  present (never committed). Run it in verification.

## B3. API (extend `api/src/routes/juno.ts`; all supervisor-gated as today)

- `POST /api/juno/bank/import/preview` `{ dataB64, fileName }` (bodyLimit ~15MB):
  parse, auto-detect source, compute dedupeKeys, look up existing → return
  `{ token, source, fileName, periodFrom, periodTo, rows: [{txnAt, amount, direction,
  channel, payerName, details, isNew}], counts {parsed, new, dup, excluded} }`. Stash
  like Vulcan's stock preview (TTL + cap).
- `POST /api/juno/bank/import/apply` `{ token }`: insert new BankTxns + BankImport audit
  row, then RUN THE AUTO-MATCHER over the new lines; return counts + autoMatched.
- Auto-matcher (also `POST /api/juno/bank/automatch` to re-run):
  - candidates: BankTxn `in`+unmatched ↔ Payment `verified`, not void, reconciled=false;
  - amounts equal (2dp normalize) AND |txnAt − transferAt| ≤ 3 days (parse Payment
    .transferAt `DD/MM/YYYY HH:MM`; fallback createdAt);
  - link ONLY when the pairing is unambiguous in BOTH directions (exactly one candidate
    each way); ties are left for the UI's suggestions. Linking creates PaymentBankMatch,
    sets txn matched + payment reconciled.
- `GET /api/juno/bank/txns?status=&dir=in&from=&to=&q=` — list with linked payment
  summaries (join through PaymentBankMatch); q searches details/payerName/refText/amount.
- `GET /api/juno/bank/txns/:id/suggestions` — ranked candidate payments: exact-amount
  first (with day distance), then name-similarity (casefolded substring / token overlap
  between payerName/details and senderName/customerName/receiptName), then same-day ±
  small amount delta. Max ~10.
- `POST /api/juno/bank/txns/:id/match` `{ paymentIds: string[] }` — link several (adds
  to existing links), each link sets payment.reconciled; txn → matched. Sum mismatch is
  allowed (fees) — return `{ sumDelta }` for the UI badge.
- `POST /api/juno/bank/txns/:id/unmatch` `{ paymentId }` — remove link; recompute
  payment.reconciled and txn.matchStatus (unmatched when no links AND refText='').
- `POST /api/juno/bank/txns/:id/ref` `{ refText }` — manual reference for non-Payment
  income (cheque/บิล/Shopee/direct RE numbers); non-empty → matched, empty → recompute.
- `POST /api/juno/bank/txns/:id/confirm` and `POST /api/juno/bank/confirm-matched`
  `{ to?: 'YYYY-MM-DD' }` (bulk, the weekend action): stamp expressConfirmedAt/By on
  matched-unconfirmed `in` lines (≤ to, Thai day) AND advance every linked Payment with
  status `verified` → `recorded` (ยืนยันใน Express), stamping verifiedBy fields per the
  existing status route semantics. Payments already recorded are left alone.
- `GET /api/juno/bank/summary` — cards for the tab: unmatched-in {count,sum},
  matched-unconfirmed {count,sum}, verified-payments-unreconciled {count,sum,oldestDays},
  last imports per source.
- Reports/CSV: unchanged this phase.

## B4. UI — new tab **กระทบยอด** (`juno/src/Recon.tsx`, view 'recon', icon Scale)

- Summary cards (from bank/summary). Badge on the tab = unmatched-in count.
- **Import panel**: file input (multiple; both files at once), per file → preview modal
  (source, period, counts new/dup/excluded, first ~50 rows scrollable) → นำเข้า →
  apply result incl. "จับคู่อัตโนมัติแล้ว n รายการ". Wed/Sat routine = drop 2 files,
  click twice.
- **เงินเข้า list** (direction=in): filters สถานะ (ทั้งหมด/ยังไม่จับคู่/จับคู่แล้ว/ยืนยันแล้ว) + date
  range + search. Row: Thai date-time, amount, channel chip (K BIZ/K PLUS/K SHOP/เช็ค…),
  payer/details, state. Expand a row →
  - linked payments as chips `RE 6900123 · ฿2,120 · ชื่อ` (click = open the payment
    drawer), sum + delta badge when ≠ line amount;
  - **จับคู่**: suggestion list (one-click add) + search (RE/ชื่อ/จำนวน) with
    multi-select; running sum vs line amount;
  - **อ้างอิงอื่น**: free-text refText (เช็คเลขที่… / บิล 38/13 / Shopee) — saves +
    marks matched;
  - **ยืนยัน Express** per line (when matched).
- **ใบเสร็จที่ยังไม่พบเงินเข้า** section (Payments verified + !reconciled, oldest first,
  age badge ≥7 days red) — the fraud/error watchlist.
- **Weekend button**: `ยืนยัน Express ทั้งหมดที่จับคู่แล้ว (n)` with a confirm dialog →
  bulk endpoint → payments flip to ยืนยันใน Express.
- Keep all list styling consistent with the existing tabs (same table/card classes).

## B5. Verification

- `npx prisma validate && npx prisma generate && npx tsc --noEmit` (api),
  `npm run build` (juno).
- `npx tsx api/src/scripts/checkBankParsers.ts` — fixtures pass AND the real
  `C:\Users\khunn\Downloads\Bank\*.csv` parse with: KShop → 23 payment rows, 0 void;
  KBiz → 59 deposits total per its header, of which 2 are EDC/K SHOP/MYQR lumps
  (excluded) — assert the parser's numbers agree with the file's own TOTAL DEPOSIT
  ITEMS count (59, incl. the 2 excluded lumps) and TOTAL WITHDRAWAL (6).
- Grep: no `console.error` in new api code (use req.log), `dedupeKey` unique in schema
  + migration, tab renders behind the existing auth gate.
