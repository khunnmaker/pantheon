# Ceres — deploy runbook (Railway)

> Ceres is the expense/petty-cash deity (money OUT; Juno is money IN). Backend routes live
> in the shared Minerva `api/` service; the `ceres/` static frontend is portal-only by default.
> Pantheon authenticates the suite Agent and redirects back to Ceres; Ceres authorization is
> controlled by the live Agent role/grants, not by a separate Ceres credential source.

## 0. What merging to `main` already does

The api Docker image runs `npx prisma migrate deploy` on every boot, so the Ceres migration
(`20260705000000_ceres`, ADD-only — 13 new tables, nothing existing touched) applies
automatically on the first api deploy after merge. Boot seeding (`ensureCeres`) then fills
the cash accounts, the 13 messenger parties + 4 carrier buckets, and the starter category
list — each only when its table is empty.

## 1. Env vars on the EXISTING api service (add before/with the merge)

> **Auth is UNIFIED suite-wide (owner decision 2026-07-04)** — one credential scheme covers
> Minerva, Vesta, Juno, Ceres and the Pantheon portal. See docs/JUPITER_BRIEF.md §3a.

| Var | Value |
|---|---|
| `GM_PASSWORD` | Nee's GM login password (login email remains `md@prominent.local`). `MD_PASSWORD` is accepted as a fallback, so the existing Railway variable may remain untouched during rollout. |
| `EMPLOYEE_PINS` | **One var for all EMPLOYEES slugs**, including `nun`, `poopae`, `win`, and `mail` — **exactly 6 digits per PIN** (non-6-digit entries skipped with a warning; weak PINs like 123456 warned). Someone missing from the list simply can't log in yet, and stale-account pruning stays disabled until everyone listed is provisioned, so adding the three Central Office accounts is safe before their Railway PINs exist. |
| `CEO_LINE_USER_ID` | optional, suite-wide — the CEO's LINE userId for escalation pushes from the Prominent OA. To find it: message the OA from the personal account, then read the `Customer.lineUserId` of that chat (console or DB). Leave unset to disable pushes (escalations still appear in the CEO tab). |
| `CERES_FLOOR` | optional, default `40000` (top-up trigger) |
| `CERES_CEO_THRESHOLD` | optional, default `5000` (mandatory CEO pre-approval above this) |
| `CERES_LOCAL_LOGIN_ENABLED` | compatibility-window flag, default `true`. While enabled, `GET /api/ceres/logins` supports the explicit Ceres `?local=1` break-glass login. Set to `false` after one observed portal-only release; disabled returns 404. This does not affect `/api/auth/login`, bearer tokens, or shared cookies. |

Slug → person: nadeer NaDeer · anny Anny · noey Noey (sales — Minerva + Ceres) · ta ต้า ·
arm อาร์ม · man แมน · boonson บุญสอน · kaew แก้ว · lungko ลุงโก๊ะ · wong วง · paeng แป๋ง ·
nun นุ่น · pin พิณ · da ด้า (couriers — Ceres) · lekmaeban เล็กแม่บ้าน (housekeeper — Ceres).
**นี is Nee the GM — she logs in with `GM_PASSWORD` (`MD_PASSWORD` fallback), not a PIN.** The CEO logs in with the
existing Dr. M supervisor account — no new login. What each employee can open is a per-person
grant list (`Agent.apps`), edited later in Jupiter's admin screen — position changes never
touch env vars again.

### Ceres access and SSO

- `supervisor` and `gm` Agents have implicit Ceres access. `central` and `employee` Agents need
  `ceres` in `Agent.apps`.
- A logged-out Ceres entry tries the shared suite cookie, then redirects to Pantheon with
  `?redirect=<complete-ceres-url>`. Ceres account cards never appear on the normal path.
- `?local=1` is the rollback-only local central-login path. It uses the same Agent credentials
  and `/api/auth/login`; it is not a second credential system.
- Invalid or expired authentication receives 401. A live authenticated Agent without Ceres
  access receives 403 so Pantheon can show access denied.
- Existing bearer tokens and valid shared cookies continue until their normal expiry. Do not
  revoke sessions as part of this cutover.

## 2. New Railway service: `ceres`

Same recipe as Juno/Vesta:
1. New service from the same GitHub repo; **Root Directory = `ceres`** (it has its own Dockerfile).
2. Build args / service variables:
   - `VITE_API_URL = https://<the api service domain>`
   - `VITE_PORTAL_URL = https://<the Pantheon portal domain>`
3. Generate a domain for the service (e.g. `ceres-….up.railway.app`).
4. On the **api** service, append that domain to `WEB_ORIGIN` (comma-separated) — CORS.
5. Redeploy api (env change), deploy ceres.

## 3. Portal-only SSO cutover

### A. Pre-cutover readiness audit

From `api/`, run:

```sh
npm run ceres:sso-readiness
```

The command is read-only, prints counts and identifiers only, and exits non-zero when it finds
any of the following: an active person party without a live Agent or Ceres access; a canonical
target account that is missing or lacks its grant/implicit access; an employee/Central Office requester or
other granted staff account without an active email-linked `CeresParty`; duplicate active party
links for one email; or a historical expense whose referenced party row no longer exists.

Repair grants and party links additively, rerun until green, then confirm the production Ceres
origin, shared-cookie domain, and representative supervisor, GM, Central Office, employee, and original
messenger portal round trips. Never copy credential values into the audit or deployment log.

### B. Compatibility release (default for this phase)

1. Deploy the API with `CERES_LOCAL_LOGIN_ENABLED=true` (its default).
2. Deploy the new Ceres frontend. Normal logged-out entry now redirects through Pantheon;
   `?local=1` and `/api/ceres/logins` remain available for the observation window.
3. Do not revoke existing bearer tokens/cookies and do not change Agent or CeresParty IDs.
4. Observe successful target-account sign-ins without logging PINs, passwords, tokens, or cookies.
5. After one successful release window, set `CERES_LOCAL_LOGIN_ENABLED=false` and redeploy only
   the API. Final removal of `/api/ceres/logins` and `Login.tsx` belongs to a later release.

### C. Rollback

Rollback is configuration/frontend-only:

1. Set `CERES_LOCAL_LOGIN_ENABLED=true` to restore the `?local=1` compatibility card list, or
   redeploy the previous Ceres frontend if the portal redirect itself must be reverted.
2. Keep central `/api/auth/login`, existing Agent credentials/grants, bearer auth, shared cookies,
   `CeresParty` mappings, and historical party snapshots unchanged.
3. No database rollback is needed. Do not restore `CERES_MESSENGER_PINS`; `EMPLOYEE_PINS` remains
   the suite-wide staff credential source.
4. If shared-cookie configuration is the fault, `?local=1` obtains a normal bearer token through
   central auth while SSO is repaired.

## 4. Smoke test (in order)

1. MD login (`md@prominent.local`) → กระดาน shows the (empty) board.
2. **Opening balance** (fresh-start decision): Nee counts the physical box, enters it via
   เบิก/คืน → ฝากเข้ากล่อง. The box balance now reflects reality.
3. Messenger phone: pick name → PIN → บันทึกค่าใช้จ่าย → photo → OCR prefills → submit.
4. MD: รอตรวจ shows it (OCR mismatch badge if amounts differ) → อนุมัติ → board's
   เงินทอนที่ควรได้คืน updates → ปิดยอด works (blocked while anything is รอตรวจ).
5. MD: จ่ายเงิน → small request ≤5,000 to a normal payee → expect instant AI verdict;
   a >5,000 request → escalates; CEO tab (Dr. M login) → อนุมัติ; only then จ่ายแล้ว unlocks.
   If `CEO_LINE_USER_ID` is set, the escalation also pings LINE.
6. กระทบยอด: upload a fresh KBIZ export of the **expense** account → preview counts look
   right → นำเข้า → paid requests auto-match.

## 5. Cutover from the GAS app (ระบบค่าใช้จ่าย MSG)

- Announce the switch; messengers start entering in Ceres on day 1 after the opening
  balance is set. Old sheets stay read-only archive (fresh-start decision — no import).
- **Security: the GAS webapp has a hardcoded admin password (`prom5951`) that has also been
  shared in chat. Disable the GAS deployment (or at minimum rotate that password) at
  cutover.**

## 6. Coordination note — shared KBIZ parser

`api/src/bank/` (csv.ts, parseKbiz.ts, fixtures, checkBankParsers.ts) is built to the Juno
Phase B format spec and validated against a real export. The Juno workstream has its own
copy on branch `juno-recon`: **whichever branch merges second must drop its own copy and
adopt the parser already on main** (both were validated against the same real file; the
interfaces are per the same spec). K SHOP parsing belongs to Juno and is not in this tree.

## 7. Ops notes

- Receipt photos + archived statements live under the api volume (`UPLOAD_DIR/ceres/…`) —
  same persistence story as customer images.
- Verification bundle (run in `api/`): `npm run typecheck && npm test && npm run
  ceres:sso-readiness`; in `ceres/`: `npm run typecheck && npm run build`.
- Weekly physical cross-check: CEO tab → ชุดตรวจสอบรายสัปดาห์ → five CSVs (expenses,
  movements, requests, AI reviews, statement lines) for the paper reconciliation.
