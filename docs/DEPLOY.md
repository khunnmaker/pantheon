# Go-live runbook — Railway (managed)

Production = **3 components**, all on Railway, deployed from this repo:

| Component | What | Source |
|---|---|---|
| **Postgres (pgvector)** | database | `pgvector/pgvector:pg16` image |
| **api** | Fastify API + LINE webhook + Socket.IO | `/api` (its Dockerfile) |
| **web** | React console (static) | `/web` (its Dockerfile) |

The api's Dockerfile runs `prisma migrate deploy` on every boot (safe, idempotent),
and the `m3_pgvector` migration creates the `vector` extension itself — so the DB
**must** be a pgvector-capable image (hence `pgvector/pgvector:pg16`, not plain Postgres).

The 38-entry knowledge base ships in the code (`api/src/kb/historyKb.ts`) and is loaded
by `npm run seed` (which also creates staff logins and archives the placeholder samples).

---

## Stage 2 — Code to GitHub (one-time)
The repo is local-only; Railway deploys from GitHub.
1. Owner: create a **free private** repo on github.com (e.g. `minerva`).
2. Push:
   ```
   git remote add origin https://github.com/<you>/minerva.git
   git branch -M main
   git push -u origin main
   ```
   (Doubles as an off-laptop backup of the project.)

`.env`, raw chat exports (`.kb-source/`), and `kb-proposed.json` are gitignored — they
do **not** get pushed. Good.

## Stage 3 — Railway account (owner)
Sign up at railway.app with the GitHub account, add a payment card. ~10 min.

## Stage 4 — Create the project + database
1. **New Project → Deploy from GitHub repo →** pick `minerva`.
2. Add the database: **New → Database → Add PostgreSQL**, then make sure it uses
   **pgvector** — either Railway's *pgvector* template, or set the image to
   `pgvector/pgvector:pg16`. (Plain Postgres will fail the vector migration.)

## Stage 5 — Configure the `api` service
- **Settings → Root Directory = `/api`** (so Railway builds `api/Dockerfile`).
- **Settings → Networking → Generate Domain** (gives the public HTTPS URL).
- **Variables** (see reference table below). Key ones:
  - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
  - `JWT_SECRET` = a long random string
  - `WEB_ORIGIN` = `https://${{web.RAILWAY_PUBLIC_DOMAIN}}`
  - the API keys + **real** LINE OA credentials

## Stage 6 — Configure the `web` service
- **New service → from the same repo**, **Root Directory = `/web`**.
- **Networking → Generate Domain** (this is the URL staff log into).
- **Variables → `VITE_API_URL` = `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`**
  (baked into the bundle at build time so the console calls the right API).

## Stage 7 — First-time setup (one-off, run once)
After the first successful deploy, run the seed once to create staff logins + load the KB.
On the **api** service: open a shell / one-off command and run with a strong password:
```
SEED_PASSWORD='<strong-password>' npm run seed
```
This creates: `mind@`, `fah@`, `nadeer@prominent.local` (nadeer = supervisor) and loads 38 KB entries.
Re-running is safe but re-applies the canonical KB answers — don't run it again after
supervisors have edited entries in the console.

## Stage 8 — Point LINE at it
LINE Developers console → the OA's **Messaging API** channel:
- **Webhook URL** = `https://<api-domain>/webhook/line`
- **Use webhook = ON**, then **Verify**.
- Turn **off** "Auto-reply messages" / greeting if you want only Minerva replying.

## Stage 9 — Switch backup OA → real "Prominent" OA
Set `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET` on the **api** service to the
**real "Prominent Co., Ltd."** OA's values, and update the webhook URL in *its* channel.
Redeploy. (Until this step, keep using the backup OA "AppDent Suggestion".)

## Stage 10 — Test + hand off
- Message the OA from a phone → a draft appears in the console → staff approve → reply sends.
- Confirm price/stock/clinical still route to a human.
- **Backups:** enable Railway's database backups (or a scheduled `pg_dump`). Do this before real traffic.
- Give staff the **web** URL + their passwords.

---

## Environment variable reference (api service)
| Variable | Value | Required |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | yes |
| `JWT_SECRET` | long random string | yes |
| `ANTHROPIC_API_KEY` | from console.anthropic.com | yes (drafting) |
| `VOYAGE_API_KEY` | from voyageai.com | yes (memory retrieval) |
| `LINE_CHANNEL_ACCESS_TOKEN` | OA's token | yes |
| `LINE_CHANNEL_SECRET` | OA's secret | yes |
| `WEB_ORIGIN` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` | yes (CORS) |
| `LINE_DRY_RUN` | unset = real sends; `1` = log-only (staging) | no |
| `RECENT_WINDOW` / `RETRIEVE_K` / `SESSION_IDLE_MINUTES` | defaults 10 / 3 / 30 | no |
| `SEED_PASSWORD` | strong; used by the one-off seed | setup only |

`PORT` is provided by Railway automatically — don't set it.

## web service
| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` (build-time) |

## Notes
- Region: pick **Singapore** (closest to Thailand) when creating services, for low LINE latency.
- Two services reuse the already-tested Dockerfiles. A future option is to merge them into one
  service (API serves the console) for one URL + lower cost — not needed for go-live.
- Voyage free tier = 3 requests/min; the pipeline degrades gracefully if rate-limited.
