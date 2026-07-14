# JUNO — ยอดเกิน/ขาด (payment discrepancy ledger)

Owner request 2026-07-12: when a customer pays MORE than the price (e.g. transfers 300 — or a
fat-fingered 2,000 — for a 200-baht RE), Juno must surface the excess and track what happened to
it. Review findings (2026-07-12, code audit): the auto-matcher is exact-amount so nothing flags an
overpay; the กระทบยอด RE tab lumps over/under into one ยอดไม่ตรง status with no excess filter and
no resolution trail; a manual bank link with `sumDelta ≠ 0` shows only a transient amber badge and
ยืนยัน Express proceeds unchecked; no field anywhere can record refunded/credited decisions.

Owner decisions (2026-07-12, in-chat, all four explicit):
1. Excess handling is **case-by-case** — sometimes refunded (โอนคืน), sometimes held as credit
   for the next order → the ledger needs BOTH resolution paths.
2. Scope = **both directions**: เกิน (overpay, diff > 0) AND ขาด (underpay, diff < 0), signed.
3. Catch at **both points**: FIN can type the expected amount in the ตรวจแล้ว dialog the moment
   they spot it; the ARRCPDAT (RE) import auto-flags the rest.
4. **FIN records the resolution, CEO confirms** — mirrors the cash/cheque receive-gate pattern.

## Definitions

- `gross(payment) = num(amount) + num(whtAmount)` — the existing `grossOf` helper. ALL comparisons
  in this feature use gross (ยอดเต็ม/RE ก่อนหัก), never net. A 97-net/3-WHT payment against a
  100-baht RE is BALANCED — it must never appear in this ledger.
- `expected(payment)` = `discExpected` when set (FIN-typed, takes priority), else the RE-derived
  amount (below), else undefined (payment not in scope).
- `diff = gross − expected`. `diff > 0` → เกิน. `diff < 0` → ขาด. `diff = 0` → not listed.

## Schema — ADD-only migration `20260718000000_juno_discrepancy`

Timestamp MUST sort after `20260717000000_party_identity` (verify by listing the migrations dir).
Hand-write `migration.sql` following the house pattern (see `20260713120000_juno_wht`); verify
with `prisma migrate diff` / `prisma validate`. Do NOT run `migrate dev`/`deploy` (no DB here).
Do NOT alter existing columns. `Payment` gains:

```prisma
discExpected    String    @default("")   // FIN-typed expected gross (ยอดตาม RE); '' = not set
discResolution  String    @default("")   // '' | 'refund' | 'credit' | 'chase' | 'writeoff'
discNote        String    @default("")
discResolvedAt  DateTime?
discResolvedBy  String    @default("")
discConfirmedAt DateTime?
discConfirmedBy String    @default("")
```

Resolution meanings (DB keeps the English keys; UI shows Thai):
`refund` = โอนคืนแล้ว · `credit` = เก็บเป็นเครดิตรอบหน้า · `chase` = รอลูกค้าชำระเพิ่ม (underpay
only) · `writeoff` = ปิดส่วนต่าง (ปัดเศษ/ยกให้). UI offers refund/credit/writeoff for เกิน and
chase/writeoff for ขาด; the server validates enum membership only.

## Detection

**A) Typed (ตรวจแล้ว dialog).** The RE-check dialog gains an OPTIONAL field
"ยอดตาม RE (ก่อนหัก)" with a live signed preview when it differs from gross — e.g. `เกิน +100.00`
/ `ขาด −50.00`, colored. `/verify`'s zod schema gains optional `discExpected` (money string or
''); stored as typed. Also add standalone `POST /api/juno/payments/:id/discrepancy
{ expected: string }` (any Juno user) to set/adjust/clear it outside the dialog — from the ledger
row or the payment drawer. Money-string validation = the same helper the other amount fields use.

**B) RE-derived (auto, from the ARRCPDAT import).** Compute payments↔REs connected components
(payments joined by shared `reNumbers` cores to imported `ReReceipt` rows — same core
normalization GET /re uses; non-void payments only). A payment is an AUTO candidate iff it is a
**single-payment component** whose REs are ALL imported: expectedRE = Σ `ReReceipt.amount` over
its REs; diff = gross − expectedRE. This is deliberate: one payment covering RE A(200)+B(100) with
a 300 transfer is balanced and must NOT be flagged (no per-RE double-count). Mismatched
MULTI-payment components are NOT ledger rows in v1 — they stay in กระทบยอด RE; the ledger header
shows a hint chip ("กลุ่มหลายรายการยอดไม่ตรง n กลุ่ม — ดูใน กระทบยอด RE") when any exist. FIN can
still pull one member payment into the ledger by typing `discExpected` on it.

**C) Lifecycle.**
- **เปิดอยู่ (open):** diff ≠ 0 and `discResolution = ''`.
- **รอ CEO ยืนยัน (resolved):** `POST /api/juno/payments/:id/disc-resolve { resolution, note? }`
  (any Juno user) stamps discResolvedAt/By. Sending `resolution: ''` clears resolution+note+
  resolved stamps AND the confirm stamps.
- **เสร็จสิ้น (confirmed):** `POST /api/juno/payments/:id/disc-confirm { confirmed: boolean }` —
  **supervisor-only, 403 in-handler first line** (same pattern as DELETE/receive). Requires a
  resolution to be present. `confirmed:false` un-stamps.
- **Self-heal:** if live diff returns to 0 (second RE lands, amount corrected) while resolution
  stamps exist, keep showing the row in its resolved/confirmed section with an informational
  "ยอดลงตัวแล้ว" badge; FIN can clear it. Rows with stamps are ALWAYS listed even when diff = 0 —
  stamps are never silently hidden.

**D) Group-aware fix to GET /re — CONDITIONAL, verify first.** The audit found
`api/src/routes/juno.ts:1516–1548` counts a payment's ENTIRE gross against EVERY RE it lists, so a
single 300-baht payment covering REs A(200)+B(100) apparently shows BOTH REs as ยอดไม่ตรง even
though the group balances. FIRST reproduce this against the actual logic (pure-function extraction
or a small script — no DB needed). If CONFIRMED: make the status component-aware using the SAME
shared component helper as (B) — a component whose Σ payment gross equals Σ RE amounts (satang)
marks ALL member REs `matched`; otherwise member REs are `mismatch` carrying the COMPONENT diff
(add a "กลุ่ม m รายการ/n ใบเสร็จ" hint on multi-member rows). `unpaid` unchanged. Response shape
stays backward-compatible (add fields, don't remove). If NOT confirmed, leave GET /re alone and
say so in the report. Write the component helper ONCE (e.g. `api/src/finance/discrepancy.ts`) and
use it for both (B) and (D).

## API

- `GET /api/juno/discrepancies` → `{ rows, totals, groupHints }`. Row: payment DTO essentials
  (id, dates, customer, source, slipUrl presence, reNumbers, status), `expected`, `expectedSource`
  ('typed' | 're'), `gross`, `diff`, direction, and the disc* resolution fields. Totals over OPEN
  rows: `{ over: {count, sum}, under: {count, sum}, pendingConfirm: count }`. `groupHints` = count
  of mismatched multi-payment components.
- The three mutation routes above.
- Tab badge = open count; extend whatever summary endpoint feeds the existing tab badges
  (follow the awaitingReceive pattern exactly).
- `PATCH /api/juno/payments/:id` (edit-details) must keep ALL `disc*` fields structurally
  unsettable — extend its zod exclusion the same way status/reNumbers/whtRate are excluded.

## UI

- New tab **ยอดเกิน/ขาด** (view key `disc`) for ALL Juno users, badge = open count. New component
  `juno/src/Discrepancies.tsx` following `ReRecon.tsx` conventions (emerald theme, filter chips,
  sticky table headers, mobile-usable per the house review rules).
- Filters: direction ทั้งหมด/เกิน/ขาด × state เปิดอยู่/รอ CEO ยืนยัน/เสร็จสิ้น. Header cards:
  Σเกิน and Σขาด of open rows (+ counts), pending-confirm count, the groupHints chip.
- Row: transfer date, customer/receipt name, RE chips, gross, expected (with typed/RE origin
  mark), signed colored diff (reuse ReRecon's diff color convention), state badge, actions —
  FIN: บันทึกการจัดการ (resolution picker filtered by direction + note); CEO: ยืนยัน / undo.
- Payment drawer (`PaymentDetail`): new "ส่วนต่างยอด" block when the payment has a diff or any
  disc stamps — expected/diff display, set/adjust expected, resolve controls, CEO confirm. Same
  visual weight as the "การรับเงินจริง (ยืนยันโดย CEO)" block.
- ตรวจแล้ว dialog: the optional expected field + live diff preview (uses GROSS = net + WHT — the
  preview must move when the WHT fields change).

## Edge cases

- WHT: covered by the gross rule above (97+3 vs RE 100 → balanced, absent from ledger).
- เครดิต / partial payers: an underpay candidate self-heals when the completing payment lands
  (component becomes multi-payment → drops out per rule B, or balances). `chase` is the interim
  state; this churn is expected and fine.
- Void payments excluded from every computation; hard-delete removes stamps with the row (fields
  live on Payment; PaymentBankMatch cascade unaffected).
- Amount edits via PATCH already detach bank matches; disc fields persist and diff recomputes
  live — no staleness possible for computed values.
- Money handling: String amounts, satang rounding via the existing `num`/`amountsEqual` helpers.
  No floats in comparisons.

## Verification (self-verify before reporting)

1. `api`: repo's typecheck (tsc --noEmit) clean. `juno`: vite build clean.
2. Migration: dirname sorts LAST; `prisma validate` passes; SQL is ADD-only.
3. Logic script (follow the `checkBankParsers.ts` precedent for placement) exercising the shared
   component helper: 1pay↔1RE over/under/equal · 1pay↔2REs balanced (NOT flagged; /re shows
   matched if fix applied) · 2pays↔1RE balanced and unbalanced (ledger skips both, hint counts the
   unbalanced one) · WHT 97+3 vs 100 (balanced) · typed discExpected overriding RE-derived.
4. Grep: no pre-existing `disc*` name collisions on Payment DTOs; edit-details exclusions hold.
5. Report: files changed with line counts, verification output, and any deviation from this brief
   with the reason.

## Executor boundaries

Work ONLY in this worktree on branch `juno-disc`. Commit locally in STAGES so progress survives
interruption: (1) brief + schema + migration, (2) api routes + helper + logic script, (3) juno UI.
Do NOT push. Do NOT touch other apps (vesta/, diana/, pantheon/, ceres/, mercury/, web/) or
existing migrations. No secrets, no .env. Do the work yourself — no sub-agents.
