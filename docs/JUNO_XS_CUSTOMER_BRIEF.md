# XS customer display — "just like RE" (owner directive 2026-07-24)

## Goal
XS document rows must show a customer (Express code + name) the way MB/RE rows do. The XS source report (STTRNR6.TXT) carries only the Express customer CODE (stored in `XsDoc.note` on sales-era docs, e.g. `R022`). The customer NAME lives in the Venus customer master: Prisma model `VenusCustomer` (`code @unique`, `name`, `searchKey` = lowercased dash-stripped code) — same shared DB. Resolve code → name at READ time. NO schema change, NO migration.

## Backend (api/)
1. New helper `api/src/finance/xsCustomers.ts`:
   `resolveXsCustomerNames(prisma, notes: string[]): Promise<Map<string, string>>`
   - key = raw note value as passed; trim for matching; skip blanks.
   - Pass 1: `venusCustomer.findMany({ where: { code: { in: trimmedNotes } }, select: { code, name } })`.
   - Pass 2 (only for still-unmatched notes): match by `searchKey` — derive the key the same way Venus does (check `api/src/venus/parseArmast.ts` / wherever searchKey is built; it's lowercase + dash-stripped). One batched query, not per-note.
   - Unresolved → absent from the map. Never throw; on DB error return an empty map (display degrades to bare code, route must not 500).
2. `api/src/routes/juno.ts` — GET `/api/juno/re` XS branch (~lines 3272–3293):
   - After the existence/sales-era filters produce the XS candidate set, batch-resolve their notes ONCE.
   - Row mapping becomes `customerName: [x.note.trim(), resolvedName].filter(Boolean).join(' ')` — mirroring the MB mapping `[customerCode, buyerName]` at ~3264. Unresolved code still shows bare.
   - Include the resolved name in the text search: XS `matchesNeedle(x.xsNo, x.note, resolvedNameOrEmpty)`. Mind the order: resolve before the needle filter, but only for docs passing the sales-era/amount existence filter (cheap set, ~hundreds).
3. GET `/api/juno/xs` (XS tab list route): add `customerName` (same `[code, name]` join) to each doc DTO via the same batched helper. Keep `note` in the DTO unchanged.
4. Touch NOTHING else: parser `parseXsDocs.ts`, `xsAmounts.ts` stub creation, POST /xs/import upsert, matching/recon logic, confirmedAmount handling all stay byte-identical.

## Frontend (juno/src)
- `lib/api.ts`: add `customerName: string` to the `XsDoc` type.
- `XsDocs.tsx`:
  - List: rename the หมายเหตุ column to ลูกค้า; cell renders `doc.customerName || doc.note || '—'` (same truncate wrapper).
  - Drawer: add `<Info label="ลูกค้า" value={doc.customerName} />` as the second field; KEEP the existing `หมายเหตุ (รหัสลูกค้า Express)` field showing the raw note.
- `ReRecon.tsx`: NO change (already renders `row.customerName` unconditionally).

## Tests
- New unit test for the resolver: exact code hit, searchKey-fallback hit, unresolved code, blank note skipped, DB-error → empty map.
- Extend the existing GET /re and GET /xs route tests (see `api/test/xsDocs.test.ts`, `api/test/junoXsAmounts.test.ts` for the mock style) to pin: XS row `customerName === 'R022 คลินิกตัวอย่าง'` when Venus has the code, bare `'R022'` when not.

## Environment / verification (fresh worktree)
- Repo root: `C:\Users\khunn\Project\Pantheon-juno-xscust`, branch `juno-xs-customer` @ origin/main.
- Setup: root `npm ci`, then `npx prisma generate --schema api/prisma/schema.prisma` (npm ci does NOT regen the client — skipping this causes phantom tsc errors).
- api/.env: copy from `C:\Users\khunn\Project\Pantheon\api\.env` if present, else from api/.env.example. NEVER read, print, or echo its values anywhere.
- Gates you run yourself: `npx tsc --noEmit` in api; full `npx vitest run` in api; `npx tsc --noEmit` in juno. If the juno vite build fails in your sandbox for network reasons, SAY SO and stop — do NOT modify build scripts/config to work around it (past incident).
- Do NOT commit. Leave changes uncommitted for diff review.

## Report contract
Reply with ≤10 lines: files created/changed, gate results (exact pass counts), anything you're unsure about. Do NOT paste file contents back.
