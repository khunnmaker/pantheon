# Venus — deploy & ops runbook (owner, no-code)

Venus is the **CRM deity** built INTO the Minerva monorepo (`venus/` frontend + `api/src/routes/venus.ts`
+ `api/src/venus/*`). It reads the shared Postgres: the Express **customer master** (ARMAST) and
**sales orders** (OESOC) you import, plus Juno payments and Minerva's cross-sell data. It computes
RFM/segments/trend/reorder-cycles/cross-sell-gaps/big-ticket signals nightly, shows a management
dashboard + a 360° rep card, and writes one short Thai AI suggestion per flagged customer. It is
**track-and-tell only** — it never messages customers or changes anything in Express. See
`docs/VENUS_BRIEF.md` for the spec.

> 🔒 **CONFIDENTIAL — SUPERVISOR-ONLY.** Venus is private to you (Dr. M) right now. Access is
> per-grant and **nobody but the supervisor is granted** — so the login only ever shows your card and
> no other staff can enter. **Do not grant any employee the `venus` app** until you decide to open it up.

This runbook is **no-code**. Do the steps in order.

---

## What was built (on branch `venus`, not yet merged)

- **API** (`api/src/routes/venus.ts` + `api/src/venus/*`): customer + sales import (preview→apply,
  supervisor-only), the RFM/trend/reorder/cross-sell/big-ticket **engine** (`stats.ts`), the weekly
  **AI card** generator (`cards.ts`, fail-soft), the dashboard + enriched customer endpoints, and the
  pinned-note write. Auth: reads are behind `requireApp('venus')` (supervisor always; md excluded;
  employees only with the grant); imports/recompute are supervisor-only.
- **Six additive migrations** (Minerva's api is the sole migrator; all ADD-only, no existing table touched):
  `20260704120000_venus_customer_master`, `20260706120000_venus_sales_import`,
  `20260706130000_venus_saleline_name`, `20260708000000_venus_note`, `20260709000000_venus_card`,
  `20260710000000_venus_signals`.
- **Web app** (`venus/`): a separate Vite/React app + Dockerfile — its own Railway service, mirroring
  Juno/Vesta/Jupiter. Rose theme. Suite-standard card-list login (only your card shows).

---

## 1. Merge `venus` → `main`

Everything ships from `main` (Railway auto-deploys it). Open a PR from `venus` → `main` and merge it.
On merge, the **api** service redeploys and runs `prisma migrate deploy`, applying the six additive
migrations to the production database, and the `venus/` app becomes buildable as a service.

**After the api redeploys, confirm the migrations applied:** check the api deploy logs for the six
migration names above ending in "successfully applied" (or "No pending migrations" on a later deploy).
Because every migration is additive (new tables + new nullable columns), this is safe for the live DB.

## 2. New Railway service for `venus/`

Add ONE new web service alongside the existing `api` / `web` / `vesta` / `juno` / `ceres` / `jupiter`
/ Postgres:

1. **New service → Deploy from repo → root directory `venus/`** (Dockerfile at `venus/Dockerfile`; it
   builds the static bundle and serves it on Railway's `PORT`).
2. Set this **build-time env var / build arg** (baked into the bundle at build — same model as
   juno/vesta/jupiter):

   | Var | Value | Meaning |
   |---|---|---|
   | `VITE_API_URL` | the **api** service's public URL | login + all Venus data calls |
   | `VITE_PORTAL_URL` *(optional)* | the **jupiter** service's URL | shows a "พอร์ทัล" back-link; leave unset to hide |

3. Venus shares the same Postgres **via the api** — it does **not** need its own `DATABASE_URL` and
   must **not** run any Prisma migrate.

## 3. Allow Venus's origin on the api (CORS)

**Append** the new Venus web origin to the api's **`WEB_ORIGIN`** env (comma-separated, exact origin,
no trailing slash), keeping every existing origin (console / Vesta / Juno / Ceres / Jupiter). Without
this, the browser's login + data calls fail CORS.

## 4. Confirm the Anthropic key is on the api (for AI cards)

The AI suggestion cards call Claude via the api's existing `ANTHROPIC_API_KEY` (the same one Minerva
uses). Confirm it's set on the **api** service. If it's ever unset, Venus **fail-softs** — the rule
badges still show; only the AI narration sentence is skipped. No crash either way.

## 5. Load the data (you, in the Venus UI — supervisor)

1. Log in to Venus as **Dr. M**.
2. **นำเข้าข้อมูลลูกค้า** → upload the Express **ARMAST.TXT** (customer master) → preview → apply.
   (~10,500 customers.)
3. **นำเข้าข้อมูลการขาย** → upload the Express **OESOC.TXT** (sales orders *grouped by customer* —
   the one with the `/code`) → preview → apply. (Re-importing a newer/wider export later is safe —
   it upserts by document number.)
   > For a longer history (RFM is more honest with ≥1 year), re-export OESOC with an earlier start
   > date and re-import; nothing else changes.
4. **Recompute** the engine once after the import (the recompute button / `POST /api/venus/recompute`,
   supervisor-only) so segments/signals populate.

## 6. Schedule the nightly + weekly jobs

Two background jobs keep Venus fresh (run them where the api's `DATABASE_URL` is available — e.g. a
small Railway cron, or the suite scheduler):

| Job | Command | Cadence |
|---|---|---|
| Recompute stats (RFM/trend/reorder/signals) | `npx tsx api/src/scripts/venus-recompute-stats.ts` | nightly |
| Generate AI suggestion cards | `npx tsx api/src/scripts/venus-generate-cards.ts` | weekly |

Until scheduled, run recompute manually after each import (step 5.4); cards can be generated on demand
the same way. (A future small code change can wire these into an in-process scheduler.)

## 7. Smoke test

1. Open the Venus URL → the login shows **only your card** (Dr. M). Confirm no other staff card appears.
2. Log in → **แดชบอร์ด** shows the segment distribution, the เสี่ยงหาย at-risk list (by ฿), top movers,
   and the reorder-opportunity queue, with the data-coverage window banner.
3. **รายชื่อลูกค้า** → search a customer → the card shows RFM tiles, trend, purchase timeline with real
   product names, reorder-due badges, the precaution flags, and — once cards have been generated — the
   AI suggestion under "คำแนะนำจาก AI (ตรวจสอบก่อนใช้)".
4. Confirm no CORS errors in the browser console.

---

## Deferred (NOT in this runbook — later, separate work)

- **Complaint-tagging** (the 4th precaution, เคยมีปัญหา): an AI pass over LINE chat history → clickable
  complaint evidence. It reads customer chats, so it ships with its own review round for false positives.
- **The pinned note in the Minerva console header**: a small console touch to show Venus's ข้อควรระวัง
  note where reps already work.
- **AI-card adversarial review**: once real card generations exist on the live key, review a sample for
  the restate-only guardrail (the AI must never invent a number/price/product).

## Ongoing ops

- **Refresh data** periodically: re-export ARMAST (customers) + OESOC (sales) from Express and re-import
  (both upsert safely); re-run recompute. A wider OESOC date range deepens the RFM.
- **Opening it up later**: if you decide to let reps in, grant them the `venus` app (via Jupiter's admin
  UI for their live account, and add `venus` to their seed roster so their card appears on the login).
  Until then it stays yours alone.
