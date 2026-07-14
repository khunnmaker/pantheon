# Juno — deploy & ops notes

Juno is the **finance app** built INTO the Minerva monorepo. It reads the `Payment` table
that Minerva writes on `/to-finance`, so the finance team works off a real database instead
of the Google Sheet. INCOME / LINE-slip only (see `docs/JUNO_BRIEF.md` for the spec and the
deliberately-out-of-scope list). No accounting-system sync yet.

## Decisions locked with the owner (2026-07-01)

- **Finance login = reuse the `supervisor` role** (like Vesta). Finance logs in as Dr. M.
  No new `finance` role was added — Juno's routes are simply gated to `supervisor`.
- **`amount` stored as free-text `String`** (matches the current OCR/entry flow). Reports
  parse it to a number on read.
- **Google Sheet stays ON as a mirror** — `/to-finance` still posts to it; the `Payment`
  row is written *in addition*. The sheet can be retired later once finance is fully on Juno.
- **Lifecycle:** `received → verified → recorded` (+ `void`). `flagged` is a separate boolean
  (the flag queue), independent of status. Tax invoice: `none → requested → issued`.

## What was built

- **DB** (`api/prisma/schema.prisma` + migration `20260701000000_juno_payment`): adds the new
  **`Payment`** table (with indexes on status / flagged / taxInvoiceStatus / customerCode /
  createdAt). ADDITIVE only — nothing Minerva uses is dropped/renamed. Applied by Minerva's
  api on boot (`prisma migrate deploy`), which stays the single migrator.
- **Minerva hook** (`api/src/routes/messages.ts`, `/to-finance`): after the existing
  send-to-sheet + anti-tamper audit, it now also writes a `Payment` row from the same
  computed values. `flagged` mirrors the amount-mismatch check; `taxInvoiceStatus` derives
  from whether a tax-invoice was requested. Best-effort (a Payment hiccup never blocks the
  slip forward or the LINE reply) but logged loudly on failure — never silent.
- **API** (`api/src/routes/juno.ts`, gated to `supervisor`): `/api/juno/summary`,
  `/payments` (search + filter), `/payments/:id`, `/payments/:id/status`,
  `/payments/:id/flag`, `/payments/:id/tax-invoice`, `/reports` (by day/rep/bank/customer),
  and `/export.csv` (UTF-8 BOM, Excel-friendly).
- **Juno web app** (`juno/`): a separate Vite/React app + Dockerfile — its own Railway web
  service, mirroring Vesta. Login gated to Dr. M (`supervisor`). Tabs: **รายการรับเงิน**
  (inbox + slip verifier drawer + verify workflow), **ตรวจสอบยอด** (flag queue),
  **ใบกำกับภาษี** (tax-invoice queue), **รายงาน** (reports + CSV). Emerald theme (vs Vesta
  indigo). The slip image loads from the public tokenized `slipUrl` (no login needed for the
  image itself — same link the sheet uses).

## Railway

Add ONE new web service for `juno/` alongside the existing `api` / `web` / `diana` / Postgres:

1. **New service → Dockerfile** at `juno/Dockerfile`.
2. Build arg / env **`VITE_API_URL`** = the public URL of the Minerva **api** service (baked
   at build time, same as `web` / `diana` / `vesta`).
3. The api's **`WEB_ORIGIN`** env must include the Juno web origin (comma-separated with the
   existing console / Vesta / Diana origins) so CORS allows the browser calls. For local
   docker-compose the api's WEB_ORIGIN must likewise include http://localhost:5176 (the compose
   default now does).
4. Juno shares the same Postgres via the api — it does **not** need its own `DATABASE_URL`
   and must **not** run `prisma migrate deploy` (Minerva's api remains the only migrator).
5. Push to `main` → all services redeploy; the migration applies via the api.

## Verify after deploy

1. Forward a real payment slip from the Minerva console (`/to-finance` as today). Confirm:
   - the Google Sheet still receives its row (mirror unaffected), AND
   - a `Payment` row appears in Juno's **รายการรับเงิน** inbox.
2. If the staff-entered amount differs from the OCR amount, the row shows the ⚠ mismatch and
   lands in **ตรวจสอบยอด** (flag queue) — same signal as the old `FinanceAudit`.
3. Click a row → the slip image renders beside the parsed fields; advance
   `received → verified → recorded`; the who/when stamps (`verifiedById`/`verifiedAt`).
4. A tax-invoice request appears in **ใบกำกับภาษี**; mark it `issued`.
5. **รายงาน** totals + **CSV** export match the inbox.

## Notes

- **Not tested against a live DB from the build session** (Docker/Postgres weren't running
  locally). Verified: Prisma schema validates, api typechecks against the generated client,
  and the Juno frontend builds. The migration SQL matches Prisma's generated style and is
  additive; step 1 above is the real end-to-end check to run once on Railway.
- The old `FinanceAudit` table is left as-is (harmless). `Payment.flagged` + `ocrAmount`/
  `amount` supersede it functionally, but it was intentionally NOT removed in this change.
- Roles: finance = `supervisor` for v1. If finance later needs its own login set separate
  from the sales supervisor, that's a follow-up (add `finance`/`finance_supervisor` to the
  shared auth — `jwt.ts` Role union, `middleware.ts`, `ensureSeeded.ts` STAFF list).
