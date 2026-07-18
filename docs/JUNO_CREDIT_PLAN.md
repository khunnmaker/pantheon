# Juno customer credit balance — implementation plan

## 1. Data model and ADD-only migration

- Add migration `api/prisma/migrations/20260731000000_juno_customer_credit/migration.sql`; it sorts after the current `20260730000000_minerva_autosend_groundwork` migration and only adds columns, a table, constraints, indexes, and foreign keys.
- Add `Payment.creditUsed String @default("")`. It is entered/stored as baht text like `whtAmount`; blank means zero. Add `Payment.creditEntries CustomerCreditEntry[]`.
- Add one signed ledger table (no cached balance):

  ```prisma
  model CustomerCreditEntry {
    id            String   @id @default(cuid())
    customerKey   String
    customerCode  String   @default("") // trimmed snapshot
    customerName  String   @default("") // trimmed snapshot
    kind          String                 // grant | spend
    amountSatang  Int                    // grant > 0; spend < 0
    paymentId     String
    payment       Payment  @relation(fields: [paymentId], references: [id], onDelete: Cascade)
    createdAt     DateTime @default(now())
    updatedAt     DateTime @updatedAt
    createdBy     String   @default("")

    @@unique([paymentId, kind])
    @@index([customerKey, createdAt])
    @@index([paymentId])
  }
  ```

- Hand-write SQL checks for `kind IN ('grant','spend')`, nonzero `amountSatang`, and sign matching kind. `@@unique([paymentId, kind])` makes grant confirmation and spend replacement idempotent while still allowing one payment to have both kinds if a valid edge case ever produces that combination.
- Customer key helper: `customerCreditKey(payment)` returns `customerCode.trim()` when non-empty, otherwise `customerName.trim()`, otherwise `null`; do not case-fold or silently use sender/receipt name. Store the code/name snapshots for readable history, but all grouping and locking uses `customerKey`.
- Balance is always `SUM(amountSatang)` in integer satang. Add `api/src/finance/customerCredit.ts` for the key helper, balance/availability helpers, typed errors, and transactional mutations. Before reading a customer's balance or changing its entries, acquire `pg_advisory_xact_lock(hashtextextended(customerKey, 0))` through a tagged Prisma raw query; lock the Payment row as well for confirm/resolve/verify/void/delete. This serializes same-customer balance reads and writes, including two spends against different payments.
- A grant is considered unspent enough to remove only when `customer balance - grant.amountSatang >= 0`; otherwise some pooled spend depends on it and removal is blocked. Do not attempt per-grant allocation or add a mutable balance column.

## 2. API and lifecycle changes (`api/src/routes/juno.ts`)

### Read routes

- `GET /api/juno/payments/:id/credit-balance` derives the key from the stored Payment and returns `{ customerKey, balance, currentUsed, availableToPayment, canSpend }` in baht numbers. `availableToPayment = current balance + this payment's existing spend`, so re-verification can replace its spend rather than double-count it. Missing key returns `customerKey:null` and zeros; wrong transfers return `canSpend:false`.
- `GET /api/juno/customer-credits` returns `{ totalOutstanding, customers }`. Group all ledger entries by exact key; each customer has snapshots, current balance, and chronological grant/spend history with amount, source `paymentId`, transfer/created date, REs, and actor. The UI defaults to positive balances but can reveal zero-balance history. Never return a negative balance; treat one as an invariant failure and log it.
- Keep both routes under the existing Juno app gate. Do not add them to `GM_JUNO_ALLOWED_ROUTES`; the gm default-deny remains unchanged.

### `POST /api/juno/payments/:id/disc-confirm`

- Keep the supervisor check as the handler's first line. Run confirmation and ledger mutation in one transaction.
- On `{ confirmed:true }` with `discResolution='credit'`, recompute the payment's live discrepancy through the shared discrepancy helper inside the transaction. Require `diffSatang > 0` and a customer key, then create the `grant` with exactly that diff. If `(paymentId,'grant')` already exists, leave it unchanged and only ensure the confirmation stamp is present; repeated confirmation must not create or enlarge credit.
- On `{ confirmed:false }`, lock the grant's customer, require that removing the grant would keep the balance nonnegative, delete the grant, and clear confirmation stamps atomically.
- New 409s:
  - `credit_customer_required` — `กรุณากรอกรหัสลูกค้าหรือชื่อลูกค้าก่อนยืนยันเครดิต`
  - `credit_overpay_required` — `สร้างเครดิตได้เฉพาะรายการยอดเกินที่มากกว่า 0`
  - `credit_grant_spent` — `เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงยกเลิกการยืนยันไม่ได้`
- Preserve existing `forbidden`, `void_locked`, and `resolution_required` behavior.

### `POST /api/juno/payments/:id/disc-resolve` and `/discrepancy`

- Move resolution mutation into the same credit transaction helper. Any action that clears a confirmed credit stamp (clear resolution, change away from `credit`, or edit a confirmed resolution/note) must first remove its grant under the same nonnegative-balance check; otherwise return `409 credit_grant_spent` with `เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงเปลี่ยนวิธีจัดการไม่ได้`.
- A still-unconfirmed `credit` resolution has no ledger effect. Changing to/from it remains FIN-owned; only supervisor confirmation grants value.
- Prevent changing `discExpected` while a confirmed grant exists: `409 credit_grant_locked`, message `กรุณายกเลิกยืนยันเครดิตก่อนแก้ยอดตามเอกสาร`. This keeps the immutable grant amount tied to the diff the CEO actually confirmed.

### `POST /api/juno/payments/:id/verify`

- Extend `verifyBodySchema` with `creditUsed: moneyStringSchema.optional()`. Omitted means preserve the existing value/entry (important for the batch dialog); explicit `''` or zero clears it. Store positive values trimmed in `Payment.creditUsed`, and use `moneyToSatang` for every comparison.
- For a requested spend, require a customer key and a normal payment. Lock the payment and customer, compute availability excluding this payment's current spend, and require `requestedSatang <= availableSatang`. In the same transaction update Payment plus upsert the unique negative `spend` entry; deleting/zeroing removes the entry. Re-verification replaces the amount rather than appending another spend.
- New 409s:
  - `credit_customer_required` — same Thai message as confirmation
  - `credit_insufficient` — include `{ available }` and `เครดิตลูกค้าคงเหลือไม่พอ (ใช้ได้ ฿X)`
  - `credit_wrong_transfer` — `รายการโอนเงินผิดไม่สามารถใช้เครดิตลูกค้าได้`
  - `credit_grant_locked` — when re-verification would change RE/bill, WHT, expected amount, wrong-transfer state, or other discrepancy-driving data on a confirmed grant; require CEO un-confirm first.
- Marking/resetting a wrong transfer always removes any spend entry and clears `creditUsed` in the same transaction. Existing wrong-transfer validations still run. Bank matching continues to compare only raw `Payment.amount`.

### Identity edits, void, and hard delete

- `PATCH /api/juno/payments/:id`: calculate old/new customer keys. If the key would change while that payment owns any grant/spend entry, return `409 credit_customer_locked`, `กรุณาล้างการใช้เครดิตหรือยกเลิกยืนยันเครดิตก่อนแก้ข้อมูลลูกค้า`; otherwise keep existing edit behavior.
- `POST /api/juno/payments/:id/status { status:'void' }`: transactionally delete this payment's spend and set `creditUsed=''` (releasing credit). If it owns a grant, apply the same nonnegative post-removal check; on success delete the grant and clear only `discConfirmedAt/By` so restore resumes as awaiting CEO confirmation. If spent, return `409 credit_grant_spent` with `เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงยกเลิกรายการไม่ได้`. Other status transitions remain unchanged.
- `DELETE /api/juno/payments/:id`: keep supervisor-first authorization and bank-link recomputation. In one transaction, lock/check any grant as above, then delete Payment; FK cascade removes its grant/spend entries. A spend-source delete therefore releases credit automatically. A spent grant returns `409 credit_grant_spent` with `เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงลบรายการไม่ได้`.

## 3. Money and reconciliation engines

- `api/src/finance/discrepancy.ts`:
  - Extend `DiscrepancyPaymentInput` with `creditUsed`.
  - Keep `grossSatang()` as raw `amount + whtAmount` so existing WHT/income meaning does not drift.
  - Add `effectivePaidSatang(payment) = grossSatang(payment) + moneyToSatang(payment.creditUsed)`.
  - Make `buildDiscrepancyComponents()` sum effective paid, and make the per-payment live diff in `getDiscrepancySnapshot()` use effective paid. Preserve raw `gross` in DTOs; add `creditUsed` and `effectivePaid` so the UI can show the breakdown. Wrong transfers always have zero credit.
  - Extract/reuse a transaction-client-compatible `getDiscrepancyForPayment(db,id)` (or equivalent) so `disc-confirm` grants from exactly the same satang diff shown in the ledger, not a second formula.
- `api/src/finance/reRecon.ts`:
  - Extend `ReReconPayment` with `creditUsed` and replace payment-side `grossOf` use with an integer-satang `effectivePaidOf = amount + whtAmount + creditUsed`; retain the existing 100-satang match tolerance and apportion from satang totals before converting for display.
  - Add `creditUsed` to the candidate Payment select in `GET /api/juno/re`. A 2,000 payment + 3,000 credit against a 5,000 RE must return `matched`.
- `toRow()` and Juno DTO types gain `creditUsed` plus `effectivePaidAmount`; keep `grossAmount = amount + whtAmount`. `GET /api/juno/export.csv` adds `creditUsed` (without changing/removing existing columns).
- Do not feed `creditUsed` into `grossOf()` in `routes/juno.ts`, reports, summary totals, WHT summaries, Jupiter income sync, manual-bill paid totals, or bank matching. A spend settles an RE but is not new cash or income.

## 4. UI (`juno/src/lib/api.ts`, `Discrepancies.tsx`, `Juno.tsx`)

- API client/types: add Payment/Discrepancy fields, `creditUsed` on `verifyPayment`, `getPaymentCreditBalance(id)`, `getCustomerCredits()`, response/history types, and Thai mappings for every new 409 code.
- `Discrepancies` remains the existing `disc` tab:
  - Change summary grid to four cards and add `เครดิตคงเหลือ` from `totalOutstanding`.
  - Add a `CustomerCreditList` section below the discrepancy table: one row/card per customer with outstanding balance and expandable chronological `+ grant` / `− spend` history linked by source payment metadata. Default to outstanding customers; include a small “ดูประวัติที่ใช้หมดแล้ว” toggle.
  - Discrepancy rows show raw gross as today, `ใช้เครดิต ฿X` subtext when positive, and effective-paid math in the signed diff. Confirmation/resolution errors must display the server's Thai 409 message instead of a generic alert.
- `CheckDialog` only (not `BatchCheckDialog`): fetch `GET /payments/:id/credit-balance` when opened. If `availableToPayment > 0`, show `ลูกค้ามีเครดิต ฿X`, a money input `ใช้เครดิต`, and seed it from `payment.creditUsed`. Send the explicit value on save; hide/zero it for wrong transfers. The live preview becomes `payment.amount + live WHT + live creditUsed - expected`, with a compact raw/WHT/credit breakdown. Client-side max validation is convenience only; the transaction remains authoritative.
- Payment list amount cell and `Detail` drawer show `ใช้เครดิต ฿X` subtext when positive. Keep the displayed received amount and WHT block unchanged; use `effectivePaidAmount` only in discrepancy/RE-settlement context. `PaymentDiscrepancyBlock` shows the same credit subtext and server 409 messages.

## 5. Tests and guard scripts

- Extend `api/src/scripts/checkJunoDiscrepancy.ts` for effective-paid over/under/equal, 2,000 cash + 3,000 credit versus 5,000 expected, WHT + credit (`amount + wht + credit` exactly), raw-gross preservation, wrong-transfer zero-credit, and `computeReRow` matched with credit.
- Add sibling `api/src/scripts/checkJunoCustomerCredit.ts` around the exported credit service/helpers. It must cover grant on supervisor confirm, repeated confirm leaving one unchanged grant, keyless confirm 409, spend replacement/clear, spend balancing a shortfall, grant removal guards, void release, and a barrier-driven two-request race where requested totals exceed one balance and exactly one spend succeeds.
- Add `api/test/junoCustomerCredit.test.ts` Fastify route regressions for permissions, all error codes/messages, grant/resolution/un-confirm/void/delete transactions, `creditUsed` omission preservation, wrong-transfer rejection, CSV column, and income/WHT/report/bank math remaining raw. Extend `api/test/money.test.ts` for the pure discrepancy and RE math.
- Race test must exercise the same per-customer lock/transaction service used by `/verify`, not merely call a pure balance predicate twice. Assert final ledger balance is nonnegative and unique `(paymentId,kind)` prevents duplicate grant/spend rows.
- Verification commands: migration sorts last; inspect SQL as ADD-only; `npx prisma validate`; API typecheck and full Vitest; both guard scripts; Juno production build. Manual acceptance: grant/reconfirm, two concurrent spends, reduce/increase/release spend, WHT+credit preview, wrong transfer, FIN vs CEO permissions, un-confirm/change/void/delete blocked after spend, restore then reconfirm, RE tab matched, list/drawer/history/CSV display.

## Open questions

- None blocking.
