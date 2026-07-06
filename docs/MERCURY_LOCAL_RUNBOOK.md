# Mercury Local — runbook (install · Gmail · DNS · backup · hardening)

The **on-prem procurement node**. It holds **ALL secrets** — the alias→real-item map, real vendor
names/emails, cost prices, classification, and product pictures — and it is the machine that
**sends purchase-order email**. Everything here lives on the owner's machine and is **never** pushed
to the cloud or committed to git. See `docs/MERCURY_BRIEF.md` §5 (local data model), §6 (PO email),
§8 (security bar — non-negotiable).

> **Security in one line:** this machine needs **full-disk encryption (BitLocker) + a screen lock +
> a backup routine**, because a single file (`prisma/mercury-local.db`) plus the Gmail token is
> enough to unmask every supplier and send mail as the company.

---

## 1. Install / run

Windows, Node 18+ (built + verified on Node 24). From `mercury-local/`:

```
npm install          # first time only — installs deps (express, prisma, pdfkit, googleapis)
npm run start        # prisma generate → migrate deploy → build client+server → open the browser
```

`npm run start` is idempotent: it applies any pending DB migration, rebuilds, launches the Express
server on **http://localhost:4610**, and opens the default browser. A fresh machine (empty DB) gets
its tables created automatically — no manual migrate step.

**One-click:** double-click **`mercury-local.cmd`** (it runs `npm run start`). First run installs
deps; every run rebuilds + launches + opens the browser.

The server binds to **127.0.0.1 only** — it is not reachable from the network. Port `4610` is fixed
to avoid the suite dev ports; the OAuth loopback (below) uses `4620`.

**Verify the send path offline (no Google credential needed):**

```
npm run verify:send
```

This runs the whole Gmail send path against a **mocked** Gmail client and a throwaway PO row: it
proves the message is built with `From = Prominent Purchasing <purchasing@prominentdental.com>`, the
correct To/CC/subject, a base64 PDF attachment, and that a successful send marks the PO `sent` +
flips the underlying request to `ordered`. It uses **no real credential** and cleans up after
itself.

---

## 2. Gmail API OAuth setup (one-time, ~10 min)

Mercury sends the PO from **`purchasing@prominentdental.com`** — a **verified "Send mail as" alias**
on the Google Workspace seat **`khunnakritr@prominentdental.com`** (a *distinct* account from the
owner's personal gmail). So OAuth authenticates **as `khunnakritr@prominentdental.com`**, and Mercury
sets the message `From` header to the `purchasing@` alias. DKIM is already published; SPF + DMARC are
added in §3.

Do this once. It ends with a **refresh token** stored locally that Mercury reuses forever (until you
revoke it).

### 2a. Create/pick the GCP project + OAuth client

1. Sign in to **[console.cloud.google.com](https://console.cloud.google.com)** as
   **`khunnakritr@prominentdental.com`** (the Workspace seat, not the personal gmail).
2. **Create a project** (or pick one) on the `prominentdental.com` org — e.g. name it `mercury-local`.
3. **APIs & Services → Library →** enable the **Gmail API** for the project.
4. **APIs & Services → OAuth consent screen:** choose **Internal** (Workspace-org-only — no Google
   review needed). App name e.g. `Mercury Local`, support email = `khunnakritr@prominentdental.com`.
   Add the scope **`.../auth/gmail.send`** (the *only* scope Mercury needs — send-only, no read).
5. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - **Application type: Desktop app** (this is the loopback / installed-app flow).
   - Name it e.g. `mercury-local-desktop`. Create.
   - (Desktop clients accept loopback redirects automatically; if the console asks for an authorized
     redirect URI, add `http://127.0.0.1:4620`.)
6. **Download the client JSON.** Rename it to **`gmail-oauth-client.json`** and place it in the
   `mercury-local/` folder (the app looks for it there). It holds the `client_id`/`client_secret`;
   it is **gitignored — never commit it**.

### 2b. Authorize (connect Gmail)

1. Launch Mercury (`npm run start`), open the **"ใบสั่งซื้อ"** (Purchase Orders) tab.
2. In the **Gmail card** click **"เชื่อม Gmail"** (Connect Gmail). Mercury spins up a one-shot
   loopback listener on `127.0.0.1:4620` and opens the Google consent page.
3. **Sign in as `khunnakritr@prominentdental.com`** and grant the send permission. (The picker is
   pre-hinted to that account.)
4. On success the tab shows "connected" and the **refresh token** is saved to
   **`mercury-local/gmail-token.json`** (gitignored). You will not have to do this again.

If you haven't dropped in `gmail-oauth-client.json` yet, "Connect Gmail" fails **gracefully** with a
clear "OAuth client not configured" message — nothing crashes.

### 2c. Scope, revoke, rotate

- **Scope:** `https://www.googleapis.com/auth/gmail.send` only — Mercury can send mail, nothing else
  (no inbox read, no modify).
- **Revoke / rotate the token:** either (a) delete **`gmail-token.json`** and re-run "Connect Gmail",
  or (b) go to **[myaccount.google.com/permissions](https://myaccount.google.com/permissions)** (as
  `khunnakritr@`) → remove **Mercury Local** → then reconnect for a fresh consent. Revoking at Google
  invalidates the refresh token immediately (do this if the machine is lost).
- **Rotate the client secret:** in GCP Credentials, delete the OAuth client and create a new one →
  download the new `gmail-oauth-client.json` → reconnect.

---

## 3. DNS to add at GoDaddy (prominentdental.com)

Add two TXT records so mail sent as `purchasing@prominentdental.com` passes authentication. **DKIM is
already published**; these add **SPF** and **DMARC**.

| Type | Host / Name | Value |
|---|---|---|
| TXT | `@` (apex) | `v=spf1 include:_spf.google.com ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@prominentdental.com` |

**What / why (one paragraph):** SPF (the apex TXT) tells receiving servers that **Google Workspace**
is an authorized sender for `prominentdental.com`, so mail Mercury sends via Gmail isn't treated as
spoofed. DMARC (the `_dmarc` TXT) ties SPF + the already-published DKIM signature together and tells
receivers what to do if a message fails both — we start at `p=none` (monitor only, don't reject) and
collect aggregate reports at the `rua` address, so we can watch deliverability before tightening to
`p=quarantine`/`p=reject` later. Set `rua` to a mailbox you actually read (e.g.
`postmaster@prominentdental.com` or the owner's address). Allow up to a few hours for DNS to
propagate.

---

## 4. Backup

**The one file that matters is the SQLite database:**

```
mercury-local/prisma/mercury-local.db
```

It holds **everything secret** — the alias→real-item map, vendor names/emails, cost prices,
classification, product-picture refs. Back it up by **copying that single file** to an
**encrypted** destination (an encrypted external drive, or a Google Drive folder on the
`prominentdental.com` seat). A copy while the app is closed is a clean snapshot; if you must copy
while it's running, SQLite also writes a `-journal`/`-wal` sidecar — quit Mercury first for a
consistent copy.

Suggested cadence: after any batch of vendor/secret-map edits, and on a weekly schedule. Keep a
couple of dated copies (`mercury-local-2026-07-06.db`). **Because the file is the secret, the backup
location must be encrypted too** — do not drop it on an unencrypted USB stick.

Restoring = copy the `.db` back into `prisma/` (app closed) and launch.

---

## 5. Machine hardening (non-negotiable — brief §8)

This machine holds every procurement secret **and** can send mail as the company. Treat it like a
safe.

1. **Full-disk encryption — BitLocker.** Windows: Settings → Privacy & security → **Device
   encryption / BitLocker** → turn on for the system drive (and any drive holding backups). Store the
   BitLocker recovery key somewhere safe (the owner's Google account / a password manager), **not**
   on the machine itself.
2. **Screen lock.** Settings → Accounts → **Sign-in options** → require sign-in on wake; set a short
   auto-lock (Settings → System → Power & screen, or a screensaver with "on resume, show logon").
   `Win+L` habit when stepping away.
3. **A real account password / Windows Hello.** No auto-login.

### Sensitive local files — where they live + how to rotate

All are under `mercury-local/` and **all are gitignored** (never committed):

| File | Holds | Rotate / revoke |
|---|---|---|
| `prisma/mercury-local.db` | **All secrets** — aliases→real items, vendors, costs, POs | It *is* the data — protect via disk encryption + backup. To "rotate", edit/replace rows in-app; to wipe, delete the file (loses all data) and re-enter. |
| `.mercury-connection.json` | A **live suite JWT** (cloud login token) + the cloud base URL | In the **"ซิงค์"** tab click "ตัดการเชื่อมต่อ" (or delete the file), then reconnect. Rotating `SEED_PASSWORD` on the cloud also invalidates it. Never paste the token anywhere. |
| `gmail-token.json` | The **Gmail refresh token** (send-as `purchasing@`) | Delete the file + reconnect, **or** revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) (immediate). Do the Google-side revoke if the machine is lost. |
| `gmail-oauth-client.json` | The **OAuth client** `client_id`/`client_secret` | Delete + re-download from GCP; to fully rotate, delete the OAuth client in GCP Credentials and create a new one. |
| `po-output/` | Generated PO **PDFs** (may show real vendor/qty) | Safe to delete anytime — regenerated from a PO on demand. |
| `.env` | Local config (`DATABASE_URL`, `PORT`) — no secret by default | Edit as needed; gitignored. |

**Never** log or paste any of these files' contents. If the machine is lost or compromised: revoke
the Gmail token at Google, rotate `SEED_PASSWORD` on the cloud (invalidates the stored JWT), and — if
the disk was **not** encrypted — treat the vendor/cost data as exposed.

---

## 6. Cloud connection & the PO pipeline (recap)

Local-Mercury's only outbound contacts are the shared **Minerva api** (to pull pending requests) and
**Gmail** (to send the PO). It pushes **no secrets** anywhere.

- **Connect to cloud** — in the **"ซิงค์ / สร้าง PO"** tab enter the Minerva **api** base URL and log in
  with the **supervisor** suite credentials. The cloud `/api/mercury/*` routes are gated by
  `requireApp('mercury')`, which the supervisor passes; the resulting **JWT** (not the password) is
  stored in `.mercury-connection.json`. (If Mercury is later opened to employees, swap this for a
  dedicated `mercury-local` service token — noted as an open item.)
- **Fixture mode (offline):** set env `MERCURY_CLOUD_FIXTURE` to a JSON file with
  `{ "requests": [...], "items": [...] }` to prove the pull→resolve→build→PDF→email pipeline without a
  deployed cloud.
- **Pipeline:** Sync (pull pending requests) → Resolve (alias→real item against the local SecretMap;
  unresolved items are surfaced, never dropped) → Build POs (grouped by vendor) → Generate PDF
  (English; Taiwan vendors split NORMAL/SPECIAL; a product picture per line) → **review-then-send**
  the email.

### Review-then-send (NEVER auto-send)

From a draft PO **with a generated PDF**, click **"ตรวจ + ส่งอีเมล"**. Mercury pre-fills the email
(To = vendor email, CC = vendor CC list, an English subject + body — **all editable**) with the PO
PDF attached. Use **"พรีวิว (dry-run)"** to render the *exact* outgoing message without sending. Only
when the owner clicks **"ส่งอีเมล"** (and confirms) does Mercury send via the Gmail API. On success
the PO is marked **`sent`**, `emailedAt` is stamped, and the underlying local pending requests are
marked **`ordered`**.

> The cloud status push-back (so the team's cloud board shows "สั่งแล้ว") is **Phase 3** — this node
> marks the requests ordered **locally** for now. There is **exactly one** code path that calls
> Gmail, reachable only from that explicit Send click — no scheduler, no auto-send.
