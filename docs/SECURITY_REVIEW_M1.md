# M1 Security Review — outcomes & deferred items

Multi-lens adversarial review (4 review lenses → per-finding adversarial verification, 30 agents).
**26 findings confirmed real.** 6 were must-fix-in-M1 (fixed in commit `99f5a6e`); the rest are
genuine but deferred to a pre-deployment / M2 hardening pass (verifier judged them not to block M1,
mostly because M1 is local-dev-only, read-only, and behind auth).

## Fixed in M1 (commit 99f5a6e)
- **Login rate limiting** — `@fastify/rate-limit`, 10/min per IP on `/api/auth/login`.
- **Login timing oracle** — compare against a dummy bcrypt hash when the email is unknown
  (uniform timing → no user enumeration). `auth/password.ts`, `routes/auth.ts`.
- **Prototype-pollution guard** — raw-body parser uses `secure-json-parse` (not bare `JSON.parse`),
  restoring Fastify's default protection on every JSON route. `index.ts`.
- **Socket stale token / silent dead queue** — token read lazily per (re)connect; `connect_error`
  with `unauthorized` triggers logout. `web/src/lib/socket.ts`, `web/src/Console.tsx`.
- **Corrupt-storage blank screen** — `getStoredAgent` guards `JSON.parse`. `web/src/lib/api.ts`.
- **JWT algorithm pin** — `verify` restricted to `HS256`. `auth/jwt.ts`.

## Deferred — do before first real deployment / in M2
Severity in parentheses is the verifier's confirmed severity.

### Before any non-local deploy (env/config hardening)
- **JWT_SECRET strength guard** (medium) — `env.ts` accepts any non-empty secret. Enforce
  `min(32)` and, when `NODE_ENV==='production'`, reject known placeholders
  (`change-me-in-production`, `dev-only-change-in-prod`). Forged-supervisor tokens are possible
  if a weak/dev secret reaches prod. *(Secrets are gitignored today, so not exposed via the repo.)*
- **LINE_CHANNEL_SECRET prod guard** (low) — empty secret makes the webhook fail-closed *silently*
  (every real delivery 401'd). In production, require it at boot; log empty-secret at error level.
- **CORS `*` + credentials footgun** (low) — `index.ts` + `ws/io.ts`. Safe by default
  (`WEB_ORIGIN=http://localhost:5173`), but forbid `*`+credentials in prod / use an explicit allowlist.

### Data growth (add before customer volume grows)
- **`/api/queue` unbounded full-table scan** (medium) — `console.ts`: loads all customers + a
  per-row latest-message subquery, filters in JS. Add a denormalized `lastMessageRole`/`awaitingReply`
  column (set at ingest) + pagination + index.
- **`/api/customers` no pagination** (low) — same pattern; add take/cursor + max page size.

### M2 (when sending / role-gated actions land)
- **`requireRole` defined but unused** (low) — apply `requireRole('supervisor')` on supervisor-only
  endpoints (approve/send, learned-answer promotion) + a test that an agent token gets 403.
- **Client trusts localStorage `role`** (info) — validate via `GET /api/auth/me` on load; never gate a
  security-relevant action on the client-stored role (server JWT role is authoritative).
- **JWT in localStorage + no CSP** (low) — once sending makes the blast radius account-takeover,
  consider HttpOnly+Secure+SameSite cookie session and a Content-Security-Policy.
- **401 doesn't log the UI out** (low) — token clears from storage but React still shows the console
  until refresh. Wire a `onUnauthorized` callback → `setAgent(null)` + socket disconnect.

### Webhook robustness (near-term hardening)
- **No replay/dedup** (low) — add a unique constraint on `Message.channelMsgId` + skip-on-conflict.
  Primarily protects against LINE's legitimate at-least-once retries creating duplicate rows/pushes.
- **Unvalidated event shapes / no length caps** (low) — add a zod schema for webhook events and a
  max length on `text`/`lineUserId` (defense-in-depth; bodies are already signature-authenticated).
- **Login 500 on malformed stored hash** (low) — wrap the bcrypt compare in try/catch → uniform 401.
- **No zod on `:id` param** (low) — `console.ts`: validate `z.string().cuid()` → 400, matching the
  login route's posture.

### Data minimization (design decision)
- **`lineUserId` exposed to all agents/browser** (info) — confirm the console needs the raw LINE id;
  if not, key on the internal cuid and omit it from responses.

## Confirmed correct (no action)
- LINE signature verification is correct and **fails closed**; raw-body bytes round-trip
  byte-identically for LINE's UTF-8 JSON, and the SDK compares in constant time.
- Login responds uniformly (now also constant-time); Prisma parameterizes all queries (no SQLi).
