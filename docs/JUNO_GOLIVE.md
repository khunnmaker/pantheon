# Juno — go-live runbook

> State when written (2026-07-02): all Juno code + review fixes are on branch **`juno`**
> (`f8a3211`, local; parent `710cf80` is already on origin). `main` is at `a6043cd`
> (guardrail repair) and auto-deploys to Railway on push. A merge-tree dry-run shows
> `juno` merges onto `main` with **no conflicts**, and a pre-flight build of the merged
> tree was verified. The Payment migration deploys automatically with the api (its boot
> runs `prisma migrate deploy`). Owner performs the Railway-dashboard steps; the git
> steps can be run by any session.

**Rollback posture (read first):** every step is individually safe. The migration is
ADD-only (a new empty table — Minerva never reads it). If anything looks wrong after a
deploy, Railway → the service → Deployments → "Redeploy" the previous deployment; the
schema needs no rollback. The Google-Sheet mirror keeps working the whole time, so
finance is never blind.

---

## Step 1 — Push the `juno` branch (safe: deploys nothing)

```bash
cd C:\Users\khunn\Project\Minerva
git checkout juno
git push origin juno
```
Railway only watches `main`; this is backup + review only.

## Step 2 — Merge to `main` and push (THIS deploys)

Do this at a quiet hour (each api deploy briefly restarts it; the console reconnects —
same as every past deploy).

```bash
git checkout main
git pull origin main          # make sure main is current (expect a6043cd or later)
git merge juno --no-edit      # dry-run verified: no conflicts
git push origin main
```

What happens on push: `api`, `web`, `diana`, `vesta` redeploy. The api boots →
`prisma migrate deploy` creates the `Payment` table → the `/to-finance` hook starts
writing a Payment row on every slip forward (sheet mirror unchanged). No user-visible
change yet — Juno's own service doesn't exist until Step 4.

## Step 3 — Verify the api deploy (Railway dashboard, ~2 min)

1. Railway → **api** service → Deployments → open the new deploy's logs.
2. Look for the migration line: `Applying migration 20260701000000_juno_payment` (or
   "already applied" on later boots) and a clean "Minerva API listening" line.
3. Quick probe: `https://<api-domain>/api/juno/summary` in a browser should return
   `{"error":"unauthorized"}` — that means the route is live and gated.

If the deploy crash-loops: Redeploy the previous deployment (rollback), then
investigate logs before retrying.

## Step 4 — Create the Juno service on Railway (dashboard)

Mirror the Vesta/Diana setup:
1. Railway project → **New → GitHub Repo** → `khunnmaker/minerva`.
2. Service **Settings → Source → Root Directory** = `/juno` (Railway detects
   `juno/Dockerfile`).
3. **Variables** → add `VITE_API_URL` = the api service's public URL (e.g.
   `https://<api-domain>`). It's a build arg baked into the static bundle — changing it
   later requires a redeploy.
4. **Settings → Networking → Generate Domain** → note the URL, e.g.
   `https://minerva-juno-production.up.railway.app`. (A custom domain can come later.)
5. Wait for the first deploy to go green.

The Juno service needs NO other secrets — no `DATABASE_URL`, no `JWT_SECRET` (it's a
static bundle; all data flows through the api). It must NOT run `prisma migrate deploy`
(it can't — it has no Prisma; Minerva's api stays the single migrator).

## Step 5 — Allow Juno's origin in the api CORS (dashboard)

1. Railway → **api** service → Variables → `WEB_ORIGIN`.
2. Append the Juno domain from Step 4, comma-separated, no spaces, no trailing slash:
   `https://<console-domain>,https://<vesta-domain>,https://<diana-domain>,https://<juno-domain>`
3. Save → the api redeploys (brief restart).

## Step 6 — Login smoke test (browser, ~2 min)

1. Open the Juno URL → the emerald **Juno · ระบบการเงิน** login screen.
2. Log in as Dr. M (`drm@prominent.local` + the SEED_PASSWORD value).
3. The dashboard tabs should load with zero counts (empty Payment table) and **no CORS
   errors** in the browser devtools console. If requests fail with CORS errors,
   re-check Step 5 (exact origin, no trailing slash).

## Step 7 — End-to-end test with a controlled slip

Don't re-forward an old real slip (already-sent slips now 409). Instead:
1. From a personal LINE account, send any bank-slip image to the Prominent OA.
2. In the Minerva console: read-slip → FinanceModal → set note = `TEST` → forward.
3. Verify ALL of:
   - the Google Sheet got its row (mirror intact),
   - the payment appears in Juno's **รายการรับเงิน** inbox with the slip image
     rendering in the drawer,
   - clicking forward AGAIN on the same slip shows "ส่งให้การเงินไปแล้ว" (409 guard),
   - if you entered an amount different from the OCR, the row is flagged and appears in
     **ตรวจสอบยอด**,
   - walk the lifecycle: ตรวจแล้ว → บันทึกแล้ว (stamps who/when), then **ยกเลิก (void)**
     to exclude the test from reports,
   - **รายงาน** shows correct Thai-day totals; CSV downloads and opens in Excel.
4. Delete the test row from the Google Sheet by hand (the sheet has no void concept).

## Step 8 — Handover + housekeeping

- Tell finance the URL + that they log in with the supervisor account (v1: Dr. M's
  login — see JUNO_DEPLOY.md "Roles" note for the future separate-finance-login option).
- The Google Sheet stays live as a mirror; finance should now WORK in Juno only.
- Optional git tidy-up: `git branch -d juno` after merge (and the stale diana-* branches
  when convenient).
- Watch the api logs for `juno payment write failed` for the first days — that line
  firing means a forward returned 500 and staff should retry (the record of truth
  refused to write; it is never silent).

## When something goes wrong

| Symptom | Action |
|---|---|
| api deploy crash-loops after merge | Railway → api → redeploy previous deployment; read logs; the migration is additive so no schema rollback is needed |
| Juno site loads but all requests fail (CORS in devtools) | Fix `WEB_ORIGIN` on the api (exact scheme+domain, comma-separated, no trailing slash) |
| Login OK but every list 401s later in the day | Expected after 12h token expiry — the app now returns to the Login screen automatically |
| Slip forward returns 500 `payment_record_failed` | DB write failed; retry the forward (idempotent). If persistent, check api logs / DB health |
| Slip forward returns 502 `finance_send_failed` | The SHEET webhook is down; the Payment row IS already recorded — retry later to refresh the sheet mirror (upsert, no duplicate) |
