# Minerva — LINE AI Customer-Reply Assistant (human-in-the-loop)

Internal tool for **Prominent** (dental distribution, Thailand). Customer questions on LINE
are answered by staff, **assisted** by an AI that drafts replies from a curated knowledge
base. The AI **never sends automatically** — a logged-in staff member reviews/edits/approves
every reply. The system remembers each customer (3-layer memory) and learns from staff edits.

> This repository is built milestone-by-milestone per `BUILD_SPEC_LINE_AI_Reply.md`.
> **Current status: M0 — Scaffold.**

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
Web console:
```bash
cd web && npm install && npm run dev    # http://localhost:5173
```

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
- M1 — Ingest + console shell + auth
- M2 — Draft + send (human-in-the-loop) + guardrails
- M3 — 3-layer memory (embeddings + retrieval + auto-summary)
- M4 — Learning loop
- M5 — Polish (metrics, KB admin, PDPA retention)

## Safety defaults (always)
Price / stock / clinical questions route to a human. KB-only answering. Never auto-send.
On any LLM/parse error, safe-default to `needs_human`.
