# Diana — deploy guide (Railway)

Diana is **prominentdental.com**: a public company website + login-gated B2B catalog.
Its API routes live inside the shared **Minerva `api`** service; the frontend is a new
static service (`diana/`). Product photos are served by the existing api at
`/content/product/:sku`, so once Diana points at the production api, photos appear.

> ⚠️ Deploying redeploys the live `api` service, which applies Diana's **additive**
> migrations to the shared production database. New tables only — `ClinicAccount`,
> `WebOrder`, `WebOrderLine`, `ProductEnrichment`. Nothing alters Minerva/Vulcan
> columns and no existing data is touched. Still, it is a production change — do it
> deliberately.

## What's already done
- Branch `diana-b2b-website` committed (api routes/models/migrations + the `diana/` app).
- `docker-compose.yml` has a `diana` service for local parity.

## Step 1 — Merge to `main` (triggers the api redeploy)
Railway auto-builds `main`. Merging applies the Diana migrations to prod via the api
Dockerfile's `npx prisma migrate deploy` on boot.

```
git checkout main
git merge --no-ff diana-b2b-website
git push origin main
```

Watch the `api` deploy logs. Expect:
`Applying migration 20260630000000_diana_b2b` and `…_diana_product_enrichment`,
then "All migrations have been successfully applied." (The catalog is NOT reseeded —
`ensureCatalog` only seeds an empty table.)

Then, once, populate the brand/category facets on prod (one-off):
```
# from a shell with prod DATABASE_URL, inside api/
npx tsx src/scripts/deriveEnrichment.ts
```
(Or run it via a Railway one-off command / `railway run`.)

## Step 2 — Create the Diana web service on Railway
In the Railway project (same repo):
1. **New → GitHub repo → this repo**, then set the service **Root Directory** to `diana`.
   Railway will use `diana/Dockerfile`.
2. Add a service **variable**: `VITE_API_URL = https://<your-api-service>.up.railway.app`
   (the public domain of the Minerva `api` service). This is baked into the bundle at
   build time and is what makes catalog data **and photos** load.
3. **Generate Domain** for the Diana service (e.g. `diana-xxxx.up.railway.app`).
   Use this to test before the real domain.

## Step 3 — Allow Diana's origin on the api (CORS)
On the **api** service, set `WEB_ORIGIN` to a comma-separated list that includes Diana's
domain (the api already splits on commas):
```
WEB_ORIGIN = https://<minerva-console-domain>,https://diana-xxxx.up.railway.app
```
Redeploy/restart api to pick it up. (Without this, the browser blocks Diana's API calls.)

## Step 4 — Verify on the Railway URL
- Open `https://diana-xxxx.up.railway.app` — catalog loads with **photos**, TH/EN toggle works.
- `…/#admin` → sign in with an existing supervisor (e.g. `drm@prominent.local`) → the
  clinic-approval + order queue tabs.
- Register a test clinic → approve it in `#admin` → sign in as the clinic → prices unlock.

## Step 5 — Custom domain (at cutover)
1. Point **prominentdental.com** at the Diana service (Railway → Domains → add custom domain;
   set the CNAME/A record at GoDaddy).
2. Add `https://prominentdental.com` to the api `WEB_ORIGIN`.
3. Rebuild Diana if `VITE_API_URL` changes.
4. **301** the old `prominent-dental.com` → `prominentdental.com` (do this only at cutover
   to avoid splitting SEO before the new site is ready).

## Rollback
- The migrations are additive; to fully revert you can `DROP TABLE "WebOrderLine",
  "WebOrder", "ClinicAccount", "ProductEnrichment";` and remove the two migration folders.
  Nothing else depends on them.
