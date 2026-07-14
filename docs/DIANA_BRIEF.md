# Diana — Prominent B2B Website (build brief)

> Handoff for a fresh session. Built from **Channa's brief** (a guideline, not gospel) + what we
> now know from Prominent's existing **Minerva** and **Vesta** systems. Diana =
> **prominentdental.com**, a B2B e-commerce site for dental clinics & labs.
> **DO NOT start building** until the Open Decisions (§6) are resolved with the human (Mike / คุณไม้).

---

## 0. TL;DR — what changed since Channa wrote the brief

Channa's brief had three big unknowns that are now answered:

1. **The "LINE AI ordering system" Channa mentions IS Minerva** — it already exists and is **live**
   (Node/TS/Fastify + PostgreSQL/pgvector + React console). Not a future thing to coordinate with — it's here.
2. **Vesta is built and live.** Channa's **Open Decision #1 ("does Vesta have an API / how to sync
   stock — the whole architecture depends on it")** is **essentially RESOLVED:** Vesta shares a
   PostgreSQL database with Minerva, keeps `Product.stock` fresh daily (from the Express stock
   report), and exposes a stock API. Live, real-time stock is available to Diana. **Stock drift is
   avoidable.**
3. **A single source of truth for catalog + price + stock already exists** — one Postgres `Product`
   table that Minerva and Vesta both use. Channa's SSOT guardrail (§8 "avoid two catalogs") is
   already realized; Diana just needs to **read** that source instead of creating a 4th catalog.

This unblocks the architecture and adds a platform option Channa didn't have (custom-in-the-stack — §5).

---

## 1. Business context (from Channa, condensed)
- **Prominent** — dental distribution (BEGO implants, CADstar scanners, own-made Dentory fluoride
  gel, general consumables). **B2B only:** dental **clinics** and small **labs**; repeat buyers
  reordering consumables. Not consumers.
- **Current site:** `https://www.prominent-dental.com/` (hyphenated). **New domain:**
  `prominentdental.com` (no hyphen), already bought on GoDaddy. Old domain **301-redirects** to new
  at cutover (don't run two live sites — SEO split).
- **Tools:** **Express** (Thai accounting; file import/export, no live API), **LINE OA** (primary
  comms), plus the custom stack below.

## 2. Goal
Public catalog (names, photos, specs, brands — for SEO/discovery/credibility), **prices + ordering
hidden behind login** (protects the pricelist — deliberate strategy). Flow: clinic/lab **registers →
Prominent approves → logs in → sees prices → orders.**

---

## 3. The existing Prominent tech ecosystem (what Diana plugs into)

> This is the context Channa couldn't specify. It's now concrete.

- **Minerva** (LIVE) — LINE AI customer-reply/ordering assistant. Node + TS + Fastify + Prisma +
  **PostgreSQL (pgvector)** + React/Vite/Tailwind, on **Railway**. Repo:
  `C:\Users\khunn\Project\Minerva` / `github.com/khunnmaker/minerva`.
  - Holds the **product catalog** (~1187 products) in a Postgres **`Product`** table keyed by
    **`sku`** (e.g. `"07-10-09"`): `nameEn`, `nameTh` (catalog is already **bilingual**),
    `price` (baht; 0 = unknown), `promo`, `note`, `photoSku`, `keywords`, `status`, `stock`,
    `stockAt`, `reorderPoint`.
  - **Product photos are served by SKU**: `GET /content/product/:sku` returns the image. Diana can
    reuse these.
  - **SKU display/typing convention (follow this in Diana):** the stored `sku` key keeps its dashes
    (`"07-10-09"`) — it's the SSOT key shared with Express/Minerva/Vesta, **do not change it**. But
    everywhere a code is **shown to or typed by a user**, present it **bare** (`071009`): display via
    `sku.replace(/-/g,'')`, and make any SKU search **dash-insensitive** (compare against
    `replace(sku,'-','')` so `071009`, `07-10-09`, and partials all match). Minerva + Vesta already
    do this; mirror it so codes read/type the same across all three apps.
  - Auth: JWT + bcrypt; roles `agent | supervisor`.
  - Has a **finance / payment flow** with **tax-invoice (ใบกำกับภาษี) capture** (name/address/tax-ID)
    that forwards to a finance sheet — relevant to Channa's Express/tax-invoice handoff (#7); reusable patterns.
- **Vesta** (LIVE, same monorepo + same DB) — stock manager. The stock manager imports Express's
  **"รายงานสินค้าคงเหลือ"** report (a `.txt`, Windows-874/TIS-620) daily → writes `Product.stock` +
  `Product.stockAt`; supports manual adjust + low-stock (`reorderPoint`). Supervisor-gated stock API
  at `/api/stock/*` (summary/list/adjust/reorder-point/import-preview/import-apply). So **stock is
  already fresh + live in the shared Postgres, every day.**
- **Single source of truth (already true):** product name/price/photo + stock all live in ONE shared
  Postgres `Product` table. **Diana should read from this** (DB or an API), not duplicate it.
- **Express** — accounting; import/export files only, no live API (matches Channa).

---

## 4. Decisions already made (from Channa — keep)
- ✅ B2B, **login-gated pricing** (protect the pricelist).
- ✅ **Public catalog / private prices + ordering** (hybrid; a fully-locked site is invisible to Google).
- ✅ Old hyphenated domain **301-redirects** to the new one (at cutover).
- ⏳ **Platform NOT confirmed** — Shopify was Channa's lean, but see §5 (the existing stack adds a 3rd option).

---

## 5. The platform decision — now a 3-way fork (resolve FIRST with Mike)

Channa framed it as Shopify vs WooCommerce and flagged the make-or-break detail: **login-gated B2B
pricing is NOT native on standard Shopify** (it's a Shopify **Plus** feature, or needs a third-party
wholesale/lock app). That's still true. But because a **custom catalog/stock/price single-source-of-
truth already exists** (Minerva + Vesta on shared Postgres), there's a third option:

- **(A) SaaS platform** — standard **Shopify + a B2B/wholesale-lock app**, or **WooCommerce**.
  Pros: off-the-shelf, low e-commerce maintenance, native payments/SEO, staff-friendly.
  Con: the platform has its **own** product DB, so you must **SYNC** catalog + price + stock from the
  shared Postgres into it (scheduled or via API) — re-introducing the **two-sources-of-truth / stock-
  drift** risk Channa warns against, plus app/Plus cost for gated pricing.
- **(B) Custom Diana in Prominent's stack** — Node/Fastify/Prisma/React reading the **shared Postgres
  `Product` table directly**. Pros: **one source of truth, live price/stock, no sync layer, native
  login-gated pricing** (it's your code), reuses the existing catalog + photos + the team's stack +
  Railway. Con: you build the storefront/cart/accounts (more code than SaaS), no built-in payments/SEO toolkit.
- **(C) Hybrid** — SaaS for the public SEO catalog, custom login-gated order-request reading the shared
  DB. Most moving parts.

**Lean to present to Mike (confirm, don't assume):** since the SSOT for catalog/stock/price already
lives in the shared Postgres and the team already operates this exact stack, **(B) custom — or at
minimum a platform that can read the shared source without duplicating it — best satisfies Channa's
own SSOT + stock-accuracy guardrails.** Weigh against: who maintains it (non-technical → SaaS leans
heavier), the payment model (§6.2), and tiered pricing (§6.4). The decision is now mostly
**maintenance appetite + payments + pricing model**, NOT the stock-integration unknown (that's solved).

---

## 6. Open Decisions to resolve with Mike (BEFORE building)

1. ✅ **Vesta / stock integration — RESOLVED.** Shared Postgres + daily-fresh `Product.stock` + a
   stock API. Confirm only Diana's *read path* once the platform is chosen (direct DB read if custom;
   a sync job if SaaS).
2. **Payment model:** (a) **order-request / invoice-after** — customer submits a cart, Prominent
   confirms price + invoices (matches B2B credit terms + the current LINE workflow; **recommended v1**),
   vs (b) **pay online** (PromptPay / card — gateway, fees, refunds, tax-receipt automation; **phase 2**).
3. **Customer approval:** open registration + manual approval (recommended) vs pre-created accounts.
   Note: Minerva already tracks customers (by LINE id, with an **Express customer code like `ร103`**) —
   decide whether a Diana web account links to a Minerva/Express customer or is separate (likely
   separate for v1, reconcile later).
4. **Pricing structure:** one price per approved customer vs **tiered** per customer/group. The catalog
   has **one `price` per SKU** today — tiered pricing is a NEW layer (and pushes SaaS toward Shopify Plus).
5. **SKU count:** ~**1187 products** already in the catalog (with Thai+English names + photos).
6. **Who maintains it post-launch:** Mike / staff / agency → the biggest input to A-vs-B.
7. **Express handoff:** order → **tax invoice (ใบกำกับภาษี)** → import into Express (no live API).
   Minerva's finance flow already captures tax-invoice details — reuse the pattern.
8. **Bilingual:** Thai + English — catalog data already has both (`nameEn` / `nameTh`).

---

## 7. Compliance & must-haves (Thailand) — from Channa
- **PDPA:** consent + privacy policy + proper handling of clinic/customer data.
- **Tax invoice (ใบกำกับภาษี):** sales need proper docs flowing to Express.
- **SSL/HTTPS**, secure accounts.

## 8. Suggested build sequence (after decisions)
1. Confirm Diana's **read path to the shared catalog/stock** (DB vs API) — gated by the platform choice (§5), not by Vesta anymore.
2. **Lock the platform** (run §5 with the payment + pricing + maintainer answers).
3. **Domain + hosting + SSL**; prepare the **301 redirect** from `prominent-dental.com` (apply at cutover, not before).
4. **Catalog:** read the shared `Product` table (name/price/photo/stock) — don't create a 4th catalog. Reuse SKU-served photos.
5. **Accounts + approval + login-gated pricing** (the core B2B mechanic).
6. **Ordering flow** — order-request first (per §6.2).
7. **Live stock** from the shared DB / Vesta (already fresh daily).
8. **Order → Express handoff** + tax invoice (reuse Minerva's finance/tax-invoice pattern).
9. **PDPA pages**, terms.
10. **Test with a few real clinic/lab accounts** before launch.
11. **Cutover:** launch + apply the 301 redirect.
12. **Later:** unify Diana web orders + Minerva LINE orders into one order/Express pipeline (single source of truth).

## 9. Relationship map — Diana ↔ Minerva ↔ Vesta
- **Catalog + price + photos:** the shared Postgres `Product` table (Minerva-owned, Vesta-updated). Diana **reads** it. Photos via `/content/product/:sku`.
- **Stock:** Vesta keeps `Product.stock`/`stockAt` fresh daily; Diana shows it live.
- **Customers:** Minerva = LINE customers (Express code `ร103`); Diana = clinic web logins. Likely separate identities in v1; reconcile (same clinic, two channels) later.
- **Orders:** v1 keep Diana (web) and Minerva (LINE) order paths separate; converge them + the Express handoff in a later phase.
- **SSOT rule:** product/price/stock = the shared Postgres. Diana joins as a 3rd reader. **Do not maintain a second catalog.**

## 10. First task for the new session (per Channa, updated)
**Do NOT build yet.** First:
1. Walk Mike through the **platform fork (§5)** — emphasize that the stock-integration blocker is gone
   (Vesta/shared DB exists), so the choice is now maintenance appetite + payments + pricing model.
2. Resolve **payment model (#2)** and **pricing structure (#4)**.
3. If **custom (B):** decide repo layout — same monorepo as Minerva/Vesta (share the `Product` table
   directly) or a sibling app reading the same DB/API. If **SaaS (A):** design the catalog/price/stock
   **sync** from the shared Postgres (and pick the gated-pricing mechanism — Plus vs lock app).
4. Then produce a **platform + architecture recommendation**, and only then build milestone by milestone.

## 11. Guardrails
- **Never expose prices publicly** — catalog public, prices + cart behind login + approval only.
- **One source of truth** for product/price/stock = the shared Postgres `Product` (Minerva/Vesta). Diana reads it; don't fork a new catalog.
- If Diana shares the DB: **ADD only**, never alter Minerva/Vesta columns; keep one migrator. Secrets in env only, never committed.
- **Favor low maintenance**; start lean — a working **login-gated catalog + order-request** flow is a valid v1. Online payment + deep integrations are phases 2–3.
```
Reference docs in this repo: docs/VESTA_BRIEF.md, docs/VESTA_DEPLOY.md, and api/prisma/schema.prisma (the Product model).
```
