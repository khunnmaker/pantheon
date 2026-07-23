# Mali Phase 1 backend report

## Outcome

Phase 1 backend core is implemented and verified. The worktree already contained the tracked
Phase 1 baseline from commit `201f5bb`; this pass audited it against `docs/MALI_PLAN.md` and closed
three fail-closed/spec gaps:

- added a separately tagged Sonnet confidence self-check before answer generation;
- made all LINE retrieval exclude `supervisor` audience articles, even for supervisor askers;
- moved the 1:1 bind gate ahead of non-text handling so every unbound sender receives only the
  bind prompt.

Phase 5 group-listener models and behavior were not added. Existing Venus group-ingestion wiring
was preserved.

## Phase 1 files

The tracked baseline covers:

- schema and add-only migrations:
  `api/prisma/schema.prisma`,
  `api/prisma/migrations/20260801000000_mali_phase1/migration.sql`,
  `api/prisma/migrations/20260801000100_mali_pgvector/migration.sql`;
- environment/auth/wiring:
  `.env.example`, `api/.env.example`, `api/src/env.ts`, `api/src/auth/jwt.ts`,
  `api/src/index.ts`;
- LINE binding, client, sending, signature, and webhook:
  `api/src/line/client.ts`, `api/src/line/send.ts`, `api/src/line/signature.ts`,
  `api/src/line/staffBind.ts`, `api/src/routes/maliWebhook.ts`;
- RAG and knowledge APIs:
  `api/src/mali/answer.ts`, `api/src/memory/embeddings.ts`, `api/src/routes/mali.ts`;
- Phase 1 tests:
  `api/src/mali/answer.test.ts`, `api/src/memory/embeddings.mali.test.ts`,
  `api/src/routes/maliWebhook.test.ts`, `api/src/line/send.mali.test.ts`,
  `api/src/line/staffBind.test.ts`.

This pass changed, uncommitted:

- `api/src/mali/answer.ts`
- `api/src/mali/answer.test.ts`
- `api/src/memory/embeddings.ts`
- `api/src/memory/embeddings.mali.test.ts`
- `api/src/routes/maliWebhook.ts`
- `api/src/routes/maliWebhook.test.ts`
- `api/test/authRoles.test.ts`
- `docs/MALI_PHASE1_REPORT.md`

No existing migration file was edited, and `package-lock.json` was not regenerated.

## Verification

- Prisma schema validation: passed.
- API TypeScript build: passed with `npm.cmd run build --workspace api`.
- Focused Mali/auth tests: 6 files, 36 tests passed.
- Full API suite: 91 files, 801 tests passed using non-secret placeholder values for the two
  required test-process environment variables.
- `git diff --check`: passed.
- Migration diff check: no files under `api/prisma/migrations` are modified.
- Prisma client types were regenerated from the checked-in schema using already-installed local
  engine binaries; this produced no tracked file or lockfile change.

## Open questions / deployment checks

- Phase 0 still needs the Mali OA provider decision and real
  `MALI_LINE_CHANNEL_ACCESS_TOKEN` / `MALI_LINE_CHANNEL_SECRET` configured off-chat.
- The initial department list and answerers remain an owner decision for Phase 2 routing.
- Live LINE end-to-end acceptance and production migration deployment require the configured OA
  and database; local tests cover signature rejection, bind-only fail-closed behavior,
  reply-token/push fallback, SQL tier isolation, confidence branches, citations, and rate limit.
- Group inventory, retention, and mention behavior remain Phase 5 and were intentionally excluded.
