# Vulcan — deploy & ops notes

Vulcan is stock management built INTO the Minerva monorepo. It writes `Product.stock`,
`Product.stockAt`, and `Product.reorderPoint` — the same rows Minerva reads — so there is
no sync job. See `docs/VULCAN_BRIEF.md` for the spec.

## What was built

- **DB** (`api/prisma/schema.prisma` + migration `20260629000000_vulcan_stock`): adds
  `Product.reorderPoint` and the `StockImport` / `StockAdjustment` audit tables. ADDITIVE
  only — nothing Minerva uses is dropped/renamed. Applied by Minerva's api on boot
  (`prisma migrate deploy`), which stays the single migrator.
- **API** (`api/src/routes/stock.ts`, gated to `supervisor`): `/api/stock/summary`,
  `/list`, `/adjust`, `/reorder-point`, `/imports`, `/adjustments`, `/import/preview`,
  `/import/apply`. Parser: `api/src/stock/parseExpressReport.ts`.
- **Vulcan web app** (`vulcan/`): a separate Vite/React app + Dockerfile — its own Railway
  web service. Login is gated to Dr. M (`supervisor`).
- **Minerva web** (`web/`): product cards now show reorderPoint-driven low-stock styling +
  a `stockAt` freshness hint (staff-only; customers never see exact counts).

## Express stock report format (the import source)

The daily upload is **not a CSV** — it's the Express "รายงานสินค้าคงเหลือ" **print report
exported as `.txt`**, encoded **Windows-874 / TIS-620** (Thai). The parser decodes it with
`iconv-lite` and extracts qty by the `value = qty × cost` arithmetic invariant (robust to
mojibake; numbers stay ASCII). The report header is a **full snapshot**
(`สินค้าจาก 01-00-01 ถึง 99-99-99`). Snapshot semantics: **a SKU absent from the file is
left unchanged** — Vulcan never auto-zeros and never auto-creates catalog rows from the
stock file (unmatched SKUs are reported in the preview and skipped).

## Railway

Add ONE new web service for `vulcan/` alongside the existing `api` / `web` / Postgres:

1. **New service → Dockerfile** at `vulcan/Dockerfile`.
2. Build arg / env **`VITE_API_URL`** = the public URL of the Minerva **api** service
   (baked at build time, same as `web`).
3. The api's **`WEB_ORIGIN`** env must include the Vulcan web origin (comma-separated with
   the existing console origin) so CORS allows the browser calls.
4. Vulcan shares the same Postgres via the api — it does **not** need its own `DATABASE_URL`
   and must **not** run `prisma migrate deploy` (Minerva's api remains the only migrator).
5. Push to `main` → all services redeploy; the migration applies via the api.

## Daily use

Manager logs into Vulcan (Dr. M) → **นำเข้า CSV** → upload the Express `.txt` → review the
preview (matched / will-change / unmatched + detected encoding) → **ยืนยันนำเข้า**. Stock is
live to Minerva immediately. Manual corrections + reorder points are on the **สต็อก** tab;
audit trails on **ประวัติ**.
