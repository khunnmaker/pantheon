# Mercury Local — runbook (install · SMTP · DNS · backup · hardening)

The **on-prem procurement node**. It holds **ALL secrets** — the alias→real-item map, real vendor
names/emails, cost prices, classification, and product pictures — and it is the machine that
**sends purchase-order email**. Everything here lives on the owner's machine and is **never** pushed
to the cloud or committed to git. See `docs/MERCURY_BRIEF.md` §5 (local data model), §6 (PO email),
§8 (security bar — non-negotiable).

> **Security in one line:** this machine needs **full-disk encryption (BitLocker) + a screen lock +
> a backup routine**, because a single file (`prisma/mercury-local.db`) plus the SMTP App Password
> is enough to unmask every supplier and send mail as the company.

---

## 1. Install / run

Windows, Node 18+ (built + verified on Node 24). From `mercury-local/`:

```
npm install          # first time only — installs deps (express, prisma, pdfkit, nodemailer)
npm run start        # prisma generate → migrate deploy → build client+server → open the browser
```

`npm run start` is idempotent: it applies any pending DB migration, rebuilds, launches the Express
server on **http://localhost:4610**, and opens the default browser. A fresh machine (empty DB) gets
its tables created automatically — no manual migrate step.

**One-click:** double-click **`mercury-local.cmd`** (it runs `npm run start`). First run installs
deps; every run rebuilds + launches + opens the browser.

The server binds to **127.0.0.1 only** — it is not reachable from the network. Port `4610` is fixed
to avoid the suite dev ports. (No inbound OAuth loopback is used — sending is plain SMTP, below.)

**Verify the send path offline (no SMTP credential / App Password needed):**

```
npm run verify:send
```

This runs the whole SMTP send path against a **mocked** mail transport and a throwaway PO row: it
proves the message is built with `From = Prominent Purchasing <purchasing@prominentdental.com>`, the
correct To/CC/subject, the PO PDF attached (`application/pdf`), that `transport.sendMail` is called
exactly once, and that a successful send marks the PO `sent` + flips the underlying request to
`ordered`. It uses **no real credential** and cleans up after itself.

---

## 2. SMTP App-Password setup (one-time, ~5 min)

Mercury sends the PO from **`purchasing@prominentdental.com`** — a **verified "Send mail as" alias**
on the Google Workspace seat **`khunnakritr@prominentdental.com`** (a *distinct* account from the
owner's personal gmail). SMTP authenticates **as `khunnakritr@prominentdental.com`** using a Google
**App Password**, and Mercury sets the message `From` header to the `purchasing@` alias (SMTP lets
you send as a verified alias). DKIM is already published; SPF + DMARC are added in §3.

We use **SMTP + an App Password** (not OAuth) because Mercury is a single-user on-prem tool — an App
Password is simpler than a GCP OAuth project + refresh-token flow, and needs no browser dance. Do
this once. It ends with a 16-character password pasted into a local, gitignored config file.

### 2a. Generate the App Password

App Passwords require **2-Step Verification** to be ON for the account.

1. Sign in to **[myaccount.google.com](https://myaccount.google.com)** as
   **`khunnakritr@prominentdental.com`** (the Workspace seat, not the personal gmail).
   - If the Workspace admin has disabled App Passwords org-wide, enable them for this user in the
     Google Admin console (Security → less secure / app passwords) — or ask whoever administers the
     `prominentdental.com` Workspace to allow it for this seat.
2. **Google Account → Security → 2-Step Verification →** turn it **on** if it isn't already.
3. **Google Account → Security → App passwords** (search "App passwords" in the account search bar if
   you don't see it). Create one: **app = "Mail"**, device name = anything (e.g. `Mercury Local`).
4. Google shows a **16-character password** (four groups of four). Copy it now — it is shown once.

### 2b. Paste it into the local config

1. In the `mercury-local/` folder, copy **`.mercury-smtp.example.json`** to
   **`.mercury-smtp.json`** (the real file is **gitignored — never commit it**).
2. Open `.mercury-smtp.json` and set:
   - `SMTP_USER` = `khunnakritr@prominentdental.com` (already filled in the example)
   - `SMTP_PASS` = the **16-char App Password** (paste it; spaces are fine, they're trimmed)
   - leave `SMTP_HOST` (`smtp.gmail.com`), `SMTP_PORT` (`465`), `SMTP_SECURE` (`true`) and
     `MAIL_FROM` (`Prominent Purchasing <purchasing@prominentdental.com>`) as-is unless you have a
     reason to change them.
3. **Restart the app** (`npm run start`, or the `mercury-local.cmd` shortcut). Open the **"ใบสั่งซื้อ"**
   (Purchase Orders) tab — the mail card should now read **"ตั้งค่า SMTP แล้ว (พร้อมส่ง)"** (SMTP configured,
   ready to send).

If `SMTP_PASS` is missing, the card reads **"ยังไม่ได้ตั้งค่า SMTP"** and Send is disabled (you can still
Preview / dry-run) — nothing crashes.

> **Config path:** `mercury-local/.mercury-smtp.json`. Environment variables of the same names
> (`SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS/MAIL_FROM`) override the file if set, but the
> JSON file is the normal place — **never** put the App Password in a committed `.env`.

### 2c. Revoke / rotate

- **Rotate the App Password:** in **Google Account → Security → App passwords**, delete the old
  "Mail" entry and generate a new one → update `SMTP_PASS` in `.mercury-smtp.json` → restart. Do this
  immediately if the machine is lost or the password may have leaked.
- **Kill switch:** revoking the App Password at Google (or turning off App Passwords for the seat)
  invalidates it instantly, even if the file still holds the old value.
- **Scope:** an App Password grants SMTP send (and IMAP/POP if used) for that account — Mercury only
  sends. It cannot be scoped narrower than the account; the mitigation is disk encryption + prompt
  revocation, per §5.

---

## 3. DNS to add at GoDaddy (prominentdental.com)

Add two TXT records so mail sent as `purchasing@prominentdental.com` passes authentication. **DKIM is
already published**; these add **SPF** and **DMARC**.

| Type | Host / Name | Value |
|---|---|---|
| TXT | `@` (apex) | `v=spf1 include:_spf.google.com ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:postmaster@prominentdental.com` |

**What / why (one paragraph):** SPF (the apex TXT) tells receiving servers that **Google Workspace**
is an authorized sender for `prominentdental.com`, so mail Mercury sends via Gmail's SMTP isn't
treated as spoofed. DMARC (the `_dmarc` TXT) ties SPF + the already-published DKIM signature together and tells
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
| `.mercury-smtp.json` | The **SMTP App Password** (`SMTP_PASS`) + user for send-as `purchasing@` | Regenerate the App Password in [Google Account → Security → App passwords](https://myaccount.google.com) and update `SMTP_PASS`, **or** delete/revoke the App Password at Google (immediate). Do the Google-side revoke if the machine is lost. |
| `po-output/` | Generated PO **PDFs** (may show real vendor/qty) | Safe to delete anytime — regenerated from a PO on demand. |
| `.env` | Local config (`DATABASE_URL`, `PORT`) — no secret by default | Edit as needed; gitignored. |

**Never** log or paste any of these files' contents. If the machine is lost or compromised: revoke
the **SMTP App Password** at Google (or turn off App Passwords for the seat), rotate `SEED_PASSWORD`
on the cloud (invalidates the stored JWT), and — if the disk was **not** encrypted — treat the
vendor/cost data as exposed.

---

## 6. Cloud connection & the PO pipeline (recap)

Local-Mercury's only outbound contacts are the shared **Minerva api** (to pull pending requests) and
**Gmail's SMTP** (to send the PO). It pushes **no secrets** anywhere.

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
when the owner clicks **"ส่งอีเมล"** (and confirms) does Mercury send via SMTP. On success the PO is
marked **`sent`**, `emailedAt` is stamped, and the underlying local pending requests are marked
**`ordered`**.

> The cloud status push-back (so the team's cloud board shows "สั่งแล้ว") is **Phase 3** — this node
> marks the requests ordered **locally** for now. There is **exactly one** code path that sends
> mail, reachable only from that explicit Send click — no scheduler, no auto-send.
