# Juno cover parity + mistaken-transfer plan

## Scope and decisions

- Plan only; implementation must preserve the API copy of `receiptReferences.ts` as authoritative.
- Cover unit = document, not payment: flatten `reNumbers + billNos`; one A6/¼-A4 page for each number, displaying `RE 6907674`, `MB 9690001` (and legacy `MB69-####`), or `XS000001`.
- Model a mistaken transfer with an explicit nullable marker (`wrongTransferAt/By`) because
  `discExpected='0'` alone is ambiguous. Reuse the existing discrepancy ledger for the workflow:
  no resolution = รอโอนเงินคืน, `refund` = FIN recorded โอนคืนแล้ว / awaiting CEO, and
  `discConfirmedAt` = CEO confirmed. Do not add a fifth Payment status or a second refund ledger.
- A wrong transfer remains `status='verified'` only as an implementation spine, but never becomes `recorded`; its displayed lifecycle is the dedicated refund lifecycle below.

## 1. Cover printing

Current blocking gates (all confirmed in the present tree):
- `juno/src/Juno.tsx`: `verifiedInView`, selected `printableRows`, and the drawer print rail all require `reNumbers.length > 0`; toolbar count is payment count.
- `juno/src/PrintCovers.tsx`: it filters out payments without REs, makes one item per payment,
  renders only `p.reNumbers`, and fetches names only for those REs. Thus MB/XS-only rows cannot
  enter or survive the print overlay; multi-document rows also do not yet expand per document.

Implementation:
- In `juno/src/PrintCovers.tsx`, derive `{ payment, kind, value, displayLabel }[]` by flattening
  both arrays in stored order (RE first, then bills) and render one `Cover` per item with a stable
  `payment.id + kind + value` key. Fetch `getReNames` only for RE items; MB/XS uses
  `payment.receiptName` fallback. Base sizing and “เลขที่เอกสาร” count on the single item.
- In `juno/src/Juno.tsx`, centralize `printableDocuments/printablePayment` and use it for toolbar,
  multi-select, drawer enablement/tooltips, and counts. The count is total documents, so one
  payment with RE+MB+XS shows `(3)` and prints three pages. Keep current status eligibility parity.
- Add a shared display formatter to both receipt-reference copies: canonical 9-leading manual numbers gain `MB `, legacy already-prefixed MB stays MB, RE gains `RE `, external keeps its stored alpha prefix. Do not infer every alpha document as MB.

## 2. Sentinel contract and persistence

- `api/src/finance/receiptReferences.ts` and `juno/src/lib/receiptReferences.ts`: add a
  `wrong_transfer` union member and recognize compact **exactly** `0000000` before the generic RE
  branch. It must never normalize as `re` or `bill`; nearby values such as `0000001` remain RE.
- ADD-only migration `api/prisma/migrations/20260729000000_juno_wrong_transfer/migration.sql`
  plus `api/prisma/schema.prisma`: add nullable `Payment.wrongTransferAt DateTime?`,
  `wrongTransferBy String @default("")`, and an index on `wrongTransferAt`. No rewrite/drop and no
  automatic historical backfill; run a read-only predeploy query for existing `0000000` rows and
  have FIN re-save only confirmed mistaken transfers.
- Extend `toRow` and `juno/src/lib/api.ts` `Payment`/request types with `wrongTransfer` (wire boolean
  derived from the timestamp), timestamp, and actor; keep all wrong-transfer fields excluded from
  the generic PATCH schema.

## 3. Verify API and dialog

- Extend `POST /api/juno/payments/:id/verify` with optional `wrongTransfer: boolean`:
  - `true` requires empty normalized RE/bill arrays; atomically set `status='verified'`, marker,
    `discExpected='0'`, clear prior resolution/confirmation, RE/bill mirrors, WHT and receipt-only
    fields. Reject mixed sentinel + real chips (`wrong_transfer_mixed`) server-side.
  - `false` + real documents is correction: clear marker and sentinel-owned discrepancy stamps,
    then save documents normally. If the payment had been recorded, demote it and invoke Jupiter
    sync cleanup; never preserve `recorded` for this transition.
  - `false` + empty arrays is allowed only for an existing unresolved wrong transfer and means
    “ไม่ใช่โอนเงินผิด / กลับไปรอตรวจ”: clear marker/ledger and return to `received`. If refund is
    resolved/confirmed, require undo confirmation then clear resolution first.
- In `juno/src/Juno.tsx` receipt-chip state, render a destructive red “โอนเงินผิด 0000000” chip,
  make it mutually exclusive with all document chips, hide/disable receipt name, customer type,
  WHT and expected-amount controls, and send `wrongTransfer:true`. The batch dialog permits it only
  for the current row and disables “ใช้กับทุกใบที่เหลือ”. Display precise server errors.
- In `api/src/finance/discrepancy.ts`, defensively reject `0000000` as an RE core so legacy bad data
  cannot join an imported RE component.

## 4. Lifecycle and refund tracker

- `juno/src/Juno.tsx` `stageOf()` checks `void` first, then wrong transfer before raw recorded:
  marker + no resolution → **รอโอนเงินคืน** (rose); `refund` without CEO stamp →
  **โอนคืนแล้ว · รอ CEO ยืนยัน** (amber); confirmed → **โอนคืนแล้ว** (emerald).
- `api/src/routes/juno.ts` discrepancy snapshot returns `wrongTransfer`; typed expected zero makes
  its diff equal the whole incoming gross. `disc-resolve` allows only `refund` (or reset) for these
  rows; `disc-confirm` remains CEO-only. Block `/status {recorded}` for marked rows.
- `juno/src/Discrepancies.tsx`: show a dedicated โอนเงินผิด/refund presentation (amount to return,
  not “ยอดตาม RE”), FIN “บันทึกว่าโอนคืนแล้ว”, CEO confirm/undo, and reset-classification action.
  Include void rows in an archived/void filter so soft-void is reversible; void preserves marker
  and audit stamps but removes the row from every active count. Restoring resumes its prior stage.

## 5. Exclude from income and reconciliation flows

- `api/src/routes/juno.ts`: exclude marked rows from normal `GET /payments` queues (they live in
  the discrepancy tracker), `/summary` total/status/flag/tax/receive counts, WHT summary,
  `/reports`, `/export.csv`, manual-bill paid totals, `/payments-recon`, bank watchlist and
  `verifiedUnreconciled`. RE recon is also protected by empty `reNumbers` plus an explicit
  `wrongTransferAt:null` predicate. Discrepancy open/pending-confirm counts deliberately include it.
- Bank links are evidence of the real incoming credit: do not detach an already matched line and
  allow later matching, but include `wrongTransfer` on bank link/suggestion DTOs and render a red
  chip in `juno/src/Recon.tsx`. Exclude wrong-only matched lines from ordinary matched-unconfirmed
  cards and Express-confirm batches; per-line Express confirm returns `wrong_transfer_only` when
  it has no regular linked payment. A mixed bank line confirms only regular payments.
- When a linked/Express-confirmed payment is newly marked wrong, clear the bank line’s Express
  confirmation only if it has no other regular linked payment; preserve shared-line confirmation.
  All match routes still recompute sums normally, but can never advance the marked payment.
- `api/src/jupiter/sync.ts`: both live and batch sync require `status='recorded' AND
  wrongTransferAt=null`; marking a formerly recorded row deletes its existing `sync:juno` income.

## 6. Edge-case rules

- Sentinel mixed with any real/pending chip: reject; never silently discard either side.
- Correction/undo is explicit as above; existing bank matches remain and become usable again after
  a real document correction. Void suppresses workflow without erasing classification history.
- A wrong-transfer-only bank line remains visibly matched as a bank event, but cannot be confirmed
  to Express or counted as income; an unmatched line remains actionable until linked/classified.

## 7. Tests, guards, and acceptance

- Update `api/src/finance/receiptReferences.test.ts`: exact sentinel, near miss, API/frontend label
  cases for RE/canonical MB/legacy MB/XS, and mutual disjointness.
- Update `api/src/scripts/checkJunoDiscrepancy.ts` and `api/test/money.test.ts`: no-RE expected-zero
  whole-gross refund, sentinel excluded from RE components/recon, void behavior, refund states.
- Add `api/test/junoWrongTransfer.test.ts` route regressions for verify mark/mixed/reset/recorded correction, FIN→CEO permissions,
  report/CSV/summary exclusions, bank wrong-only/mixed confirmation, and Jupiter cleanup.
- Extend `scripts/check-shared-drift.mjs` with a normalized contract check between the authoritative
  API receipt-reference module and Juno copy, including sentinel and display formatter exports.
- Verify: `npx prisma validate`, API typecheck + Vitest + discrepancy guard, Juno build, drift guard.
  Manual print matrix: RE-only, MB-only, XS-only, RE+MB+XS, multi-RE, batch count/page count; manual
  workflow matrix: mark, refund, CEO confirm/undo, reset, void/restore, pre-matched and mixed line.

## Open questions

- None blocking. This plan treats a bank link as auditable evidence (kept visible but removed from
  income/Express action counts), rather than deleting the real bank relationship.

## ADJUDICATION (Fable, 2026-07-18) — binding amendments, implement the plan WITH these

1. **Cover unit stays = PAYMENT (owner decision 2026-07-06 — do NOT change it).** §1's
   per-document expansion is REJECTED. One cover per payment, exactly as today; the single cover
   now lists ALL its document numbers (reNumbers + billNos) with display labels (RE 6907674 /
   MB 9690001 / MB69-0001 / XS000001). Eligibility gates (toolbar `verifiedInView`,
   `printableRows`, drawer rail) change from `reNumbers.length > 0` to
   `reNumbers.length + billNos.length > 0`; counts stay payment counts. getReNames still fetched
   for RE numbers only; keep receiptName fallback. The shared display formatter in both
   receiptReferences copies is APPROVED.
2. **Wrong-transfer rows STAY VISIBLE in the normal payments list** (rose stage badge per §4) —
   §5's removal from `GET /payments` queues is REJECTED (queue must never lose rows, 07-14 rule).
   They are additionally surfaced in the discrepancy tracker for the refund workflow as planned.
   Income AGGREGATE exclusions in §5 (summary counts, WHT, reports totals, manual-bill paid
   totals, recon eligibility, Express confirm, Jupiter sync) are all APPROVED. CSV: do NOT drop
   the rows — include them with a `wrongTransfer` column (audit exports must not lose rows);
   reports totals exclude them.
3. Everything else in §§1–7 is approved as written.
