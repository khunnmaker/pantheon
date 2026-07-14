# The Pantheon — Prominent's internal software suite

**The Pantheon** is the internal software suite for **Prominent** (dental distribution,
Thailand): a family of apps, each named for a Roman deity, running on one shared PostgreSQL
database, one API, and one login. Each app is its own frontend + Railway service; Minerva's
`api/` is the single source of truth and the **sole** database migrator (migrations are
add-only).

> This monorepo began as **Minerva** (the flagship — still the repo/remote name) and grew into
> the full pantheon. The suite-wide brand is **The Pantheon**; the individual apps keep their
> deity names.

| App | Deity role | What it does | Status |
|-----|-----------|--------------|--------|
| **Pantheon** | suite portal · staff front door | One login, app tiles, live "pending work" badges, app-switcher | Live |
| **Jupiter** | king · accounting | The group's multi-company accounting app | Live |
| **Minerva** | wisdom · sales | LINE AI customer-reply console (human-in-the-loop); catalog + stock quoting | Live (flagship) |
| **Vesta** (formerly Vulcan; renamed 2026-07-12 — Vulcan is reserved for the future KPKF manufacturing app) | hearth · stock | Inventory: stock import, reorder points, low-stock, dashboard | Live |
| **Juno** | ledger · income | Money-in: LINE payment slips, bank reconciliation, tax invoices, reports | Live |
| **Ceres** | harvest · expenses | Money-out: petty cash + staff expenses with an approval flow | Built · awaiting deploy |
| **Venus** | relations · CRM | 360° customer view — segments, reorder timing, churn signals | In progress |
| **Diana** | the hunt · B2B | Public login-gated B2B catalog (prominentdental.com) | Early |
| **Mercury** | trade · procurement | Buy-side ordering; closes the buy → stock loop into Vesta | Planned |

The portal is the `pantheon/` app at **pantheon.prominentdental.com**; `jupiter/` is the
accounting app at **jupiter.prominentdental.com**. The API service name and
`/api/jupiter/acct/*` paths belong to the accounting lane. Auth is unified suite-wide
(supervisor / MD / employee with per-person app grants).

---

## Minerva — LINE AI Customer-Reply Assistant (human-in-the-loop)

Internal tool for **Prominent** (dental distribution, Thailand). Customer questions on LINE
are answered by staff, **assisted** by an AI that drafts replies from a curated knowledge
base. The AI **never sends automatically** — a logged-in staff member reviews/edits/approves
every reply. The system remembers each customer (3-layer memory) and learns from staff edits.

## Stack
- **Backend:** Node.js + TypeScript, Fastify. `@line/bot-sdk`, `@anthropic-ai/sdk`.
- **DB:** PostgreSQL + `pgvector`. ORM: Prisma.
- **Embeddings:** Voyage AI (`voyage-3`, 1024-dim) — swappable behind `EmbeddingProvider`.
- **LLM:** Claude API — `claude-sonnet-4-6`.
- **Frontend:** React + TypeScript + Tailwind + Vite (ports `line_ai_reply_prototype.jsx`).
- **Realtime:** WebSocket to push pending drafts to the console.
- **Auth:** email + password (bcrypt) + JWT; roles `agent` / `supervisor`.

## Repo layout
```
/api    Fastify + Prisma backend
/web    Vite React console (prototype port lands in M1)
docker-compose.yml   postgres(pgvector) + api + web
```

## Prerequisites
- **Node.js 20+** — required. (Installed via winget on the dev machine: v24.x.)
- **PostgreSQL 16** — for local dev *without Docker* (installed via winget). Plain Postgres
  is enough for **M0–M2** (relational only).
- **Docker Desktop** — needed for the full `pgvector` path in **M3+**. On Windows this needs
  WSL2 (`wsl --install`, then a reboot). Not required to run M0–M2.

## Two ways to run

### A) Local dev on native PostgreSQL (no Docker — current setup)
This is how M0 was verified on the dev machine.
```bash
# 1. api env (already points at the local postgres superuser)
cd api && copy .env.example .env   # then set DATABASE_URL to your local postgres

# 2. install + migrate + run
npm install
npx prisma migrate dev --name init   # creates the 8 relational tables
npm run dev
```
```bash
# health checks
curl http://localhost:3000/health      # {"status":"ok","service":"minerva-api",...}
curl http://localhost:3000/health/db   # {"status":"ok","db":"up"}
```
Load the KB + run the console:
```bash
cd api && npm run seed                   # loads the KB only (staff are created on API boot)
cd web && npm install && npm run dev     # http://localhost:5173 — log in to use the console
```

### Staff accounts
Reconciled automatically on every API boot (see `api/src/db/ensureSeeded.ts`) — no seed
step for logins. Passwords come from env vars, never the repo: set `SEED_PASSWORD` (the
supervisor) and `STAFF_PASSWORD` (the shared team login) in `api/.env` for local dev.

| email                    | name   | role       | password env     |
|--------------------------|--------|------------|------------------|
| `drm@prominent.local`    | Dr. M  | supervisor | `SEED_PASSWORD`  |
| `nadeer@prominent.local` | NaDeer | agent      | `STAFF_PASSWORD` |
| `anny@prominent.local`   | Anny   | agent      | `STAFF_PASSWORD` |
| `noey@prominent.local`   | Noey   | agent      | `STAFF_PASSWORD` |

### Testing the LINE webhook without a real LINE OA
Set a dev `LINE_CHANNEL_SECRET` in `api/.env`, then POST a body with a matching
`X-Line-Signature` (HMAC-SHA256, base64). A correctly-signed body is ingested and pushed
live to logged-in consoles over WebSocket; a wrong signature is rejected with 401.

### B) Everything in Docker (intended for M3+, needs WSL2)
```bash
cp .env.example .env
docker compose up --build
# db uses the pgvector/pgvector image; api applies migrations on boot
# api: http://localhost:3000/health   web: http://localhost:5173
```

> **pgvector is deferred to M3.** The schema's vector extension + embedding tables are kept
> as a documented, commented block in `api/prisma/schema.prisma` and `api/prisma/init-pgvector.sql`.
> M0–M2 run on vanilla Postgres; activate pgvector when M3 (embeddings/retrieval) begins.

## Milestones
- **M0 — Scaffold** ✅ **verified running**: monorepo, docker-compose (postgres+pgvector),
  Prisma schema + relational migration applied, env loading, health check green
  (`/health` + `/health/db` both ok on native Postgres). pgvector deferred to M3.
- **M1 — Ingest + console shell + auth** ✅ **verified running**: LINE webhook with
  X-Line-Signature verification → store customer/message; agent login (JWT + agent/supervisor
  roles); live console queue over Socket.IO (JWT-authed); prototype ported to a real login +
  live read-only console. Drafting/sending is M2.
- **M2 — Draft + send (human-in-the-loop) + guardrails** ✅ **verified running**: sample KB +
  CRUD (supervisor-gated); AI draft pipeline (Claude `claude-sonnet-4-6`) generated on ingest;
  server-side guardrails force price/stock/clinical → `needs_human`; approve/edit/send via LINE
  push (numbers require confirm); learning loop (edits captured → supervisor promotes to KB).
  Set `LINE_DRY_RUN=1` to test the approve→send flow without messaging real customers.
- **M3 — 3-layer memory** ✅ **verified**: (1) **long-term summary** — session-end auto-summary
  (Claude) on `CustomerMemory`, injected into every draft (manual "จบแชท" + idle sweep); (2)
  **retrieval** — Voyage `voyage-3` embeddings in pgvector (`message_embedding`/`kb_embedding`,
  HNSW cosine), top-`RETRIEVE_K` relevant past messages pulled into the prompt; (3) **recent window**
  — last `RECENT_WINDOW` messages verbatim. DB is the `pgvector/pgvector` container (host `:5433`).
  > Voyage free tier is 3 req/min until a payment method is added (free tokens still apply); the
  > pipeline degrades gracefully (summary + recent window) if an embed call is rate-limited.
- M4 — Learning loop
- M5 — Polish (metrics, KB admin, PDPA retention)

## Safety defaults (always)
Price / stock / clinical questions route to a human. KB-only answering. Never auto-send.
On any LLM/parse error, safe-default to `needs_human`.
