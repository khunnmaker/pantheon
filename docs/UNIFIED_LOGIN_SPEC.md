# Unified suite login — implementation spec

Goal: the Pantheon portal login becomes THE login for the whole staff suite. Any app opened
logged-out auto-redirects to `pantheon.prominentdental.com/?redirect=<original URL>`; after
login the shared SSO cookie (already live, `pantheon_session`, `Domain=.prominentdental.com`)
signs the user in and the portal bounces them back to the exact URL they wanted. Every app's
local login stays in the tree as a fallback (`?local=1`, non-pantheon origins, bounce-loop
guard). ZERO api/ or database changes. Frontend-only.

Owner-approved design (2026-07-13): auto-redirect; keep local logins as hidden fallback.

## Hard rules

- Do NOT touch anything under `api/`, `diana/`, `mercury-local/`, `oa-sync-extension/`, `scripts/`, `docs/`.
- Do NOT touch `package.json`, `package-lock.json`, or any `Dockerfile` — no dependency changes.
  The `@pantheon/ui` workspace package is hoisted to root `node_modules` by `npm ci`, so every
  workspace app (venus included) already resolves it for tsc; vite needs only the resolve.alias.
- Do NOT git commit/push. Leave all changes as working-tree modifications. Do not commit this spec file either.
- Match each file's existing comment density, naming, Thai copy style, and Tailwind idiom.
- Keep every app's own icon + accent color exactly as-is (owner convention). No visual redesigns.
- Do NOT remove or restructure the existing local Login components — they are the kept fallback.

## New shared helper — `packages/pantheon-ui/src/sso.ts` (new file, export from `src/index.ts`)

Client-side helpers for the bounce to the central login. Written so every app uses identical logic:

```ts
export const PORTAL_URL_DEFAULT = 'https://pantheon.prominentdental.com';
const FLAG = 'pantheon-sso-bounce';
```

- `wantsLocalLogin(): boolean` — `new URLSearchParams(location.search).get('local') === '1'`.
- `isPantheonSite(): boolean` — `location.hostname === 'prominentdental.com' || location.hostname.endsWith('.prominentdental.com')`.
- `clearSsoBounce(): void` — remove FLAG from sessionStorage, in try/catch (storage can throw in private modes).
- `redirectToPortalLogin(portalUrl: string): boolean` — decides AND performs the bounce.
  Order of checks, each returning `false` (meaning: render the local login) when it trips:
  1. `wantsLocalLogin()` → false (escape hatch).
  2. `!isPantheonSite()` → false (raw `*.up.railway.app` origins can't receive the SameSite=Lax
     cookie — bouncing them would loop forever).
  3. FLAG already set in sessionStorage → `clearSsoBounce()` then false (we just came back from
     the portal still unauthenticated — show local login this load; a later fresh load may retry).
  4. Try `sessionStorage.setItem(FLAG, '1')`; if it throws → false (no storage = no loop
     protection = never bounce).
  5. `location.replace(portalUrl + '/?redirect=' + encodeURIComponent(location.href))` → true
     (caller keeps its boot spinner up — the page is navigating away).

## Portal — `pantheon/`

### `pantheon/src/lib/redirect.ts` (new)

- Import `APPS`, `AppDef` from `./apps`.
- Venus has deliberately NO portal tile (confidential, supervisor-only) but its login still flows
  through the portal, so build the allowlist as APPS + a venus entry:
  `{ key: 'venus', name: 'Venus', job: 'ลูกค้าสัมพันธ์ / CRM', url: import.meta.env.VITE_VENUS_URL ?? 'https://venus.prominentdental.com', accent: 'text-rose-600', badge: () => null }`.
  Export it as `REDIRECT_TARGETS: AppDef[]`. Add a comment explaining why venus is here but not a tile.
- `export interface RedirectTarget { app: AppDef; url: URL }`
- `export function resolveRedirect(search: string): RedirectTarget | null`:
  - read `redirect` param; absent → null.
  - `new URL(raw)` in try/catch → invalid → null.
  - protocol must be `https:`, OR `http:` only when hostname is `localhost`/`127.0.0.1` (dev).
  - find the target in REDIRECT_TARGETS whose configured `url` has the SAME `origin`
    (`new URL(a.url).origin === url.origin`, try/catch per entry, skip entries with no url).
    Match found → `{ app, url }`, else null. This is the open-redirect allowlist: we only ever
    navigate to origins that are literally configured app URLs.

### `pantheon/src/App.tsx`

- Compute the target ONCE: `const [target] = useState(() => resolveRedirect(location.search));`
- Add `const [denied, setDenied] = useState<AppDef | null>(null);`
- Add a `finishLogin(a: Agent): boolean` helper — returns true when it navigated away:
  - no target → `setAgent(a)`, false.
  - target and `hasAppAccess(a, target.app.key)` (import from `./lib/api`) →
    `location.replace(target.url.href)`, return true (leave the spinner up).
  - target but NO access → `setDenied(target.app); setAgent(a);` false (land on portal home
    with the notice — better than bouncing to an app that will 403).
- Bootstrap path: on a successful `bootstrap()` agent, run through `finishLogin` too — an
  already-signed-in user hitting `/?redirect=...` must bounce straight back without seeing the
  portal. If it navigated, do NOT `setBooting(false)` (keep the spinner while the browser leaves).
- `<Login onLogin={...}>` uses `finishLogin` as well, and gets a new `target={target?.app ?? null}` prop.
- Pass `denied` + `onDismissDenied={() => setDenied(null)}` to `<Portal>`.

### `pantheon/src/Login.tsx`

- New optional prop `target?: AppDef | null`.
- When present, render a destination chip between the header block and the picker: a small
  rounded-full pill, `inline-flex items-center gap-1.5`, using `target.accent` for the text color
  with a soft border (`border border-current/25`), white bg, text like
  `เข้าสู่ระบบเพื่อไป {target.name} · {target.job}` at `text-xs font-semibold`, centered.
  No new icon mapping — name + job + the app's accent color is enough (each deity keeps its own
  color; do not invent icons).

### `pantheon/src/Portal.tsx`

- New optional props `denied?: AppDef | null; onDismissDenied?: () => void`.
- When `denied` is set, render a dismissible amber notice card ABOVE the tile grid:
  `บัญชีนี้ไม่มีสิทธิ์เข้า {denied.name}` + smaller line `เลือกแอปที่เปิดได้จากด้านล่าง หรือติดต่อหัวหน้าเพื่อขอสิทธิ์`
  + an ✕ button calling `onDismissDenied`. Amber styling consistent with the app
  (e.g. `bg-amber-50 border border-amber-200 text-amber-800 rounded-xl`).
- Fix the stale comment "Phase 1: apps still ask for their own login when opened (SSO is Phase 3)"
  → apps now share the SSO cookie AND route their logged-out visitors here.

## Per-app flip — web, juno, vesta, ceres, jupiter (already have `bootstrap()` in App.tsx)

In each `<app>/src/App.tsx`:

- Add module-level `const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;`
  (import `PORTAL_URL_DEFAULT`, `redirectToPortalLogin`, `clearSsoBounce` from `@pantheon/ui`).
- Restructure the bootstrap effect from `.then(a => …).finally(setBooting(false))` to:
  ```ts
  bootstrap()
    .then((a) => {
      if (!alive) return;
      if (a) { clearSsoBounce(); setAgent(a); setBooting(false); return; }
      // No suite session. Bounce to the central Pantheon login unless a guard says local.
      if (redirectToPortalLogin(PORTAL_URL)) return; // navigating away — keep the boot spinner
      setBooting(false); // fallback: render this app's own login
    })
    .catch(() => { if (alive) setBooting(false); });
  ```
  (Do not keep `.finally` — `setBooting(false)` timing is now per-branch. Keep the `alive` flag pattern.)
- Nothing else changes: local `<Login>` still renders when `!agent` after booting; each app's own
  spinner styling stays; logout handlers stay.

## SSO catch-up + flip — venus, mercury (currently SSO-dark)

These two never got the suite SSO client pass. Bring each `src/lib/api.ts` up to the exact
pattern in `web/src/lib/api.ts` (copy the semantics + comments, adapt local naming):

- `login()` fetch gains `credentials: 'include'` (the response's Set-Cookie for the shared
  parent-domain cookie is otherwise discarded on cross-origin calls).
- Add `bootstrap(): Promise<Agent | null>` — GET `/api/auth/me` with `credentials: 'include'`,
  no Authorization header; on ok, store `{token, agent}` via the existing session setters and
  return the agent; any failure returns null. Mirror web's implementation.
- Add `logout(): Promise<void>` — POST `/api/auth/logout` with `credentials: 'include'` in a
  try/finally that always clears the local session (mirror web's).
- ONLY login/bootstrap/logout carry credentials — never any other call (CSRF-free design).

### `venus/src/App.tsx`
- Add the `booting` state + bootstrap effect + redirect logic exactly like the web pattern above
  (venus has none of it today). Boot spinner: match venus styling (rose accent on the existing
  gradient bg, `Loader2` spin like other apps).
- The forbidden-state "ออกจากระบบ" button currently only `clearSession()` — make it call the new
  suite `logout()` (fire-and-forget `void logout()`) then the existing state resets, so logging
  out of venus also ends the suite session (same convention as the other apps).
- Any other logout control in `venus/src/Venus.tsx` that clears the session: switch to suite
  `logout()` the same way.
- `venus/vite.config.ts`: add the `@pantheon/ui` resolve.alias exactly as in `web/vite.config.ts`
  (same comment block).

### `mercury/src/App.tsx`
- Same catch-up: add `booting` + bootstrap effect + redirect logic (module-level PORTAL_URL).
  Keep the existing per-grant gate exactly: after booting, `if (!agent || !hasAppAccess(agent,
  'mercury')) return <Login …>` stays as-is.
- Mercury's logout (in `Board.tsx` or wherever `onLogout` is wired): switch session-clear to the
  new suite `logout()` like the others.

## Copy style

Thai UI copy, short and polite, matching existing strings. The redirect spinner needs no new
text (each app just keeps its boot spinner). New strings:
- chip: `เข้าสู่ระบบเพื่อไป {name} · {job}`
- denied banner: `บัญชีนี้ไม่มีสิทธิ์เข้า {name}` / `เลือกแอปที่เปิดได้จากด้านล่าง หรือติดต่อหัวหน้าเพื่อขอสิทธิ์`

## Verification (run all, report results)

From the repo root (node_modules installed via `npm ci` — do NOT run npm install):

1. `npm run build --workspace=pantheon` — and likewise for `web`, `juno`, `vesta`, `ceres`,
   `jupiter`, `venus`, `mercury` (8 builds, all must exit 0). If a workspace name differs, find it
   in each app's package.json `name` field.
2. Grep-verify no `api/` file changed: `git status --short` shows only the intended frontend files.
3. Self-review the diff for: the loop-guard order of checks, `encodeURIComponent` on the redirect,
   origin-equality allowlist, spinner kept up when navigating, and that no state-changing fetch
   gained `credentials`.

Report: files changed, build results, and any deviation from this spec with reasoning.
