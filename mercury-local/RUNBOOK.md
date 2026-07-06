# Mercury Local — runbook (stub)

The on-prem procurement node. Holds ALL secrets (alias→real-item map, vendor names/emails,
cost prices, product pictures). **This machine needs full-disk encryption + a screen lock + a
backup routine.** See `docs/MERCURY_BRIEF.md` §8 for the security bar; this file is a build-time
stub — the full install/hardening/Gmail-OAuth/backup runbook lands with the Gmail-send chunk (2c).

## Run it

Double-click `mercury-local.cmd` (Windows). First run installs deps; every run:

```
prisma generate → prisma migrate deploy → build client + server → launch on http://localhost:4610
```

`prisma migrate deploy` is wired into both the `.cmd` launcher **and** the `npm start` script, so a
fresh machine (empty `local.db`) gets its tables created before the app serves — no manual migrate.

## Cloud connection & auth (Phase 2b)

Local-Mercury pulls **pending requests + items** from cloud-Mercury to seed PO drafts. The
connection is set up in the app's **"ซิงค์ / สร้าง PO"** tab:

- **Base URL** — the shared Minerva **api** base (e.g. `https://<minerva-api>.up.railway.app`).
  Configurable; nothing is hardcoded. The cloud may not be deployed yet — see fixture mode below.
- **Auth (v1 choice)** — the owner authenticates by **reusing the suite login**: his **supervisor**
  email + password → `POST /api/auth/login` → a **JWT**, sent as a `Bearer` token to
  `/api/mercury/*`. The cloud mercury routes are gated by `requireApp('mercury')`, which the
  supervisor passes implicitly, so **no separate cloud-side service-token mechanism is needed for
  owner-only v1.** (If Mercury is later opened to employees, revisit: a dedicated
  `mercury-local` service principal / scoped token would be tighter than reusing a full supervisor
  JWT. Noted as an open item.)

### Where the connection lives (sensitive)

The base URL **and the JWT** are stored in `mercury-local/.mercury-connection.json` — **gitignored,
never committed**. It holds a live bearer token; treat it like the DB. The **password is never
stored** — only the resulting token. To rotate/forget: click "ตัดการเชื่อมต่อ" (deletes the file),
or delete `.mercury-connection.json` and reconnect.

### Fixture mode (offline / cloud-not-deployed)

Set the env var `MERCURY_CLOUD_FIXTURE` to a JSON file with `{ "requests": [...], "items": [...] }`
(the two cloud responses) and Sync reads from it instead of the network. Used to prove the
pull→resolve→build→PDF pipeline before the cloud node exists.

## The pipeline

1. **Sync** — pull pending `MercuryRequest`s + `MercuryItem`s, store a local `PendingRequest`
   shadow (non-secret cloud fields only).
2. **Resolve** — each request's cloud `itemId` is matched against the local `SecretMap`:
   - mapped → real identity (name, vendor, SKU, cost, classification, photo);
   - ordinary cloud item with no map → flagged **needs mapping** (vendor unknown);
   - secret item with no map → flagged **unmapped secret — cannot resolve** (add a SecretMap row).
   Unresolved items are **surfaced, never silently dropped.**
3. **Build POs** — resolved lines grouped **by vendor** → draft `PurchaseOrder`s.
4. **Generate PDF** — clean **English** PO per vendor → `po-output/` (gitignored). Taiwan vendors
   split **NORMAL vs SPECIAL**; a **product picture per line** (placeholder box if missing). No
   internal code column. CC list from the vendor.

**Email send is NOT in this chunk** — the pipeline stops at "PDF generated / preview". Gmail
review-then-send is chunk 2c.
