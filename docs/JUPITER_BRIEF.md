> ⚠️ 2026-07 UPDATE: the portal this document describes was split out to the `pantheon/` app (pantheon.prominentdental.com). `jupiter/` is now the ACCOUNTING app (jupiter.prominentdental.com); portal.prominentdental.com no longer exists. Kept for history.

# Jupiter — staff portal + SSO + suite connectivity (build brief)

> Handoff brief for a fresh session. Written 2026-07-04 after a grilled requirements session with the owner (Dr. M / CEO). Read this whole file before writing code. Companion docs: `docs/VESTA_BRIEF.md`, `docs/JUNO_BRIEF.md`, `docs/CERES_BRIEF.md` (same suite, same conventions).

## 1. What Jupiter is

**Jupiter is the king of the deities: the internal landing page the whole team opens first, and the owner of everything that connects the apps to each other.** Concretely, three jobs:

1. **Portal (landing page)** — one page at `portal.prominentdental.com`: log in once, see only the apps your role allows, each app button shows a live pending-work badge.
2. **SSO** — that one login works across every deity (Minerva, Vesta, Juno, Ceres). No re-typing PINs per app.
3. **Connectivity steward** — Jupiter's docs own the suite map (which service lives at which domain, which envs bind them together: `WEB_ORIGIN`, `VITE_API_URL`, cookie domain). Cross-app navigation (a small "Jupiter" home link in every deity's header) also lands here.

**Explicitly NOT Jupiter:** public marketing content (that is Diana, the future B2B site on the bare `prominentdental.com`), KPI dashboards duplicating deity screens, notifications.

4. **Staff admin (added by owner decision 2026-07-04, superseding the earlier "no new role or permission" line)** — Jupiter owns the CEO-only screen where staff's **app grants** are edited (see §3a): change what someone can open with a click, no env edit, no redeploy.

## 2. Owner decisions (grilled 2026-07-04 — all four were the recommended options)

| Decision | Choice |
|---|---|
| Audience | **Internal staff portal only** — no public content |
| Connectivity | **Full SSO via Jupiter** — one login, every allowed app opens without asking again; ALL account types included (supervisor, 3 agents, md, 13 Ceres messengers — they already share one `Agent` table + one JWT system) |
| Portal depth | **Launcher + live badges** — pending counts per app; no KPIs |
| Domains | **Subdomains of `prominentdental.com`** (portal. / minerva. / vesta. / juno. / ceres. / api.) via GoDaddy CNAME → Railway custom domains. The bare domain keeps serving the old GoDaddy site until Diana replaces it. |

Defaults accepted with the brief: cookie-based SSO with a CSRF header guard; each deity's own login screen stays as a fallback; brief-then-build (this doc) matches the Juno/Ceres pattern.

## 3. The suite today (context you must not break)

Monorepo `github.com/khunnmaker/minerva`, `main` auto-deploys on Railway. One Postgres, one Prisma schema, **Minerva's `api/` is the sole migrator, migrations are ADD-only**. Frontends are separate static Vite+React+Tailwind bundles served by `serve`, each its own Railway service pointing at the api via `VITE_API_URL`; the api allows their origins via `WEB_ORIGIN` (comma list, exact origins).

| Deity | Job | Frontend | Who may enter (today's route gates) |
|---|---|---|---|
| Minerva | LINE sales console (LIVE, real customers) | `web/` | agents + supervisor |
| Vesta | stock management | `vesta/` | supervisor only |
| Juno | income/finance (slips, RE, bank recon) | `juno/` | supervisor only |
| Ceres | expenses/petty cash (merged PR #5, inert until envs) | `ceres/` | messengers + md (+ CEO = supervisor) |
| Diana | public B2B site (planned) | — | public |
| **Jupiter** | **portal + SSO (this brief)** | **`jupiter/`** | **every authenticated account** |

### 3a. Auth model — UNIFIED (owner decision 2026-07-04; implemented on branch `unified-auth`)

The per-app credential sprawl is gone. Three tiers, three env credentials, per-person app grants:

| Tier (`Agent.role`) | Who | Credential env | Access |
|---|---|---|---|
| `supervisor` | Dr. M | `SEED_PASSWORD` (password) | everything, implicit |
| `md` | Nee (`md@prominent.local`) | `MD_PASSWORD` (password; `CERES_MD_PASSWORD` accepted as deprecated fallback) | Ceres management, implicit |
| `staff` | all 15 staff — sales (nadeer/anny/noey) + couriers (ta/arm/man/boonson/kaew/lungko/wong/paeng/nun/pin/da) + housekeeper (lekmaeban); emails `<slug>@prominent.local` | ONE var `STAFF_PINS` = `slug:6digitpin,…` (parsed by `parsePinMap`; `EMPLOYEE_PINS`/`AGENT_PINS`/`STAFF_PASSWORD` are deprecated fallbacks during transition) | per-person `Agent.apps String[]` grants ⊆ {minerva, vesta, juno, ceres} |

- Legacy roles `agent`/`messenger`/`employee` are retired (tokens carrying them are still verified; the live row decides). **นี in the old messenger list IS Nee the MD** — she has no staff row.
- `hasAppAccess(agent, app)` + `requireApp(app)` in `api/src/auth/middleware.ts` are the gate: Minerva console routes require the `minerva` grant; Ceres self-entry requires `ceres`; Vesta/Juno remain `requireRole('supervisor')`.
- **Boot-sync seeds `apps` only on CREATE and never overwrites it** — `Agent.apps` is Jupiter's admin surface: the CEO-only staff-admin screen (job 4, §1) edits it live. Default grants: everyone → `ceres`; sales → `+minerva`.
- PUBLIC `GET /api/auth/logins?app=minerva|ceres` returns the ordered login-card list `[{email, name, kind: 'password'|'pin'}]` for that app's login screen (`GET /api/ceres/logins` is an alias for app=ceres). Jupiter's own login page should extend this endpoint with an all-accounts variant (supervisor + md + every staff member) — a ~5-line addition to `api/src/auth/loginCards.ts`, part of the Jupiter build.
- Everything else stands: JWT ~12h in localStorage as `Authorization: Bearer`, `requireAuth` + the Socket.IO handshake **re-validate the Agent row (existence + role, now + apps) on every request** — keep that property. Login rate limit 10/5min/IP; Fastify `trustProxy: true`.

**Login-screen layout standard (owner-approved, suite-wide):** a card list of people — supervisor on top, team beneath — with NO credential box until a name is tapped; then password (Dr. M) or masked auto-submit 6-digit PIN (everyone else) appears under the selected card. See `web/src/Login.tsx` for the reference implementation. Jupiter's login MUST follow it. With ~18 accounts (Dr. M, NaDeer, Anny, Noey, Nee, 13 messengers) a flat list gets long — group the messengers under a collapsible "ทีมแมสเซนเจอร์" section; supervisor/agents/md stay as top-level cards.

## 4. SSO design (the core engineering)

Transport changes; **authorization does not**. Every existing per-route role gate stays exactly as is.

- **Cookie**: on login, api ALSO sets the JWT in a cookie — `HttpOnly; Secure; SameSite=Lax; Domain=<COOKIE_DOMAIN env, e.g. .prominentdental.com>; Max-Age` matching the JWT TTL. New env `COOKIE_DOMAIN`; when unset (today, Railway URLs), no cookie is set and everything behaves as now — **transition-safe by default**.
- **Token acceptance**: `requireAuth` and the Socket.IO handshake accept the token from `Authorization: Bearer` (wins if present) OR the cookie. Live Agent-row revalidation applies to both paths.
- **CSRF guard (MUST, because cookies auth silently)**: cookie-authenticated **state-changing** requests require a custom header (e.g. `X-Prominent-Client: 1`) that all frontends send on every fetch. Cross-site pages cannot add custom headers without passing CORS preflight, and CORS stays locked to the exact `WEB_ORIGIN` list with `credentials: true` — never a wildcard. Bearer-authenticated requests are exempt (header auth is not CSRF-able).
- **App bootstrap**: each frontend, when it has no localStorage token, calls `GET /api/auth/me` with `credentials: 'include'`. Cookie session → returns `{ name, role }`, app proceeds (keep using cookie auth; do not mint a second token). No session → the app's own login screen as today (fallback stays forever — it is also the dev-mode path).
- **Logout**: portal logout = `POST /api/auth/logout` clears the cookie server-side; per-app logout keeps clearing localStorage AND calls the same endpoint.
- **Reality constraint**: the cookie only crosses apps once the subdomains exist. Phase it (see §7) — do not block the portal on DNS.

## 5. Badges endpoint

`GET /api/jupiter/badges` (any authenticated account) → counts ONLY for the apps the caller's role can enter, e.g.:

```json
{ "minerva": { "pending": 3 }, "juno": { "toVerify": 5 }, "vesta": { "lowStock": 2 }, "ceres": { "awaitingApproval": 1 } }
```

Suggested definitions — **verify each against the actual Prisma schema before implementing; do not trust this doc's field names**:
- **Minerva**: conversations awaiting a reply (customers whose latest message is unanswered / has an unsent draft).
- **Juno**: `Payment` rows in status `received` (not yet verified).
- **Vesta**: products at/below their reorder point.
- **Ceres**: for CEO → expenses awaiting CEO approval; for md → her pending queue; for a messenger → their own drafts/rejections.

One endpoint, a handful of indexed `count()` queries; an in-process cache of ~30s is fine. Never leak a count for an app the caller cannot open.

## 6. Portal frontend (`jupiter/`)

- Vite+React+Tailwind, Thai UI, **mobile-first** (messengers are on phones). Own Railway service (root `jupiter/`, `VITE_API_URL`). Suggested theme: royal purple/violet — distinct from sky (Minerva), indigo (Vesta), emerald (Juno), and Ceres' theme.
- After login: a tile grid — one tile per allowed app, deity name + Thai job label + badge count, opening the app's URL (same tab). Tile order: most-used first for that role.
- App URLs come from build-time env (e.g. `VITE_APP_URLS` JSON or individual vars) so the Railway→custom-domain cutover is an env edit, not a code change.
- Every other deity adds one small header link back to the portal (env-driven URL, hidden when unset). Keep it to a line or two per app.

## 7. Phasing (build in this order — each phase ships alone)

1. **Phase 1 — portal + badges, no SSO**: `jupiter/` frontend with its own login (existing auth), `/api/jupiter/badges`, tile grid. Works on today's Railway URLs immediately. Apps still ask for their own login when opened.
2. **Phase 2 — domains (OWNER runbook, no code)**: Railway custom domains per service; GoDaddy CNAMEs `portal`/`minerva`/`vesta`/`juno`/`ceres`/`api` → the Railway targets; append the new origins to `WEB_ORIGIN` (keep the old Railway origins during transition); flip each frontend's `VITE_API_URL` to `https://api.prominentdental.com`. Bare domain untouched.
3. **Phase 3 — SSO**: `COOKIE_DOMAIN` env + cookie issue/accept/logout + CSRF header + `GET /api/auth/me` bootstrap in all four apps + portal becomes the single door. Smoke: log in at portal as an agent → open Minerva → no login prompt; messenger sees only Ceres; logout at portal kills every app.

## 8. Security constraints (carry-overs, non-negotiable)

- **Never log PINs**; Dr. M is NEVER eligible for a PIN (password via `SEED_PASSWORD` only).
- `SEED_PASSWORD` was rotated ~2026-07-03 — old transcript passwords are dead. **Automated probes use the agent login only; never ask the owner to paste a password into chat.**
- Cookie is `HttpOnly` (JS never reads it); CORS stays an exact-origin allowlist with credentials — no wildcard, ever.
- The CSRF header guard in §4 is required BEFORE cookie auth is accepted on any state-changing route — do not ship them separately.
- Keep the live Agent-row revalidation on both token paths; keep the login rate limit and `trustProxy`.

## 9. Build protocol & open items

- Build via **/delegate** (Fable specs + reviews hunk-by-hunk, Sonnet executes) per the standing rule; use an isolated git worktree (junction node_modules; unlink junctions link-only BEFORE any recursive delete); commit with Bash `git commit -F <file>` (PowerShell here-strings break on embedded quotes).
- Multiple sessions work this repo concurrently — expect `main` to move mid-build; rebase, don't force-push.
- Open items for the build session to confirm with the owner: exact badge definitions (§5), messenger grouping UI (§3), whether portal tiles should deep-link (e.g. Juno tile → straight to the verify queue) — nice-to-have, not required.
