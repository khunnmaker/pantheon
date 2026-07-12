# Ceres — deploy runbook (Railway)

> Ceres is the expense/petty-cash deity (money OUT; Juno is money IN). Backend routes live
> in the shared Minerva `api/` service; this doc adds the `ceres/` static frontend as its
> own Railway service and provisions the new logins. See docs/CERES_BRIEF.md for the product.

## 0. What merging to `main` already does

The api Docker image runs `npx prisma migrate deploy` on every boot, so the Ceres migration
(`20260705000000_ceres`, ADD-only — 13 new tables, nothing existing touched) applies
automatically on the first api deploy after merge. Boot seeding (`ensureCeres`) then fills
the cash accounts, the 13 messenger parties + 4 carrier buckets, and the starter category
list — each only when its table is empty.

## 1. Env vars on the EXISTING api service (add before/with the merge)

> **Auth is UNIFIED suite-wide (owner decision 2026-07-04)** — one credential scheme covers
> Minerva, Vulcan, Juno, Ceres and the Pantheon portal. See docs/JUPITER_BRIEF.md §3a.

| Var | Value |
|---|---|
| `MD_PASSWORD` | Nee's login password (login email: `md@prominent.local`). The old name `CERES_MD_PASSWORD` still works as a deprecated fallback. |
| `EMPLOYEE_PINS` | **One var for ALL 15 employees** — sales + couriers + housekeeper: `nadeer:XXXXXX,anny:XXXXXX,noey:XXXXXX,ta:XXXXXX,arm:XXXXXX,man:XXXXXX,boonson:XXXXXX,kaew:XXXXXX,lungko:XXXXXX,wong:XXXXXX,paeng:XXXXXX,nun:XXXXXX,pin:XXXXXX,lekmaeban:XXXXXX,da:XXXXXX` — **exactly 6 digits per PIN** (non-6-digit entries skipped with a warning; weak PINs like 123456 warned). Someone missing from the list simply can't log in yet, and the stale-account prune stays disabled until everyone listed is provisioned — partial rollout is safe. Sales keep working via the deprecated `AGENT_PINS`/`STAFF_PASSWORD` fallbacks until their PINs land here. |
| `CEO_LINE_USER_ID` | optional, suite-wide — the CEO's LINE userId for escalation pushes from the Prominent OA (the old name `CERES_CEO_LINE_USER_ID` still works as a deprecated fallback). To find it: message the OA from the personal account, then read the `Customer.lineUserId` of that chat (console or DB). Leave unset to disable pushes (escalations still appear in the CEO tab). |
| `CERES_FLOOR` | optional, default `40000` (top-up trigger) |
| `CERES_CEO_THRESHOLD` | optional, default `5000` (mandatory CEO pre-approval above this) |

Slug → person: nadeer NaDeer · anny Anny · noey Noey (sales — Minerva + Ceres) · ta ต้า ·
arm อาร์ม · man แมน · boonson บุญสอน · kaew แก้ว · lungko ลุงโก๊ะ · wong วง · paeng แป๋ง ·
nun นุ่น · pin พิณ · da ด้า (couriers — Ceres) · lekmaeban เล็กแม่บ้าน (housekeeper — Ceres).
**นี is Nee the MD — she logs in with `MD_PASSWORD`, not a PIN.** The CEO logs in with the
existing Dr. M supervisor account — no new login. What each employee can open is a per-person
grant list (`Agent.apps`), edited later in Jupiter's admin screen — position changes never
touch env vars again.

## 2. New Railway service: `ceres`

Same recipe as Juno/Vulcan:
1. New service from the same GitHub repo; **Root Directory = `ceres`** (it has its own Dockerfile).
2. Build arg / service variable: `VITE_API_URL = https://<the api service domain>`.
3. Generate a domain for the service (e.g. `ceres-….up.railway.app`).
4. On the **api** service, append that domain to `WEB_ORIGIN` (comma-separated) — CORS.
5. Redeploy api (env change), deploy ceres.

## 3. Smoke test (in order)

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

## 4. Cutover from the GAS app (ระบบค่าใช้จ่าย MSG)

- Announce the switch; messengers start entering in Ceres on day 1 after the opening
  balance is set. Old sheets stay read-only archive (fresh-start decision — no import).
- **Security: the GAS webapp has a hardcoded admin password (`prom5951`) that has also been
  shared in chat. Disable the GAS deployment (or at minimum rotate that password) at
  cutover.**

## 5. Coordination note — shared KBIZ parser

`api/src/bank/` (csv.ts, parseKbiz.ts, fixtures, checkBankParsers.ts) is built to the Juno
Phase B format spec and validated against a real export. The Juno workstream has its own
copy on branch `juno-recon`: **whichever branch merges second must drop its own copy and
adopt the parser already on main** (both were validated against the same real file; the
interfaces are per the same spec). K SHOP parsing belongs to Juno and is not in this tree.

## 6. Ops notes

- Receipt photos + archived statements live under the api volume (`UPLOAD_DIR/ceres/…`) —
  same persistence story as customer images.
- Verification bundle (run in `api/`): `npx prisma validate && npx tsc --noEmit &&
  npx tsx src/scripts/checkBankParsers.ts`; in `ceres/`: `npm run build`.
- Weekly physical cross-check: CEO tab → ชุดตรวจสอบรายสัปดาห์ → five CSVs (expenses,
  movements, requests, AI reviews, statement lines) for the paper reconciliation.
