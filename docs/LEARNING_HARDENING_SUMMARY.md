# Minerva Learning-Pipeline Hardening

## What changed

### 1. Price-safe knowledge distillation

- The distillation prompt now explicitly removes product prices, monetary amounts, discounts,
  and promotions while retaining non-price facts such as packaging, size, origin, and warranty.
- A shared deterministic guard rejects distilled or owner-entered KB text matching
  `\d[\d,.]*\s*บาท|฿\s*\d`.
- Ordinary promotion returns `{ skipped: true, reason: "price_content" }`, creates no KB row,
  and returns the `LearnedAnswer` to `pending`.
- Flagged resolution returns HTTP 400 `price_content` before claiming the row, so it remains
  `flagged` and visible to the owner.

### 2. Capture-time queue noise filter

- Edited replies now pass through a local deterministic filter before `LearnedAnswer.create`.
- High-confidence order/slip acknowledgements are skipped when they have no protected
  policy/product-fact keywords.
- Tone-only edits are skipped when, after Thai word segmentation and normalization of
  whitespace, emoji, and polite particles, their digit/content token sets are subsets of the
  original draft.
- Ambiguous edits and any edit that introduces a new fact token or changes a number continue
  to enter the queue. The filter makes no LLM call.

### 3. Durable conflict-resolution lane

- `LearnedAnswer` now supports `flagged` status and nullable `flagNote`.
- Added supervisor-only endpoints:
  - `POST /api/learned/:id/flag` with optional `{ note }`
  - `POST /api/learned/:id/resolve` with either `{ action: "reject" }` or
    `{ action: "promote", kbText }`
- `GET /api/learned?status=flagged` uses the existing status filter.
- Plain promotion or rejection of a flagged row returns HTTP 409
  `flagged_requires_resolution`; flagged decisions go through `/resolve`.
- Promote-resolution bypasses the LLM and writes `kbText` exactly as supplied. It uses the
  original customer question as the sole question variant and retains the existing semantic
  duplicate/conflict warning behavior.
- The console now loads pending and flagged rows, includes the `🚩 รอเจ้าของ` filter, lets a
  supervisor flag a pending item with a note, and provides an owner-wording textarea plus
  promote/reject resolution controls.

## Files changed

- `api/prisma/schema.prisma`
- `api/prisma/migrations/20260727000000_learning_hardening/migration.sql`
- `api/src/llm/distill.ts`
- `api/src/llm/distill.test.ts`
- `api/src/learning/policy.ts`
- `api/src/learning/policy.test.ts`
- `api/src/learning/captureFilter.ts`
- `api/src/learning/captureFilter.test.ts`
- `api/src/routes/messages.ts`
- `api/src/routes/learning.ts`
- `api/test/learningRoutes.test.ts`
- `web/src/lib/api.ts`
- `web/src/Console.tsx`
- `docs/LEARNING_HARDENING_SUMMARY.md`

## Verification performed

From `api/`:

```text
npx vitest run
# 22 test files passed; 146 tests passed

npx tsc --noEmit
# passed
```

The changed web sources also pass:

```text
npx tsc -p tsconfig.json --noEmit
# passed
```

The existing web `npm run typecheck` command uses `tsc -b --noEmit` and currently fails before
checking sources because its referenced `tsconfig.node.json` disables emit (TS6310). This is an
existing workspace configuration issue; the direct project type-check above passed.

## Production verification checklist

1. Deploy the migration with `prisma migrate deploy`, then deploy API and web from the same
   revision.
2. Confirm `flagNote` exists and inspect queue distribution:

   ```sql
   SELECT status, count(*) FROM "LearnedAnswer" GROUP BY status ORDER BY status;
   ```

3. In the learning console, flag one safe test item with a note. Verify it disappears from
   `รออนุมัติ`, appears under `🚩 รอเจ้าของ`, and shows its question, AI draft, staff answer,
   and note.
4. Attempt the ordinary promote endpoint for that flagged ID and confirm HTTP 409 with
   `flagged_requires_resolution`.
5. Try resolving it with text containing `55 บาท`; confirm HTTP 400, no KB row, and that the
   item remains flagged.
6. Resolve a non-price test item with distinctive owner-approved wording. Confirm the KB answer
   matches that wording exactly and the learned row becomes `approved` with `promotedKbId` set.
7. Promote a pending test item whose mocked/staged distillation contains `625 บาท`; confirm the
   response says `price_content`, no KB row is created, and the item remains pending.
8. Send an edited order-summary acknowledgement and confirm no pending learned row is created.
   Then send an edit that adds a real fact such as origin or warranty and confirm it is captured.

## Decisions that may need review

- Noise filtering applies only to new captures. Existing pending noise is not auto-reclassified
  or deleted; retroactive cleanup should be an explicit supervised operation.
- To bias against false positives, generic acknowledgement phrases require bullet/list structure;
  only the strong `ขอบคุณที่ส่งสลิป` phrase can skip without a list.
- The deterministic monetary pattern is intentionally the requested narrow baht pattern and has
  no fee whitelist. The prompt provides broader protection for discounts/promotions, but unusual
  price wording without `บาท` or `฿` will not be caught by this post-check.
- Owner resolution keeps the exact `kbText`, including leading/trailing whitespace if supplied,
  to honor the exact-wording requirement. The UI starts with `finalAnswer` but permits full edit.
- Flagged items remain readable by the same authenticated Minerva users who could already read
  the learning queue; flag and resolve mutations remain supervisor-only.
