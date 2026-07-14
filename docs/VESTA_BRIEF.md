> Renamed 2026-07-12: this app is now **Vesta** (deity swap; "Vulcan" is reserved for the future KPKF manufacturing app).

# Vesta — Stock Management (build brief)

> Hand this file to a fresh session. It is self-contained: it assumes **no** memory of the
> Minerva chat it was written in. Vesta is a NEW project that plugs into the existing
> **Minerva** system (a LINE customer-reply assistant for **Prominent**, a Thai dental-equipment
> distributor). Build Vesta in the **same monorepo** as Minerva.

---

## 1. Mission

Vesta is a **stock-management tool** for Prominent's product catalog. The warehouse/stock
**manager exports a stock CSV from Express (their Thai accounting program) once a day and
imports it into Vesta.** Vesta stores the current quantity per SKU, lets staff adjust it by
hand for corrections, and flags low-stock items. Because Vesta **shares Minerva's database**,
Minerva automatically shows the up-to-date remaining stock to the sales team and the AI — no
extra sync needed.

---

## 2. Decisions already made (build to these — do not re-litigate)

1. **Stock source = daily Express CSV.** The manager exports a stock report from **Express**
   and imports the CSV into Vesta every day. Express is the upstream master; Vesta is the
   working copy + UI. **Manual adjustments** are allowed for corrections between imports.
2. **v1 scope (only these):**
   - Daily **Express CSV import** (upload → preview → apply).
   - **Stock levels per SKU + manual adjust.**
   - **Low-stock alerts** (a reorder point per SKU + a low-stock list/flag).
   - **OUT of v1:** full stock movements/in-out ledger, purchase orders. (Design so they can be
     added later, but don't build them now.)
3. **Minerva connection = SHARED DATABASE.** Vesta writes stock into the **same Postgres**
   Minerva reads. Specifically it updates `Product.stock` + `Product.stockAt` (fields that
   already exist and that Minerva already reads). Real-time; no API or sync job required.
4. **Stack & layout = reuse Minerva's stack, SAME repo (monorepo), shared DB + one Prisma
   schema.** Node + TypeScript + Fastify + Prisma + PostgreSQL backend; Vite + React + Tailwind
   frontend; deploy on Railway.

---

## 3. Minerva context you need

- **Repo:** `C:\Users\khunn\Project\Minerva` (monorepo) — `github.com/khunnmaker/minerva`.
  Vesta lives in THIS repo. Default branch `main` auto-deploys to Railway on push.
- **Stack:** `/api` = Node + TS + Fastify + Prisma + PostgreSQL. `/web` = Vite + React +
  Tailwind + Socket.IO. The Dockerfile runs `prisma migrate deploy` on boot. Live in production.
- **The `Product` model** (`api/prisma/schema.prisma`) — already exists, ~1187 rows, ~1020 with
  stock today (loaded ad-hoc from a periodic stock report — **Vesta replaces that import path**):
  ```prisma
  model Product {
    sku       String    @id          // PRIMARY KEY, e.g. "07-10-09" (same codes as Express)
    nameEn    String    @default("")
    nameTh    String    @default("")
    price     Int       @default(0)  // baht; 0 = unknown
    promo     String    @default("")
    note      String    @default("")
    page      Int?
    photoSku  String?
    keywords  String[]
    status    String    @default("active") // active | archived
    stock     Int?      // remaining qty from latest snapshot (null = unknown)  ← Vesta writes this
    stockAt   DateTime? // date the stock figure is as-of                       ← Vesta writes this
    updatedAt DateTime  @updatedAt
  }
  ```
- **SKU scheme:** codes like `01-01-01` / `07-10-09`. This is the shared key between Express,
  Minerva, and Vesta. Match strictly on `Product.sku`.
- **Minerva ALREADY reads stock.** It shows the exact count + `stockAt` date in the console and
  lets the AI state availability broadly (in/low/out) — never the exact number to the customer.
  **So once Vesta keeps `Product.stock`/`stockAt` fresh, Minerva needs little-to-no change.**
- **Auth (reuse it):** JWT + bcrypt; roles `agent | supervisor`; staff reconciled on every boot
  from env passwords (`SEED_PASSWORD` = admin "Dr. M" / supervisor; `STAFF_PASSWORD` = shared
  team / agents). See `api/src/db/ensureSeeded.ts`. `requireAuth` re-validates the token against
  the live DB row each request.
- **Railway:** services for `api`, `web`, and a Postgres. Secrets (`DATABASE_URL`, `JWT_SECRET`,
  etc.) live ONLY in Railway env — never commit them.

---

## 4. Architecture

- **One Prisma schema, one database.** Add Vesta's tables/fields to the EXISTING
  `api/prisma/schema.prisma`. Do **not** create a second Prisma schema pointing at the same DB
  (migrations would fight). Minerva's `prisma migrate deploy` (on the api service) stays the
  single migrator.
- **Vesta writes `Product.stock` + `Product.stockAt`** on import / manual adjust. That IS the
  Minerva integration — Minerva reads those same rows.
- **Backend:** two reasonable options — pick one and note it:
  - (A) Add Vesta routes to the EXISTING `/api` (e.g. `/api/stock/*`, `/api/stock/import`).
    Least work; shares the Prisma client, auth, and Railway service. **Recommended for v1.**
  - (B) A separate Vesta api service in the monorepo sharing the same `DATABASE_URL`. Cleaner
    separation, more infra to wire (auth, prisma client, a second migrator to avoid).
- **Frontend:** a dedicated Vesta UI for the stock manager — either a new Railway web service
  or a separate route-area/app in the monorepo. A separate, simple Vesta web app is clean; or
  reuse the existing console shell and gate a "สต็อก / Stock" view to the manager. Pick one.
- **Migrations caution:** a Vesta migration touches Minerva's live DB. Only **ADD** columns/
  tables; never drop/rename `Product.stock`, `Product.stockAt`, or anything Minerva uses. Test
  on a copy first if possible.

---

## 5. Schema additions (to `api/prisma/schema.prisma`)

```prisma
// add to Product:
//   reorderPoint Int?   // low-stock threshold; low = stock != null && stock <= reorderPoint

model StockImport {        // audit of each daily Express CSV import
  id           String   @id @default(cuid())
  importedAt   DateTime @default(now())
  importedBy   String?              // agent id
  fileName     String   @default("")
  rowsParsed   Int      @default(0)
  skusUpdated  Int      @default(0)
  skusUnmatched Int     @default(0) // CSV SKUs not in the catalog
  note         String   @default("")
}

model StockAdjustment {    // audit of manual edits (mirrors Minerva's FinanceAudit pattern)
  id        String   @id @default(cuid())
  sku       String
  fromQty   Int?
  toQty     Int?
  reason    String   @default("")
  byAgentId String?
  at        DateTime @default(now())
  @@index([sku])
}
```
Keep movements/ledger OUT of v1, but this audit pair gives accountability cheaply.

---

## 6. Feature: daily Express CSV import (the core)

Flow: manager uploads the CSV in Vesta → **preview** (matched / unmatched / will-change) →
**apply** → write `Product.stock = qty`, `Product.stockAt = <import time>` for each matched SKU,
and log a `StockImport` row. Show a summary (updated N, unmatched M).

**You must get a REAL sample CSV from the manager before coding the parser** — these are unknown
and they matter:
- **Columns / headers** (SKU/รหัสสินค้า, name, on-hand qty/คงเหลือ, maybe unit/location/cost).
- **Encoding.** Express is Thai software — the CSV may be **TIS-620 / Windows-874**, not UTF-8.
  Detect/convert or you'll get mojibake in Thai names.
- **Snapshot semantics (important):** is the daily CSV a FULL snapshot of all SKUs, or only
  changed/stocked ones? Decide what an **absent SKU** means — leave unchanged, or set to 0?
  (Recommend: confirm with the manager; default to "leave unchanged unless present" and flag it.)
- **Unmatched SKUs** (in CSV, not in `Product`): report them, don't crash; never auto-create
  catalog rows from the stock file without a decision.

---

## 7. Feature: stock list + manual adjust

- A searchable list of products with current `stock`, `stockAt`, `reorderPoint`, low-stock flag.
- Edit a SKU's stock with a **reason** → write `Product.stock` + log a `StockAdjustment`.
- Reuse Minerva's catalog search style (search by name or SKU).

## 8. Feature: low-stock alerts

- `Product.reorderPoint` per SKU (editable; maybe a sensible default or bulk-set).
- "Low stock" view = SKUs where `stock != null && stock <= reorderPoint`. Show a count badge.
- Optional: surface the low-stock count to the manager on login.

---

## 9. Minerva side (minimal)

The basic goal ("Minerva shows remaining stock") already works via the shared `Product.stock`.
Optional niceties (do only if asked): show a low-stock style in Minerva's product cards using
`reorderPoint`, or a freshness hint from `stockAt`. **Keep Minerva's guardrail intact:** the AI
states availability broadly; the console shows the exact count + date. Don't expose exact counts
to customers.

---

## 10. Auth / who uses Vesta

The **stock manager** (and supervisors) use Vesta. Reuse Minerva's JWT login. **CONFIRM with
the user:** does the manager use the existing `supervisor` account (Dr. M), or should there be a
separate **manager/stock** role/login? Recommend: reuse the existing login and gate Vesta to
`supervisor` for v1; add a dedicated role only if the manager must be separate from Dr. M.

---

## 11. Deploy

- Railway, same as Minerva. If Vesta is separate services, point them at the **same**
  `DATABASE_URL` (the shared Postgres). Ensure **only one** service runs `prisma migrate deploy`
  (keep Minerva's api as the migrator) to avoid migration races. Push to `main` to deploy.

---

## 12. First steps for the new session

1. Read this file and `api/prisma/schema.prisma` (the `Product` model) + `api/src/db/ensureSeeded.ts` (auth).
2. **Ask the user for a real sample Express stock CSV** + confirm: columns, encoding, full-snapshot
   semantics (absent SKU = ?), and who logs into Vesta.
3. Add the schema fields/tables (§5); migrate.
4. Build the CSV import (§6): upload → preview → apply → write `Product.stock`/`stockAt` → log.
5. Build the stock list + manual adjust (§7) and reorder points + low-stock view (§8).
6. Verify Minerva shows the updated stock (it reads the same rows). Deploy.

## 13. Cautions

- **Shared DB:** ADD only; never drop/rename Minerva's columns. One Prisma schema, one migrator.
- Don't break Minerva's existing stock reads (`Product.stock`, `Product.stockAt`).
- Secrets only in Railway env, never committed.
- Match SKUs strictly; report mismatches rather than guessing.

---

## 14. Open questions to confirm with the user early

1. A **sample Express stock CSV** (columns, encoding, full snapshot vs deltas, absent-SKU meaning).
2. Who logs into Vesta (reuse supervisor, or a separate manager role)?
3. Separate Vesta web/api services vs a stock view inside the existing console — preference?
4. Should Minerva's UI also show low-stock styling, or leave Minerva untouched for now?
