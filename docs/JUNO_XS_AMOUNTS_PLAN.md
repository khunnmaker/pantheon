# Juno: FIN-declared XS amounts + XS tab

Plan author: Fable (main thread) · Executor: sonnet subagent · 2026-07-21

## Context

Juno = finance app: frontend `juno/`, backend routes `api/src/routes/juno.ts`, engines
`api/src/finance/`.

Three payment-document families: RE (Express receipts, ReReceipt), MB (manual bills, ManualBill +
`juno/src/Bills.tsx` tab), XS (Express จ่ายสินค้าภายใน docs used as a parallel sales channel from
doc `XS6900340`; imported from STTRNR6.TXT by `api/src/finance/parseXsDocs.ts` into `XsDoc`,
CEO-only `POST /api/juno/xs/import`, upsert-by-xsNo whose UPDATE branch refreshes
docDate/note/amount/importedAt but never the close stamps).

`XsDoc` model (schema.prisma): `xsNo` `@unique` (compact "XS6900342", joins `Payment.billNos`
directly), `docDate`, `note` (carries the Express customer code), `amount` (raw report sum — THE
UNRELIABLE VALUE), `paymentConfirmedAt`/`By` + `closeNote` (manual CEO ปิดเอกสาร stamps, route
`POST /api/juno/docs/:no/close`, supervisor-only).

Typed XS numbers are stored verbatim in `Payment.billNos` (same array as MB + external refs).
`api/src/finance/receiptReferences.ts` and `juno/src/lib/receiptReferences.ts` are BYTE-IDENTICAL
copies (a drift-guard script — `scripts/check-shared-drift.mjs` — enforces this; the api copy is
authoritative). Before this change, `normalizeBillReference` classified: `/^9\d{6}$/` (opt.
MB-prefixed) → 'manual'; `/^[A-Z]{1,4}\d{4,10}$/` → 'external' (XS landed here); else 'other'.

Verify dialog = `CheckDialog` in `juno/src/Juno.tsx`, chips hook `useReceiptChipsInput`, chips box
`ReceiptChipsBox`. Soft registry check runs ONLY for MB numbers. Save calls `verifyPayment`
(`juno/src/lib/api.ts`) → `POST /api/juno/payments/:id/verify` (`juno.ts`, zod
`verifyBodySchema`). CRITICAL INVARIANT (regression-tested): the verify route's keepRecorded rule
— doc edits on a status='recorded' payment must NOT demote it or delete its JupiterTxn.

Doc-recon engine `api/src/finance/reRecon.ts`: `buildReReconIndex(payments, reAmountByCore,
billAmountByNo)`; only bill refs present in `billAmountByNo` participate in group pricing; unknown
refs are annotations. Route `GET /api/juno/re` loads MB+XS registries and fills `billAmountByNo`
— XS via `x.xsNo → x.amount`. XS recon rows were filtered by `x.xsNo >= XS_SALES_FROM &&
num(x.amount) > 0` (`XS_SALES_FROM = 'XS6900340'`). MB/XS "closed" = `paymentConfirmedAt !== null
|| xsNo on a status='recorded' payment`. Closed ALWAYS wins over mismatch.

MB tab template: `juno/src/Bills.tsx` + server `GET /api/juno/bills?q&status`. Badge wiring:
`Juno.tsx` `handleBillCounts` → `billUnpaid` → tab count. Tab registration needs: `View` union,
`validViewKeys`, `PaymentsView` Exclude type, `tabGroups` (MB tab sits in group "ขั้น 1–2 ·
รับเงิน+ตรวจ"), body render switch.

Access model in juno.ts: default-deny allowlists. FIN employees have the finance surface (incl.
POST /verify); a bills-only lane (gm role Nee/Noon + per-person `BILL_ISSUER_EMAILS` "Mail") has
ONLY MB CRUD; supervisor = full. Existing money-string parsing: `moneyStringSchema`
(comma-tolerant) used by `creditUsed`/`discExpected` — reused here.

`Payment.discExpected` = payment-level contribution CAP for the เกิน/ขาด ledger. It is a DIFFERENT
concept from the new per-doc amount — not touched or reused.

## A. FIN-declared per-XS amount

**A1.** `schema.prisma` `XsDoc`: added `confirmedAmount String @default("")`,
`confirmedAmountAt DateTime?`, `confirmedAmountBy String @default("")` next to the close-stamp
cluster. ADD-only migration `20260802000000_juno_xs_confirmed_amount` (sorts after
`20260801000000_juno_doc_recon`), hand-written SQL mirroring the existing migration style — pure
`ALTER TABLE ... ADD COLUMN`.

**A2.** `receiptReferences.ts` (both copies, kept byte-identical, drift guard green): added
billKind `'xs'` matched by `/^XS\d{7}$/` on the compact value, checked BEFORE the generic external
regex. Stored value stays the verbatim compact "XS6900342" (no data migration — existing chips
keep working). `displayReceiptReference` needed no code change for xs (it already falls through to
the raw value for any non-manual, non-`MB\d{6}` billKind). `isManualBillReference` unchanged. Chip
tone in `Juno.tsx`: kept the amber palette (`BILL_TONE_CLS.xs` = same as `external`) but title
"เอกสาร XS (Express)" instead of เลขเอกสารภายนอก; 'external' keeps its current tone/title for
non-XS refs (old 6-digit "XS000001"-style refs stay 'external').

**A3.** `CheckDialog` UX: for every XS chip currently in the chips state (derived live off
`re.billNos`), renders an amount input row (label `ยอดจริงของ {xsNo}`, plain text money input,
comma-tolerant) in a small section titled `ยอดเอกสาร XS` under the chips box. Prefilled ONLY from
the doc's stored `confirmedAmount` (via the lookup below); never prefilled from the raw imported
amount. When the registry has an imported amount, shows a muted hint caption `ยอดดิบจากรายงาน: N
(ไม่ใช้)`. Save is BLOCKED (disabled + Thai message `กรุณาใส่ยอดของเอกสาร XS ทุกใบ`) while any XS
chip lacks a valid amount > 0. Removing the chip removes its row (derived live). Implemented as a
small `useXsAmounts` hook beside `useWhtControl`, plus an `XsAmountsSection` component.

**A4.** Prefill lookup: `GET /api/juno/xs/lookup?nums=XS6900342,XS6900343` (same access as
POST /verify — FIN + supervisor; bills-only lane denied by the existing default-deny hook, since
the route is not in `GM_JUNO_ALLOWED_ROUTES`) returning `{docs: [{xsNo, imported, amount,
confirmedAmount}]}`. `CheckDialog` fetches it debounced on chip changes (same pattern as the
existing MB soft-check effect). Client helper `getXsLookup` in `juno/src/lib/api.ts`.

**A5.** `POST /verify`: `verifyBodySchema` gained optional `xsAmounts:
z.record(z.string(), moneyStringSchema)`. Server rules:
- Every XS chip on the request needs an amount — from `xsAmounts`, or already stored as
  `XsDoc.confirmedAmount` when `xsAmounts` omits it (preserved). Neither present → `400
  { error: 'xs_amount_required', xsNo, message }`. The message tells FIN to use the per-payment
  ตรวจแล้ว dialog (the batch-verify queue can't send amounts, so it surfaces this same
  message via the existing generic error-display plumbing rather than swallowing it).
- Amounts must parse to > 0 → else `400 xs_amount_invalid`. Keys in `xsAmounts` that are not XS
  chips on this request → `400 xs_amount_unknown`.
- Persistence: upsert `XsDoc` by xsNo inside the SAME transaction as the payment update (shared
  helper `api/src/finance/xsAmounts.ts` → `upsertXsConfirmedAmount`) — update sets
  `confirmedAmount` + `confirmedAmountAt=now` + `confirmedAmountBy=<actor>`; create makes a stub
  row (`docDate/note/amount` = `''`) with the confirmed fields set. Same-value re-save is
  idempotent. Never touches `paymentConfirmedAt`/`closeNote`.
- The required-amount lookup (read of already-stored `confirmedAmount`) runs as a plain query
  just before the transaction opens (cheap, no lock needed); the actual upsert (the durable
  write) runs inside the same transaction as the payment update, so a save can never advance the
  payment while leaving a chip's confirmedAmount stale.

**A6.** XS import upsert (`POST /api/juno/xs/import`): the UPDATE branch was already scoped to
`docDate/note/amount/importedAt` only — verified untouched by a new test
(`api/test/junoXsAmounts.test.ts`) asserting the upsert call's `update`/`create` objects never
contain `confirmedAmount`/`confirmedAmountAt`/`confirmedAmountBy`.

**A7.** Recon pricing: in `GET /re`, `billAmountByNo` is filled for XS with effective =
`num(confirmedAmount) > 0 ? confirmedAmount : amount`. The XS row filter became `x.xsNo >=
XS_SALES_FROM && num(effective) > 0`. Exposed `importedAmount` on the XS recon row DTO only when
it differs from the effective figure (`amount` stays = effective, so the engine/UI math elsewhere
is unchanged). `ReRecon.tsx`'s row detail shows `ยอดดิบจากรายงาน` when present.

## B. XS tab

**B1.** `GET /api/juno/xs?q=&status=all|paid|unpaid|closed` — access: FIN employees + supervisor
(same surface as `GET /bills`), bills-only lane denied (not in `GM_JUNO_ALLOWED_ROUTES` — pinned
by a test for both gm and the per-person Mail grant). Rows = XsDoc where `xsNo >= XS_SALES_FROM`
only. Live per-row status: `closed` (`paymentConfirmedAt != null` OR xsNo carried by a
status='recorded' payment) > `paid` (xsNo carried by any non-void payment) > `unpaid`. No amount
policing in status (mirrors the MB binary-paid ruling). Search `q` over xsNo + note. Returns
`{docs:[{id, xsNo, docDate, note, amount, confirmedAmount, effectiveAmount, paid, closed,
closeNote, paymentConfirmedAt, paymentConfirmedBy, linkedPaymentCount, status}], counts:{unpaid}}`
where `counts.unpaid` counts the full (q-less) sales-era set.

**B2.** `POST /api/juno/xs/:xsNo/amount {amount}` (same access as verify) — sets
`confirmedAmount`/`At`/`By` on an EXISTING XsDoc (404 if unknown; > 0 required). Shares the same
`upsertXsConfirmedAmount` helper as the verify path.

**B3.** `juno/src/XsDocs.tsx` — modeled on `Bills.tsx` (list + drawer, same visual language):
columns XS no · docDate · note · ยอดที่ยืนยัน (confirmedAmount, em-dash when blank, muted `ดิบ: N`
sub-hint when the imported amount differs) · status chip (ปิดแล้ว slate / จ่ายแล้ว emerald /
ยังไม่จ่าย amber). Search box + status select. Drawer: full fields, linked-payment count, inline
confirmedAmount editor (saves via B2), and — CEO only — ปิดเอกสาร/ยกเลิกปิด reusing the existing
`closeDoc` client fn. No create/void/delete (a header caption points to the เอกสาร tab's
STTRNR6.TXT import).

**B4.** Tab registration in `Juno.tsx`: View key `'xs'`, label `XS`, placed in the group "ขั้น 1–2
· รับเงิน+ตรวจ" immediately after the MB tab; badge = unpaid count via `handleXsCounts` (mirrors
`handleBillCounts`) + fetched in `refreshSummary`. `View` union, `validViewKeys`, `PaymentsView`
Exclude type, and the render switch all updated. Bills-only users (`scope === 'billsOnly'`) never
see the tab — `validViewKeys` for that scope stays `['bills']` only.

## Tests

`api/src/finance/receiptReferences.test.ts` — XS classification ('xs' before external), MB/RE/
external/other regressions (incl. the old 6-digit "XS000001"-shaped ref staying 'external').

`api/test/junoXsAmounts.test.ts` — verify route (`xs_amount_required`/`_invalid`/`_unknown`,
preserve-when-stored, upsert-stub-creation, stamps, idempotent re-save, `keepRecorded` invariant
untouched); xs/import UPDATE-branch preservation; `GET /re` XS pricing (confirmedAmount override,
raw fallback, zero-imported-but-confirmed doc now appearing); `GET /xs` (status precedence, counts,
search, sales-era filter, access incl. 401/403); `POST /xs/:xsNo/amount` (happy path, 404, invalid,
access).

## Gates run

`npx prisma generate`, `npx tsc -p api --noEmit`, full api vitest suite, the receiptReferences
drift-guard script, the discrepancy guard script, and the juno frontend build (`tsc -b && vite
build`) — see the executor's final report for exact results.
