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

## Prerequisites (install these first)
M0 files are committed, but to **run/verify** them you need:
- **Node.js 20+** — https://nodejs.org  (`node -v`, `npm -v`)
- **Docker Desktop** — https://www.docker.com/products/docker-desktop  (`docker -v`)

> On this machine, neither `node` nor `docker` was on PATH at scaffold time — install both,
> then follow the steps below.

## Quick start (M0)
```bash
# 1. configure env
cp .env.example .env
# edit .env — at minimum set a DATABASE_URL and JWT_SECRET; LINE/Anthropic/Voyage
# keys can stay blank until M1/M2/M3.

# 2. bring up postgres (pgvector) + build api/web
docker compose up -d db
cd api && cp .env.example .env && npm install

# 3. create the database schema
npx prisma migrate dev --name init
# (pgvector extension is enabled by the db container's init script)

# 4. run the api
npm run dev
# health check:
curl http://localhost:3000/health   ->  {"status":"ok",...}
```

Or run everything in containers:
```bash
docker compose up --build
# api:  http://localhost:3000/health
# web:  http://localhost:5173
```

## Milestones
- **M0 — Scaffold** ✅ (this commit): monorepo, docker-compose (postgres+pgvector),
  Prisma schema + migrations, env loading, health check.
- M1 — Ingest + console shell + auth
- M2 — Draft + send (human-in-the-loop) + guardrails
- M3 — 3-layer memory (embeddings + retrieval + auto-summary)
- M4 — Learning loop
- M5 — Polish (metrics, KB admin, PDPA retention)

## Safety defaults (always)
Price / stock / clinical questions route to a human. KB-only answering. Never auto-send.
On any LLM/parse error, safe-default to `needs_human`.
