# Juno — บิลมือ access scoping for Nee (MD) — build brief

Owner spec (2026-07-13, follows the บิลมือ v1 in docs/JUNO_BINMUE_BRIEF.md, shipped `84aee11`): the **บิลมือ tab is granted to only Nee (MD), and Nee can access ONLY this tab in Juno.** Nee issues the manual bills; FIN references bill numbers when verifying payments.

Resulting access matrix (the whole change):

| Role | Juno UI | Juno API |
|---|---|---|
| `supervisor` (Dr. M) | ALL tabs incl. บิลมือ (unchanged) | everything (unchanged) |
| `md` (Nee — the TIER account `md@prominent.local`, NOT an employee row) | **ONLY the บิลมือ tab** | **ONLY**: GET/POST `/api/juno/bills`, PATCH `/api/juno/bills/:id`, POST `/api/juno/bills/:id/void`, GET `/api/juno/products`. Everything else under juno.ts AND finance.ts → 403 |
| `employee` with juno grant (benz, meow = FIN; nun) | current tabs **MINUS บิลมือ** (they keep inbox/wht/flags/recon/reRecon/audit as today) | as today, EXCEPT bill mutations (POST/PATCH/void on /bills) → 403. **GET /bills and GET /products stay open** — the ตรวจแล้ว chips' soft-validation ("ไม่พบบิลนี้") depends on GET /bills and must keep working for FIN |

## HARD CONSTRAINTS
- NO schema change, NO migration, NO new npm dependencies, never touch any package-lock.json. If node_modules are needed, run `npm ci` ONCE at the repo ROOT only (this is an npm-workspaces monorepo — a per-package `npm ci` scrambles the hoisted root modules).
- Do NOT `git commit`/push; leave changes uncommitted.
- Server-side enforcement is the real gate; UI hiding is convenience. Never rely on the frontend.
- Follow existing idioms (requireApp/requireRole in api/src/auth/middleware.ts; tab gating patterns in juno/src/Juno.tsx — see how CEO-only tabs are conditionally spread into the `tabs` array).

## 1) Grant: md must pass `requireApp('juno')`
Nee currently has NO juno access — `api/src/db/ensureSeeded.ts` line ~16 says md = "implicit access to Ceres (management side) only". Read `api/src/auth/jwt.ts` `hasAppAccess` (and how TIER_ACCOUNTS get their apps in ensureSeeded.ts) and make the MINIMAL correct change so the md role/tier account also has the `juno` app: either extend md's implicit app set or seed the md agent's `apps` — whichever mechanism the code actually uses for tier accounts. Update the stale "Ceres only" comments. Verify the Juno login-card route (`getLogins?app=juno` handler, likely in auth routes) will now include the md card automatically via the same hasAppAccess — if it filters some other way, fix so Nee can log in to Juno (portal unified login rides the same access check). Also confirm the Pantheon portal tile logic keys off hasAppAccess so the Juno tile appears for her (it should automatically; change nothing if so).

## 2) Server guards
In `api/src/routes/juno.ts` (base hooks at ~513–514: requireAuth + requireApp('juno')), add ONE more preHandler hook after them implementing:
- `supervisor` → allow all (return).
- `md` → allow ONLY the bills/products surface: `GET/POST /api/juno/bills`, `PATCH /api/juno/bills/:id`, `POST /api/juno/bills/:id/void`, `GET /api/juno/products`. Everything else → 403 `{ error: 'forbidden' }`.
- `employee` → allow everything EXCEPT bill mutations: `POST /api/juno/bills`, `PATCH /api/juno/bills/:id`, `POST /api/juno/bills/:id/void` → 403. (GET /bills + GET /products remain open.)
Match on `req.routeOptions.url` (the route PATTERN, e.g. `/api/juno/bills/:id`) + `req.method` — NOT on raw `req.url` (query strings/params make raw-URL regexes fragile). Write the allow/deny sets as explicit constants with a comment citing the owner decision date.

In `api/src/routes/finance.ts` (FinanceAudit router, same requireApp('juno') hook at ~16): add a hook denying `md` entirely (403) — Nee's lane is bills-only; employees/supervisor unchanged.

Also grep for any OTHER `requireApp('juno')` surfaces (`grep -rn "requireApp('juno')" api/src/`) and apply the same md-deny to any found beyond these two files (do not touch requireApp('minerva')/'ceres' surfaces — md's Ceres/other-app access is out of scope).

## 3) Frontend (juno/src/)
`Juno.tsx`:
- Derive `const scope = agent.role === 'supervisor' ? 'full' : agent.role === 'md' ? 'billsOnly' : 'noBills'`.
- `billsOnly` (Nee): `tabs` = only the บิลมือ entry; initial `view` state = `'bills'`; `refreshSummary` must NOT call getSummary/getBankSummary/getFinanceAudits (they'd 403) — only the bills fetch drives her badge. Header (logo, AppSwitcher, logout) unchanged.
- `noBills` (employees): current tab list minus the บิลมือ entry; skip the getManualBills badge call (no tab to badge); everything else exactly as today.
- `full`: unchanged.
- Make sure the initial-view logic doesn't flash a forbidden tab for md (initialize state from scope, don't correct after mount).

`Bills.tsx`: no read-only variant needed (employees never see the tab; md and supervisor both get full CRUD). Leave as is unless something breaks type-wise.

## 4) Self-verification (all must pass)
1. `npm ci` at repo ROOT (once).
2. `api`: `DATABASE_URL="postgresql://x:x@localhost:5432/x" npx prisma generate` then `npx tsc --noEmit` clean.
3. `juno`: `npm run build` clean.
4. `git status` — no package-lock/schema/migration changes; only the intended source files.
5. Re-read your server hook and self-check the matrix above case by case (md GET /bills ✓, md GET /payments ✗, employee GET /bills ✓, employee POST /bills ✗, employee POST /payments/:id/verify ✓ — that route must stay employee-open, it's FIN's daily verify flow).
6. Print a concise summary: files changed, the mechanism used for the md juno grant, and verification results.
