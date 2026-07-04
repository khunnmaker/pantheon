# Jupiter — deploy & ops runbook (owner, no-code)

Jupiter is the **staff portal** built INTO the Minerva monorepo (`jupiter/`). One login, then a
tile per app the person's role may enter, each tile showing a live pending-work badge. Phase 1
ships on today's Railway URLs with today's login (localStorage-JWT); there is **no SSO yet**
(each app still asks for its own login when opened). See `docs/JUPITER_BRIEF.md` for the spec.

This runbook covers two owner tasks, both **no-code**:
- **Part 1 — Phase 1 go-live:** stand up the new `jupiter/` Railway service + wire env vars.
- **Part 2 — Phase 2 domains:** point `prominentdental.com` subdomains at the Railway services.

Do them in order. Part 1 works entirely on the existing `*.up.railway.app` URLs — you do NOT
need any DNS to launch the portal. Part 2 is a later, independent step.

---

## What was built (Phase 1)

- **API** (`api/src/routes/jupiter.ts`): `GET /api/jupiter/badges` — any authenticated account;
  returns pending-work counts ONLY for the apps the caller's role may enter (agents see Minerva;
  the supervisor sees Minerva/Juno/Vulcan/Ceres; messenger + md see Ceres). ~30s in-process cache
  (the Ceres messenger badge, being per-user, is cached per messenger). No schema change, no migration.
  Ceres `awaitingAction` per role: **CEO** = escalated payment requests awaiting the CEO's decision;
  **MD** = pending expenses awaiting her approve/reject; **messenger** = their own pending drafts +
  rejected expenses to fix.
- **Portal web app** (`jupiter/`): a separate Vite/React app + Dockerfile — its own Railway web
  service, mirroring Juno/Vulcan. Royal-purple theme. Suite-standard login (tap a name → password
  for Dr. M and Nee/MD, 6-digit PIN for everyone else; the 13 messengers collapse under
  "ทีมแมสเซนเจอร์"). After login, a tile grid opens each app's URL in the same tab.
- **Portal-back link** in `web/` (Minerva), `vulcan/`, `juno/`, and `ceres/`: one small header link
  back to the portal, URL from `VITE_PORTAL_URL`, **hidden when that env is unset** — so it is
  completely inert until you configure it.

---

## Part 1 — Phase 1 go-live (Railway, on existing URLs)

### 1a. New Railway service for the portal

Add ONE new web service for `jupiter/` alongside the existing `api` / `web` / `vulcan` / `juno`
/ `ceres` / `diana` / Postgres:

1. **New service → Deploy from repo → root directory `jupiter/`** (Dockerfile at `jupiter/Dockerfile`).
2. Set these **build-time env vars / build args** (baked into the static bundle at build — same
   model as `web` / `juno` / `vulcan`). Use each service's current public Railway URL:

   | Var | Value (Phase 1) | Meaning |
   |---|---|---|
   | `VITE_API_URL`    | the **api** service's public URL | login + badges endpoint |
   | `VITE_MINERVA_URL`| the **web** (Minerva) service's URL | Minerva tile target |
   | `VITE_JUNO_URL`   | the **juno** service's URL | Juno tile target |
   | `VITE_VULCAN_URL` | the **vulcan** service's URL | Vulcan tile target |
   | `VITE_CERES_URL`  | the **ceres** service's URL | Ceres tile target (messenger/md/CEO) |

   A tile whose URL is unset is hidden even for a role that could enter it — so leaving any
   `VITE_*_URL` blank keeps that app off the portal until it ships.

3. **Allow the portal's origin on the api.** Append the new Jupiter web origin to the api's
   **`WEB_ORIGIN`** env (comma-separated, exact origins, no trailing slash), keeping the existing
   console / Vulcan / Juno / Diana origins. Without this, the browser's login + badges calls fail CORS.
4. Jupiter shares the same Postgres **via the api** — it does **not** need its own `DATABASE_URL`
   and must **not** run any Prisma migrate (Minerva's api remains the sole migrator).
5. Push to `main` (once this branch is merged) → services redeploy. The badges route ships with the api.

### 1b. Configure the portal-back link in the other apps (optional, do once ready)

For **each** of `web`, `juno`, `vulcan`, `ceres`, set the build-time env **`VITE_PORTAL_URL`** =
the Jupiter service's public URL, then redeploy that service. The little "พอร์ทัล" link appears
in that app's header. Leave it unset on any app you don't want linking yet — the link stays hidden.

### 1c. Verify after deploy

1. Open the Jupiter URL → the login shows the people cards (Dr. M on top; messengers collapsed).
2. Log in as **Dr. M** → tiles for Juno / Minerva / Vulcan / Ceres appear, each with its badge count.
3. Log in as an **agent** (their 6-digit PIN) → only the **Minerva** tile appears, with its
   "waiting to reply" count. Confirm NO Juno/Vulcan/Ceres tile leaks for the agent.
4. Log in as **Nee (MD)** (password) or a **messenger** (PIN) → only the **Ceres** tile appears,
   with its awaiting-action count; confirm no other app's tile leaks.
5. Tap a tile → the app opens (and, in Phase 1, asks for its own login — expected until SSO/Phase 3).
6. If you set `VITE_PORTAL_URL`, confirm the "พอร์ทัล" link shows in that app's header and returns here.

---

## Part 2 — Phase 2 domains (GoDaddy + Railway, no code)

Move the suite onto `*.prominentdental.com` subdomains. The **bare `prominentdental.com` is left
untouched** (it keeps serving the current GoDaddy site until Diana replaces it). Do this per
service; nothing here changes application code.

### 2a. Railway: add a custom domain to each service

In Railway, for each service, add its custom domain and copy the **CNAME target** Railway shows:

| Service | Custom domain to add |
|---|---|
| jupiter | `portal.prominentdental.com` |
| web (Minerva) | `minerva.prominentdental.com` |
| vulcan | `vulcan.prominentdental.com` |
| juno | `juno.prominentdental.com` |
| ceres *(when live)* | `ceres.prominentdental.com` |
| api | `api.prominentdental.com` |

### 2b. GoDaddy: add the CNAMEs

In GoDaddy DNS for `prominentdental.com`, add one **CNAME** record per subdomain, each pointing
at the matching Railway target from 2a:

| Host / Name | Type | Points to |
|---|---|---|
| `portal`  | CNAME | *(jupiter Railway target)* |
| `minerva` | CNAME | *(web Railway target)* |
| `vulcan`  | CNAME | *(vulcan Railway target)* |
| `juno`    | CNAME | *(juno Railway target)* |
| `ceres`   | CNAME | *(ceres Railway target, when live)* |
| `api`     | CNAME | *(api Railway target)* |

Do **not** touch the bare `@` / `www` records — the marketing site keeps working. Wait for DNS to
propagate and for Railway to show each domain as "Active" (TLS issued) before the next step.

### 2c. Add the new origins to the api's `WEB_ORIGIN` (keep the old ones)

**Append** the new HTTPS origins to the api's `WEB_ORIGIN` — do **not** replace the existing
Railway origins yet. Keeping both means the apps work whether opened on the old URL or the new
domain during the cutover:

```
https://console-...up.railway.app,https://vulcan-...up.railway.app,https://juno-...up.railway.app,https://portal.prominentdental.com,https://minerva.prominentdental.com,https://vulcan.prominentdental.com,https://juno.prominentdental.com
```

(Exact origins, comma-separated, no trailing slash, no wildcard.) Add `https://ceres.prominentdental.com`
when Ceres ships. Once every app has been verified on its custom domain, you may later trim the
old Railway origins.

### 2d. Flip each frontend's `VITE_API_URL` to the api's domain

For **each** frontend service (`jupiter`, `web`, `vulcan`, `juno`, and `ceres` when live), set the
build-time **`VITE_API_URL`** = `https://api.prominentdental.com` and redeploy that service.

### 2e. Point each app's tiles + portal-back link at the new domains

- On the **jupiter** service, set the tile URLs to the new domains and redeploy:
  `VITE_MINERVA_URL=https://minerva.prominentdental.com`,
  `VITE_JUNO_URL=https://juno.prominentdental.com`,
  `VITE_VULCAN_URL=https://vulcan.prominentdental.com`
  (and `VITE_CERES_URL=https://ceres.prominentdental.com`).
- On **web / juno / vulcan / ceres**, set
  `VITE_PORTAL_URL=https://portal.prominentdental.com` and redeploy.

### 2f. Verify

1. `https://portal.prominentdental.com` loads and logs in.
2. From the portal, each tile opens the app on its `*.prominentdental.com` domain.
3. Each app's header "พอร์ทัล" link returns to `portal.prominentdental.com`.
4. No CORS errors in the browser console (the new origins are in `WEB_ORIGIN`).
5. The bare `prominentdental.com` still serves the old GoDaddy site (untouched).

> Phase 3 (SSO — one login across every app, no re-typing PINs) is a **later code change**
> (`COOKIE_DOMAIN` + cookie issue/accept + CSRF header + `GET /api/auth/me` bootstrap). It is NOT
> part of this runbook and must not be enabled until it ships. See `docs/JUPITER_BRIEF.md` §4 & §7.
