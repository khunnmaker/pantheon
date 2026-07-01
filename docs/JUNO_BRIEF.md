# Juno — Finance (build brief)

> Hand this file to a fresh session. It is self-contained: it assumes **no** memory of the
> Minerva chat it was written in. Juno is a NEW project that plugs into the existing **Minerva**
> system (a LINE customer-reply assistant for **Prominent**, a Thai dental-equipment distributor).
> Build Juno in the **same monorepo** as Minerva, on the **same shared Postgres**. It joins the
> "Deities" suite: **Minerva** (sales), **Vulcan** (stock), **Diana** (website), **Juno** (finance).

---

## 1. Mission

Juno is a **finance-department web app**. Today, when a customer sends a payment slip over LINE,
Minerva OCRs it, staff confirm the details, and it's forwarded to a **Google Sheet**. The finance
team then works off that sheet directly. Juno replaces that: it gives finance a **proper frontend
over a real database**, so they **never touch the sheet**. It's the money layer of the same
organism — it reads the incoming payments Minerva captures, lets finance **verify / flag / track**
them, manages **tax-invoice** requests, and produces **reports**.

(Juno Moneta was the Roman goddess whose temple held the mint — "money"/"mint" come from her.)

---

## 2. Decisions already made (build to these — do not re-litigate)

1. **Source of truth = a `Payment` table in the shared Postgres** (NOT the Google Sheet). Minerva
   writes a structured `Payment` row when a slip is forwarded; Juno lives entirely on that table.
   The Google Sheet becomes an **optional mirror/export** for accounting habit — never the master,
   and finance does not edit it.
2. **Scope now = INCOMING, LINE-slip payments only.** Just the payments Minerva already captures.
   Built so it can expand later — but do NOT build the expansions now.
3. **INCOME only.** Expenses / outgoing / supplier payments are a **separate future project** — out
   of scope entirely.
4. **Standalone app on the shared DB.** Juno is its own frontend + backend (like Vulcan/Diana),
   talking to the same Postgres. **No accounting-system integration yet** — the owner runs "Express"
   (Thai accounting software) and may later move to Odoo; how Juno feeds that is deferred. Design the
   `Payment` table so an export/sync is a clean future add-on, but don't build it.
5. **Explicitly OUT of the MVP** (all future, same table): manual/cash/non-LINE payment entry,
   expenses, and any accounting-system sync (Express/Odoo).

---

## 3. Minerva context you need

- **Repo:** `C:\Users\khunn\Project\Minerva` (monorepo) — `github.com/khunnmaker/minerva`. Juno lives
  in THIS repo. Default branch `main` auto-deploys to Railway on push. Vulcan + Diana already share it.
- **Stack:** `/api` = Node + TS + Fastify + Prisma + PostgreSQL. `/web` = Vite + React + Tailwind +
  Socket.IO. The Dockerfile runs `prisma migrate deploy` on boot. Live in production.
- **The current finance flow (this is what Juno consumes):**
  - `POST /api/messages/:id/read-slip` (`api/src/routes/messages.ts`) — Claude OCRs the slip image →
    returns `{ amount, bank, transferAt, ref, nickname (customer name), realName (sender on slip) }`.
    It **stores the OCR amount server-side** (`Message.slipAmount`) — tamper-proof, for the mismatch check.
  - The web **FinanceModal** (`web/src/Console.tsx`) lets staff confirm/edit the fields (incl.
    `ใบกำกับภาษี` tax-invoice text + `หมายเหตุ` note) and calls
    `POST /api/messages/:id/to-finance` with `{ amount, bank, transferAt, ref, realName, taxInvoice, note }`.
  - `/to-finance` computes the customer **name** (`resolveCustomerName`: assigned nickname → LINE
    name → live fetch), the **customer code**, the **slip URL** (`buildSlipUrl` — a tokenized public
    link to the slip image), and the **sales** agent, then calls `sendToFinance(...)`
    (`api/src/finance/sendToFinance.ts`) which POSTs to the Google Sheet Apps Script webhook. It also
    sets `Message.financeSentAt`.
  - **Anti-tamper audit (already exists):** if the staff-entered amount ≠ the stored OCR amount,
    `/to-finance` writes a `FinanceAudit` row (DB, supervisor-only) — never to a sheet sales can edit.
    **Juno's `Payment` row absorbs this** (it carries both `ocrAmount` and `amount`), so the flag
    becomes Juno's flag queue.
- **`Customer` model** (`api/prisma/schema.prisma`): has `id`, `lineUserId` (unique; `U…`/`C…`/`R…`),
  `displayName`, `nickname`, `code` (e.g. `ร001`), etc. The **`code`** is the join key across the Deities.
- **`Message` model:** the slip is an image message; `slipAmount`, `financeSentAt`, `attachmentRef`,
  and the tokenized slip URL derive from it. A `Payment` links back to it via the message id.
- **Auth (reuse the pattern):** JWT + bcrypt; roles `agent | supervisor`; staff reconciled on every
  boot from env passwords (`SEED_PASSWORD` = admin "Dr. M" / supervisor; `STAFF_PASSWORD` = shared
  team). See `api/src/db/ensureSeeded.ts`. `requireAuth` re-validates the token against the live DB
  row each request (`api/src/auth/middleware.ts`).
- **Railway:** services for `api`, `web`, Postgres (+ Vulcan's service). Secrets (`DATABASE_URL`,
  `JWT_SECRET`, the finance sheet webhook + secret) live ONLY in Railway env — never commit them.

---

## 4. Architecture

- **One Prisma schema, one database.** Add Juno's table(s) to the EXISTING
  `api/prisma/schema.prisma`. Do **not** create a second Prisma schema on the same DB (migrations
  would fight). Minerva's `prisma migrate deploy` (the api service) stays the single migrator.
- **Minerva writes the `Payment`; Juno reads it.** The only Minerva-side change is a small hook in
  `/to-finance` that also creates a `Payment` row (see §6). Keep the Google-Sheet post as an optional
  mirror (leave it on for now; it can be retired later).
- **Juno = its own frontend + backend service** in the monorepo, pointed at the **same**
  `DATABASE_URL`. It reads `Payment` (joined to `Customer`), and serves the finance UI. It does NOT
  depend on Minerva being up (reads the shared DB directly), same as Vulcan/Diana.
- **Migrations caution:** a Juno migration touches Minerva's live DB. **ADD only** — never drop/rename
  Minerva columns. `Payment` is a new table + a couple of nullable relations; safe.

---

## 5. Schema additions (to `api/prisma/schema.prisma`)

```prisma
model Payment {
  id            String    @id @default(cuid())
  // link + snapshot (snapshot so history is stable even if the customer is renamed later)
  customerId    String?
  customerCode  String    @default("")   // e.g. ร001 (join key across the Deities)
  customerName  String    @default("")   // "ชื่อ": assigned nickname else LINE name, at time of payment
  senderName    String    @default("")   // "ชื่อผู้โอน": the name parsed off the slip
  // money
  amount        String    @default("")   // confirmed baht amount (keep as string to match current flow, or Decimal)
  ocrAmount     String    @default("")   // what the OCR read (for the mismatch flag)
  bank          String    @default("")   // account received into
  transferAt    String    @default("")   // when the customer transferred (as-shown on slip)
  ref           String    @default("")   // transfer reference no.
  // the slip itself
  slipMessageId String?                  // the Minerva Message (image) this came from
  slipUrl       String    @default("")   // tokenized public link to the slip image (Minerva hosts it)
  // tax invoice
  taxInvoice        String @default("")  // ใบกำกับภาษี: name / address / tax-id (free text), blank if not requested
  taxInvoiceStatus  String @default("none") // none | requested | issued
  // who forwarded it (sales)
  salesAgentId  String?
  salesName     String    @default("")
  note          String    @default("")   // หมายเหตุ
  // finance lifecycle (Juno owns this)
  status        String    @default("received") // received | verified | recorded | flagged | void
  flagged       Boolean   @default(false)       // true when ocrAmount != amount, or raised by finance
  verifiedById  String?                          // finance agent who verified
  verifiedAt    DateTime?
  createdAt     DateTime  @default(now())        // when Minerva forwarded it
  @@index([status])
  @@index([customerCode])
  @@index([createdAt])
}
```
Notes: keep `amount`/`ocrAmount` as `String` to match the current flow with the least friction (the
OCR/entry are free-text today), OR switch to `Decimal` and normalize — decide with the owner. The
existing `FinanceAudit` table can stay as-is (it's harmless) or be considered superseded by
`Payment.flagged` + `ocrAmount`/`amount`; do NOT delete it in the same change that introduces Payment.

---

## 6. The Minerva-side hook (small — Juno depends on it)

In `/to-finance` (`api/src/routes/messages.ts`), AFTER the existing send-to-sheet + audit logic, also
create a `Payment` row from the same values already computed there (`code`, `nickname`→customerName,
`realName`→senderName, `amount`, `Message.slipAmount`→ocrAmount, `bank`, `transferAt`, `ref`,
`taxInvoice`, `note`, `slipUrl`, `sales`, `customerId`, `slipMessageId = msg.id`). Set
`flagged = !!ocrAmount && ocrAmount !== amount`, `taxInvoiceStatus = taxInvoice ? 'requested' : 'none'`,
`status = 'received'`. Best-effort/transactional — but a Payment must not silently fail to record.
Leave the Google-Sheet post in place (mirror) unless the owner says to remove it.

---

## 7. Juno MVP features (income / LINE-slip / verify-and-report)

1. **Payments inbox** — searchable, filterable table: date, customer, `code`, amount, bank, sales rep,
   status. Replaces staring at the sheet.
2. **Slip verifier** — click a payment → the slip image (`slipUrl`) beside the parsed details; confirm
   at a glance.
3. **Verify workflow** — move each payment `received → verified → recorded` (+ `void`); record who/when
   (`verifiedById`/`verifiedAt`). Finance owns it; sales cannot alter a recorded payment.
4. **Flag queue** — payments where `flagged` (amount mismatch, or raised manually) for a finance
   supervisor to investigate. This is the real fraud/error control.
5. **Tax-invoice (ใบกำกับภาษี) queue** — payments with a tax-invoice request; track `requested → issued`
   (already have the name/address/tax-id text captured).
6. **Reports / export** — daily/monthly totals by rep / bank / customer; one-click Excel/CSV; a
   sheet-style view for anyone who wants it.
7. **Roles** — finance-staff vs finance-supervisor (own login set, mirroring Minerva's staff/supervisor).

**Deliberately NOT in the MVP** (owner's "expand later"): manual/cash/non-LINE payment entry, expenses,
and accounting-system sync.

---

## 8. Auth / who uses Juno

The **finance department** uses Juno — a different group from Minerva's sales staff. **CONFIRM with the
owner:** reuse Minerva's login table with a new `finance` / `finance_supervisor` role, or a separate
Juno agent/login set? Recommend a small **separate finance role set** (finance shouldn't see the sales
console, and vice-versa) reconciled on boot from env passwords like Minerva's `ensureSeeded`. Reuse the
JWT + `requireAuth` (live-DB re-validation) pattern either way.

---

## 9. Deploy

- Railway, same as the others. Juno's api/web point at the **same** `DATABASE_URL` (shared Postgres).
  Ensure **only one** service runs `prisma migrate deploy` (keep Minerva's api as the migrator) to
  avoid migration races. Push to `main` to deploy. Secrets only in Railway env.

---

## 10. First steps for the new session

1. Read this file + `api/prisma/schema.prisma` (`Customer`, `Message`), `api/src/routes/messages.ts`
   (`read-slip`, `to-finance`, `resolveCustomerName`, `buildSlipUrl`), `api/src/finance/sendToFinance.ts`,
   and `api/src/db/ensureSeeded.ts` (auth).
2. **Confirm with the owner:** finance login model (§8); `amount` as String vs Decimal (§5); keep the
   Google-Sheet mirror on or off; exact payment lifecycle names/steps they want.
3. Add the `Payment` model (§5); migrate (ADD only).
4. Add the Minerva-side hook: write a `Payment` on `/to-finance` (§6). Verify a real slip forward creates
   a row.
5. Build Juno: inbox → slip verifier → verify workflow → flag queue → tax-invoice queue → reports (§7),
   with finance auth (§8).
6. Deploy. Confirm finance can do everything without opening the sheet.

---

## 11. Cautions

- **Shared DB:** ADD only; never drop/rename Minerva's columns. One Prisma schema, one migrator (Minerva api).
- **Don't break the live slip flow.** The Payment write is additive; a failure there must not stop the
  existing send-to-sheet or the LINE reply.
- **Integrity is the point.** The DB `Payment` is the record of truth; the sheet is a mirror. Never let
  finance edit money records in the sheet.
- **PII / money data** — slips, names, tax IDs, amounts. Keep it behind finance auth; secrets only in
  Railway env; the slip URLs stay tokenized.
- Snapshot customer name/code onto the Payment (don't rely on the live Customer row) so history is stable.

---

## 12. Open questions to confirm with the owner early

1. **Finance login:** new `finance` role in Minerva's login set, or a separate Juno login set?
2. **`amount` type:** keep as free-text String (matches today) or move to `Decimal` + normalize baht?
3. **Google Sheet:** keep it as a live mirror, or retire it once Juno is in use?
4. **Lifecycle:** confirm the exact statuses/steps finance wants (received → verified → recorded → …).
5. **Tax invoices:** does finance just *track* issued/pending in Juno, or also *generate* the invoice doc?
