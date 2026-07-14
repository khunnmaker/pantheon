# Portal login: remember this device's recent users

Goal: the Pantheon portal login (now the suite's ONE login page) remembers which people log in
on this computer and offers them first. A returning user lands straight on THEIR credential
step (PIN/password input) instead of drilling L1 department → L2 name → L3 credential every
time. Shared shop computers remember up to 3 recent people. We remember WHO, never credentials.

Scope: portal only — `pantheon/src/Login.tsx` + one new lib file. Do NOT touch the apps'
local fallback logins, api/, package manifests, Dockerfiles. No commits.

## New file — `pantheon/src/lib/remembered.ts`

localStorage-backed list of recent logins on this device. Display shortcut only — the stored
record is just the email + timestamp; the Person (name/avatar/cred kind) is re-resolved from
the roster at read time so renames/removals stay fresh and nothing stale is shown.

```ts
const KEY = 'pantheon_remembered_logins';
const MAX = 3;
export interface RememberedLogin { email: string; lastUsedAt: number }
```

- `getRemembered(): RememberedLogin[]` — parse from localStorage in try/catch; validate it's an
  array of objects with a string `email`; anything malformed → `[]`. Sorted most-recent-first
  (sort on read; trust but verify).
- `rememberLogin(email: string): void` — upsert to the FRONT with `Date.now()`, dedupe by email,
  cap at MAX, write back (try/catch — storage full/unavailable is non-fatal).
- `forgetLogin(email: string): void` — remove the entry, write back (try/catch).
- `pruneRemembered(valid: (email: string) => boolean): RememberedLogin[]` — drop entries the
  predicate rejects, write back if anything was dropped, return the kept list. (Login.tsx uses
  this with a roster lookup so people removed from the roster silently disappear.)

## `pantheon/src/Login.tsx` changes

Resolve helper (module scope): find a roster Person + its RoleGroup by email —
`ROLE_GROUPS.flatMap(g => g.members.map(p => ({ p, g })))` lookup, excluding `comingSoon`/empty
emails. Used both to render remembered tiles and to preset the drill-down.

State additions:
- `remembered` — resolved list `{ person, group }[]`, computed once on mount via
  `pruneRemembered(email => rosterHas(email))` then mapped. useState initializer, no effect.
- `showAll: boolean` — false initially; true = user asked for the full department picker.
- `fromRecent: boolean` — the current L3 was reached via the remembered shortcut (controls back).

Initial view logic (the whole point):
- If `remembered.length >= 1` on mount, PRESET the most recent person: `selectedGroupId =
  their group id`, `selectedEmail = their email`, `fromRecent = true` — the page opens directly
  on L3: their department-colored banner + avatar + PIN/password input, ?redirect chip still
  above. Zero taps for the device's usual user.
- Back button from a `fromRecent` L3 → the RECENT panel (clear selection, `fromRecent = false`),
  NOT L2. Back behavior on the normal drill-down path is unchanged.
- The RECENT panel replaces the department grid at root while `remembered.length > 0 && !showAll`:
  - small label row: `ล่าสุดบนเครื่องนี้` (text-xs font-semibold text-slate-500, mb-2)
  - 2-col grid of the remembered people as tiles — reuse the existing `PersonTile` look (slate
    tile, avatar, name). Each tile also gets a small ✕ (top-left, `stopPropagation`, subtle
    white/60 hover white) that calls `forgetLogin(email)` + drops it from state (falling back
    to the department grid if the list empties). aria-label="ลบออกจากเครื่องนี้".
    Tapping the tile itself → preset that person's L3 with `fromRecent = true`.
  - below the grid a full-width quiet button: `เลือกจากรายชื่อทั้งหมด` (text-xs slate-400
    hover:slate-600, like the existing minor buttons) → `setShowAll(true)` → department grid.
  - From the department grid, when remembered exists, back at root returns to the recent panel
    (`setShowAll(false)`) — add a BackButton at the grid root ONLY in that case (root today has
    no back button; keep it absent when there are no remembered logins).
- On SUCCESSFUL login (in `submit`, after `login()` resolves, before/alongside `onLogin`):
  `rememberLogin(person.email)`. Never store the secret; never remember on FAILED attempts.

Keep: the ?redirect destination chip, the Metro visual language, each level's existing styling,
the auto-submit PIN behavior, autoFocus on the credential input (works for the preset L3 too),
error handling, and the existing comment density/style. The comingSoon tile stays only in the
normal L2 flow (a comingSoon person can never be remembered — no email, can't log in).

Edge cases:
- Remembered email no longer in roster (staff change) → pruned silently on mount.
- localStorage unavailable (private mode) → everything degrades to today's behavior.
- Two people on one device → most recent opens at L3; back reveals both tiles.
- `?redirect` present → unchanged: chip shows, post-login redirect logic untouched (App.tsx's
  finishLogin is not modified by this feature).

## Verification

1. `npm run build --workspace=./pantheon` exits 0.
2. `git status --short` → only pantheon/src/Login.tsx modified + pantheon/src/lib/remembered.ts new.
3. Self-review: no credential ever written to storage; back-stack behavior (fromRecent L3 → recent
   panel; normal L3 → L2); prune writes back; MAX=3 enforced on write.

Report files changed, build result, deviations.
