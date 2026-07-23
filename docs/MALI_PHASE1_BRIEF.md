# Sol brief — Mali Phase 1: backend core

You are in a git worktree on branch `mali-phase1` (off latest main). Build **Phase 1 only** of
`docs/MALI_PLAN.md` — read that plan first; it is the spec and its §9 lists standing repo lessons
you must honor. §10 (group listener) is Phase 5: do NOT build it, but name nothing that would
collide with its future `MaliGroup`/`GroupMessage` models.

## Scope (plan §7 Phase 1)

1. **Prisma schema + migrations (ADD-ONLY)**: `KnowledgeArticle`, `KnowledgeDepartment`,
   `KnowledgeQuestion` per plan §4, plus raw-SQL `knowledge_embedding` vector(1024) + HNSW cosine
   index — clone the existing `kb_embedding` migration pattern. Never edit existing migrations.
2. **Webhook `/webhook/mali`**: signature check via `MALI_LINE_CHANNEL_SECRET` (new env vars per
   plan §2 naming, added to `api/src/env.ts` the same way other service prefixes are); fail-closed
   bind gate (unbound userId → Thai bind prompt only, NEVER knowledge); `MALI-XXXXXXXX` bind
   command reusing the `staffBind.ts` machinery (add the prefix generically).
3. **Answer pipeline `api/src/mali/answer.ts`**: embed question (reuse
   `api/src/memory/embeddings.ts` Voyage path) → top-K retrieval scoped to asker's role tier
   (tier filter INSIDE the SQL, not post-hoc; LINE lane additionally restricted to
   `lineExposable` + audience everyone/gm_plus per plan §4) → confidence gate (top cosine
   similarity threshold + LLM self-check) → confident: Claude answers WITH citations
   ("ที่มา: …"), reply via replyToken first, push fallback on expired token; not confident:
   create `KnowledgeQuestion` (status waiting) + tell asker it's been escalated (actual answerer
   routing/push is Phase 2 — just persist the row and reply politely in Thai).
4. **Guardrails**: per-staff rate limit 30 questions/day; every LLM/embedding call goes through
   the existing `callClaude`/token-usage choke point tagged `{ app: 'mali', feature: ... }` per
   plan §4; answer model = Sonnet-class.
5. **Auth**: `'mali'` = all-staff app special case in `hasAppAccess` (any active Agent passes).
6. **Tests** (follow the api test conventions already in the repo): bind gate fail-closed,
   tier scoping (employee never receives gm_plus/supervisor content), confidence branches
   (confident vs escalate), rate limit.

## Constraints

- Placeholders only for env values; NEVER echo real secrets from any `.env`.
- Root-workspace `npm ci` only if needed; NEVER regenerate `package-lock.json`.
- Thai user-facing strings, polite ค่ะ register (Mali is a female persona, "น้องมะลิ").
- Don't touch other services' code beyond the minimal wiring (env.ts, route registration,
  hasAppAccess).
- Do this work yourself, synchronously — do not delegate further or spawn background agents;
  reply only when the work is done and verified.

## Acceptance

- `npm run build` (api workspace) and the api test suite pass from the repo root.
- New tests cover the four areas above and pass.
- Migrations are new files only; `git diff --stat` shows no edits to existing migration files.

## Report contract

Leave all changes uncommitted in the worktree. Write your report to
`docs/MALI_PHASE1_REPORT.md` (files created/changed, how verified, open questions), and reply
with ≤10 lines summarizing the same. Do NOT paste file contents back.
