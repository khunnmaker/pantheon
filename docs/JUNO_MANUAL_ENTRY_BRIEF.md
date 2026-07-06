# Juno — manual entry (add receipt / cash / cheque) + tab rename (build brief)

> Self-contained spec for a fresh session. Juno is the LIVE finance app in the Minerva
> monorepo (`juno/` frontend + `/api/juno/*` routes in `api/`, supervisor-gated). Today every
> `Payment` row is born ONLY from Minerva's LINE-slip hook (`/to-finance`). This adds the
> "manual / cash / non-LINE entry" expansion the original plan deferred, plus a tab rename.
> Frontend-heavy + one ADD-only migration + new api routes. Owner decisions are locked below —
> do not re-litigate.

## Owner decisions (locked 2026-07-04)

1. **Rename tab** `ตรวจสอบยอด` → **`ปักธง`** (label only; keep the internal `flags` key + Flag icon + rose badge).
2. **Two new ways to create a Payment by hand** (done by FIN + CEO — both use the existing
   supervisor login, so NO auth change):
   - **โอนเงิน (bank transfer)** — behaves EXACTLY like a Minerva receipt: shows in the
     **รายการรับเงิน** inbox and reconciles against the bank statement in **กระทบยอด**.
     Optional slip-photo upload.
   - **เงินสด / เช็คธนาคาร (cash / cheque)** — these don't arrive as a normal bank transfer
     line, so they're verified in a NEW tab **`เงินสด/เช็ค`** with a two-step banking state:
     `รอ` → cash `ฝากธนาคารแล้ว` / cheque `เคลียร์แล้ว`.
3. **All hand-added rows still go through the SAME RE flow** as Minerva receipts: the
   `ตรวจแล้ว` check dialog (RE number + receipt name + ประเภทลูกค้า), the ¼-A4 cover-letter
   print, and `ยืนยันใน Express`. Nothing about that flow changes — it just now applies to
   rows that were typed in rather than forwarded from LINE.
4. **Cheque is verified in the new tab, NOT auto-matched in กระทบยอด** (owner's words: cash
   AND cheque are checked in the other tab). NOTE for a future enhancement (do NOT build now):
   bank cheque deposits do appear in KBiz as `Cheque Deposit … Cheque No. …`, so a later
   version could auto-clear a cheque when that line imports — leave a `// future:` comment
   near the settle logic, nothing more.

## Current code facts (verified — read these before editing)

- **`Payment`** (`api/prisma/schema.prisma`) already has: customerId/Code/Name, senderName,
  amount, ocrAmount, bank, transferAt, ref, slipMessageId(@unique), slipUrl, taxInvoice(+Status),
  salesAgentId/Name, note, status(received|verified|recorded|void), flagged, verifiedBy/At,
  createdAt, reNumber, receiptName, customerType, reconciled, bankMatches[]. NO `source` field yet.
- **`api/src/routes/juno.ts`** (supervisor-gated via the plugin `preHandler` hooks — match the
  existing hook style; auth was refactored recently but Juno stays supervisor-only): has
  `toRow()`, `listFilterSchema` + `buildListWhere()`, `thaiDayRange`, `GET /payments`,
  `GET /payments/:id`, `POST /payments/:id/status`, `.../verify`, `.../flag`, `.../tax-invoice`,
  `GET /summary`, `/reports`, `/export.csv`, and the whole `/bank/*` reconciliation set. There is
  **no create-Payment route** — you are adding it.
- **Upload reuse:** Minerva's `POST /api/uploads` (in `api/src/routes/messages.ts`, `requireAuth`,
  bodyLimit 20MB) takes `{ dataB64, fileName?, contentType? }` and returns `{ uploadId }`; the
  file is then public at `${API_URL}/content/upload/<uploadId>`. Juno's supervisor token is
  accepted. Use this for the optional transfer slip: upload → build that URL → store in
  `Payment.slipUrl`. (The Juno detail drawer already renders `slipUrl` as the slip image.)
- **Frontend** `juno/src/Juno.tsx`: `View = 'inbox'|'flags'|'reports'|'recon'`; `PaymentsView`
  renders the table + `Detail` drawer (with the sticky icon-action rail) and is reused by inbox
  and flags. `Recon.tsx` = the กระทบยอด tab. `lib/api.ts` = typed client. `CheckDialog` (RE) and
  `PrintCovers` already exist and work for any Payment.

## 1. Schema (ADD-only migration `20260704120000_juno_manual_entry`, timestamp AFTER all existing)

Add to `model Payment`:
```prisma
  // how the row entered Juno. 'line' = Minerva LINE slip (default, all existing rows);
  // the rest are hand-added in Juno. transfer types reconcile in กระทบยอด; cash/cheque
  // are verified in the เงินสด/เช็ค tab instead.
  source        String  @default("line") // line | manual_transfer | cash | cheque
  // cash/cheque banking state (blank for transfers). cash: '' -> deposited; cheque: '' -> cleared.
  settleState   String  @default("")     // '' | deposited | cleared
  settledAt     DateTime?
  settledById   String?
  // cheque details (source='cheque' only)
  chequeNo      String  @default("")
  chequeBank    String  @default("")
  chequeDueDate String  @default("")     // as-typed (free text, like transferAt)
```
Plus `@@index([source])` and `@@index([settleState])`. Migration SQL = the 6 `ADD COLUMN`s
(TEXT NOT NULL DEFAULT '' for the strings, TIMESTAMP(3) for settledAt) + the 2 CREATE INDEX.
Verify the hand-written SQL matches `prisma migrate diff` output. `prisma generate` after.

## 2. API (`api/src/routes/juno.ts`)

### 2a. `toRow()` — surface the new fields
Add `source`, `settleState`, `settledAt` (ISO|null), `chequeNo`, `chequeBank`, `chequeDueDate`
to the returned object (and the `toRow` param type).

### 2b. `POST /api/juno/payments` — create a hand-added payment
- zod body (safeParse+400 `invalid_body`):
  - `source`: enum `['manual_transfer','cash','cheque']` (NOT 'line' — that's Minerva-only).
  - `customerCode` str max 40, `customerName` str max 200, `amount` str max 40 (required, must
    parse to a finite number > 0 → else 400 `invalid_amount`; store as the trimmed string),
    `note` str max 600 optional, `senderName` max 200 optional.
  - transfer-only: `bank` max 120, `transferAt` max 60, `ref` max 80, `slipUrl` max 500 (all optional).
  - cheque-only: `chequeNo` max 60, `chequeBank` max 120, `chequeDueDate` max 60 (optional).
- Create Payment: the fields above + `status:'received'`, `salesAgentId: req.agent?.id`,
  `salesName: req.agent?.name ?? ''` (the entering user — so reports attribute it), everything
  else default. `ocrAmount` stays '' (no OCR → the mismatch flag never fires on manual rows).
- Return `{ ok:true, payment: toRow(p) }`.

### 2c. `POST /api/juno/payments/:id/settle` — cash/cheque banking state
- body `{ state: enum ['deposited','cleared',''] }`.
- Load the row; 404 if missing; 409 `not_cash_cheque` if `source` not in `['cash','cheque']`.
- Update `settleState:state`; when state is non-empty set `settledAt:new Date()`,
  `settledById:req.agent?.id`; when '' clear both. Return `{ ok:true, payment: toRow(p) }`.
- `// future:` comment: a cheque could also be auto-set 'cleared' when a matching KBiz
  Cheque-Deposit line imports — not built now.

### 2d. Filters — let the tabs query by source
In `listFilterSchema` add `source: z.enum(['all','transfer','cashcheque','line','manual_transfer','cash','cheque']).optional()`.
In `buildListWhere`, map it to a Prisma `where.source`:
- `'transfer'` → `{ in: ['line','manual_transfer'] }`
- `'cashcheque'` → `{ in: ['cash','cheque'] }`
- a concrete value → that string. `'all'`/absent → no source filter.
(Existing inbox/flags pass no source → unchanged, still show everything.)

### 2e. `GET /summary` — badge for the new tab
Add `cashChequePending`: count of `source in ['cash','cheque'] AND settleState = '' AND status != 'void'`.
(Add to the Summary interface in the client too.)

### 2f. CSV export — add `source`, `settleState`, cheque cols after the existing columns
(headers + row values, esc()’d as today).

## 3. Frontend (`juno/src/`)

### 3a. `lib/api.ts`
- `Payment` type: add `source: string`, `settleState: string`, `settledAt: string | null`,
  `chequeNo/chequeBank/chequeDueDate: string`.
- `Summary`: add `cashChequePending: number`.
- `PaymentFilter`: add `source?: 'transfer'|'cashcheque'|...`; `filterQuery` sets `source` param.
- New client fns: `createPayment(body)` → POST `/api/juno/payments`; `settlePayment(id,state)` →
  POST `/api/juno/payments/:id/settle`; `uploadSlip(dataB64, fileName)` → POST `${API_URL}/api/uploads`
  (auth header) returning `{ uploadId }`, and expose the resulting public URL
  `${API_URL}/content/upload/${uploadId}` to the caller.

### 3b. `Juno.tsx` — tabs
- Rename the `flags` tab label `ตรวจสอบยอด` → `ปักธง` (keep key/icon/badge).
- Add a `cashcheque` view+tab: label `เงินสด/เช็ค`, icon `Banknote` (lucide), badge =
  `summary?.cashChequePending` (rose, same as flags/recon). Place it after `recon`.
- `View = 'inbox'|'flags'|'reports'|'recon'|'cashcheque'`. Route `cashcheque` → `PaymentsView`.

### 3c. `PaymentsView` — reuse for the new tab + the Add button
- Accept `view` incl. `'cashcheque'`. Build the filter: `view==='cashcheque'` → `{ source:'cashcheque' }`
  (no status dropdown for this view; show all cash/cheque). inbox/flags unchanged.
- **Add button:** on `view==='inbox'` only, a `+ เพิ่มรายการ` button on the toolbar (emerald,
  next to CSV) → opens `AddPaymentModal`. On success → `load()` + `onChanged()`.
- Column note: for the cashcheque view it's fine to reuse the same columns; the ธนาคาร column
  will be blank for cash — acceptable.

### 3d. `AddPaymentModal` (new component in `Juno.tsx` or its own file)
- A modal (match the existing `CheckDialog` modal style: fixed overlay, white rounded card, click-
  outside to close). Top: a 3-way method picker segmented control — **โอนเงิน / เงินสด / เช็คธนาคาร**.
- Common fields: รหัสลูกค้า (customerCode), ชื่อลูกค้า (customerName), จำนวนเงิน (amount, numeric-ish),
  หมายเหตุ (note).
- method === โอนเงิน: also ธนาคารที่รับ (bank), วันเวลาโอน (transferAt, free text), อ้างอิง (ref),
  and a **แนบสลิป (ถ้ามี)** file input → on pick, read as base64 → `uploadSlip` → keep the returned
  URL in state (show a ✓ / thumbnail). source sent = `manual_transfer`.
- method === เงินสด: no extra fields. source = `cash`.
- method === เช็คธนาคาร: เลขที่เช็ค (chequeNo), ธนาคาร (chequeBank), วันที่บนเช็ค (chequeDueDate).
  source = `cheque`.
- Validate amount > 0 and customer present before enabling บันทึก. On save → `createPayment` with
  the method's fields → close + refresh. Surface errors inline (reuse the drawer error style).

### 3e. `Detail` drawer — cash/cheque settle + cheque info
- When `payment.source === 'cash' || 'cheque'`: add a small section (below the fields grid) titled
  `การรับเงิน (เงินสด/เช็ค)` showing the method, and for cheque the chequeNo/bank/dueDate.
- Settle control: a badge showing the state (`รอฝาก`/`ฝากธนาคารแล้ว` for cash; `รอเคลียร์`/`เคลียร์แล้ว`
  for cheque) + a button that toggles it via `settlePayment`:
  - cash: `''` → button `ฝากธนาคารแล้ว` (sets 'deposited'); when 'deposited' → a small `ยกเลิก` to revert to ''.
  - cheque: `''` → button `เคลียร์แล้ว` (sets 'cleared'); when 'cleared' → `ยกเลิก` to revert.
  Use the existing `run()` busy/error pattern; `applyUpdate` on success so the row + badge refresh.
- The RE icon-rail (ตรวจแล้ว/print/ยืนยันใน Express/ปักธง/ยกเลิก) stays for these rows too — hand-added
  cash/cheque still get an RE + cover, per decision #3. (For a cash row there's no slip → the slip
  area shows the existing ไม่มีสลิป placeholder; fine.)

### 3f. Optional: the cashcheque list could show a settle badge column — nice-to-have, skip if it
complicates the shared table; the drawer + tab badge are the must-haves.

## 4. Verify (all must pass)
- `cd api && npx prisma validate && npx prisma generate && npx tsc --noEmit`
- `cd juno && npm install && npm run build`
- Grep: `source` in schema + migration + toRow + api client Payment type; `POST '/api/juno/payments'`
  route present; `ปักธง` present and `ตรวจสอบยอด` gone from the tab list; `settle` route present.

## 5. Non-goals (do NOT build)
- Cheque auto-clearing from KBiz imports (future note only, §decision 4).
- Any change to Minerva's `/to-finance` hook, the bank parsers, or the reconciliation matcher.
- Any auth/role change — Juno stays supervisor-only with the existing gating.
