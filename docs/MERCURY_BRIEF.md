# Mercury — procurement / purchasing deity (build brief)

> Handoff brief for a fresh session. Written 2026-07-04 after a grilled requirements session with the owner (Dr. M / CEO). Read this whole file before writing code. Companions: `docs/VULCAN_BRIEF.md` (stock — Mercury's main partner), `docs/JUPITER_BRIEF.md` (portal that tiles + badges the cloud node), `docs/VENUS_BRIEF.md` (the co-tenant pattern the cloud node copies). Mercury is the **buy-side** — the mirror of Vulcan (stock-in) the way Juno/Ceres are money-in/out.

## 1. What Mercury is

**The supplier-ordering system, split into two nodes so the team can trigger orders without ever seeing the factory's supply secrets.** Prominent is also a manufacturer (the KPK factory makes the Dentories line), so for some purchased items the *real identity and vendor are a trade secret* — even from Prominent's own sales/store staff. Mercury solves this with an **alias model**:

- **Cloud-Mercury** — team-facing, a normal co-tenant of the shared suite. The team sees a reorder queue (fed by Vulcan low-stock) and can request items. Secret factory items appear **only as an alias** — never their real name, vendor, or cost. The team submits purchase *requests* (item/alias + qty). Cloud stores only non-secret data.
- **Local-Mercury** — the owner's node, on an office machine, with its **own local database** holding **all the secrets**: the alias→real-item map, real vendor names + emails, cost prices, lead times, normal/special classification, product pictures. The owner opens it, it **pulls the pending requests** from cloud-Mercury, resolves aliases → real item + vendor, groups by vendor, builds the clean English PO (Taiwan normal/special split + product pictures — exactly the logic in the `/purchase-orders` and `/purchase-orders-taiwan` skills), and lets the owner **review then one-click email** the PO to the vendor. **The secrets never leave that machine.**

Mercury **retires the two manual purchase-order skills** and closes the buy→stock loop: goods-receipt pushes quantities back into Vulcan stock.

**Explicitly NOT Mercury:** accounting/AP payment (that's Ceres/Express), selling (Minerva/Diana), manufacturing BOM/MRP (out of scope), and — critically — **the cloud node never holds vendor names, real names behind aliases, or cost/margin numbers.**

## 2. Owner decisions (grilled 2026-07-04)

| Decision | Choice |
|---|---|
| Architecture | **Two nodes.** Cloud-Mercury (team portal, non-secret) + Local-Mercury (owner, all secrets, on-prem local DB). Even **vendor names and POs stay local.** The team orders by name or **alias**; only local-Mercury unmasks the alias and emails the order. |
| Email sender | **purchasing@prominentdental.com** — a Google Workspace address the owner created 2026-07-04 (a free send-as alias on his one paid Workspace seat). POs sent from it via local-Mercury. |
| Send control | **Review, then send** — Mercury drafts the PO + email; owner approves; then it sends. Never auto-send (matches the skills). |
| v1 scope | **All four:** PO builder + Gmail send · supplier master + price lists (local) · goods-receipt → Vulcan stock · reorder suggestions from Vulcan low-stock. |

Defaults accepted with the brief: cloud-Mercury = shared-suite co-tenant (routes in the shared api + `mercury/` frontend, per-grant auth like Venus); local-Mercury = standalone local app, own DB, talks only to cloud-Mercury + Gmail; alias→real-SKU link kept local-only (so even a Vulcan stock lookup can't unmask a secret item); PO attachment = PDF; grill-then-build (this doc).

## 2b. Owner clarifications (2026-07-04) — READ BEFORE BUILDING

Three clarifications landed after the brief was first written; they change the first architectural decision:

- **Access = owner-only (for now).** The owner is the *only* Mercury user — there is no team using it. This removes the original justification for the **cloud team-portal + alias-blind layer** (those existed so the team could order without seeing factory secrets). **⇒ The build session's FIRST decision, confirm with the owner:**
  - **Option A — single local app (simpler, likely right):** collapse to ONE local app that holds all secrets AND talks **directly to the shared Minerva api** for Vulcan low-stock + goods-receipt, and sends the PO email. No cloud-Mercury node, no alias layer needed while it's owner-only. Nothing procurement-related touches the cloud at all → strongest confidentiality, least to build/run. §3–§9's two-node machinery becomes optional.
  - **Option B — keep the two-node design (§3–§9 as written):** only if the owner wants to open Mercury from his **phone / anywhere** (a secrets-free cloud front-end) or expects to add team members soon. The alias layer stays *optional* even then.
  - Confidentiality (secrets never in the cloud) is satisfied by BOTH. Default to A unless the owner asks for anywhere-access.
- **Supplier / vendor / alias / cost data is entered IN-APP** by the owner over time (not bulk-imported). ⇒ v1 needs **supplier + vendor + item CRUD screens**, not (only) an importer.
- **Taiwan reference material** (the normal/special classification + product-picture folders the `/purchase-orders-taiwan` skill uses) will be **provided by the owner at build time**.

The rest of this brief (§3 onward) documents the full two-node design. If Option A is chosen, read it as "everything the LOCAL node does, in one app; skip the cloud node + alias sections."

## 3. The alias / secret model (the core — get this right first)

The alias is the **team-visible token**; the real identity is **local-only**. Everything else follows from this.

- A **MercuryItem** on the cloud has a `displayName` (either the item's ordinary name, or an opaque alias like `"วัตถุดิบ A-17"`), a boolean `isSecret`, and — for ordinary (non-secret) stocked items — an optional link to a Vulcan SKU. For **secret** items the cloud row carries **no SKU, no real name, no vendor, no cost** — nothing that could unmask it.
- Local-Mercury holds the **SecretMap**: `cloudItemId → { realName, vendorId, realSku, unitCost, currency, leadTime, moq, classification(normal|special), photoRef }`. This table exists **only** in the local DB and is never sent upward.
- **Threat model:** if the entire cloud DB is dumped, an attacker learns aliases + quantities + who-ordered — but **zero** vendor names, real product identities, or costs. That is the whole point; do not weaken it (no "encrypted cost field" on the cloud row — the data simply isn't there).
- **Receipt of secret items** must therefore be resolved locally: their real Vulcan SKU lives only in the SecretMap, so bumping Vulcan stock for a secret item happens from local-Mercury. Ordinary items (SKU on the cloud row) can be received on the cloud side.

## 4. Node architecture & the doorway

Three parties, two narrow doorways. Local-Mercury's only outbound contacts are cloud-Mercury and Gmail.

```
 Vulcan (shared api) ──low-stock──▶ Cloud-Mercury ◀──requests/status──▶ Local-Mercury ──PO email──▶ Vendor
        ▲                              (team portal)                    (secrets + PO build)   (Gmail: khunnakrit.ratc@)
        └──────────────── stock updates (goods-receipt) ───────────────┘
```

- **Cloud-Mercury** (co-tenant of the shared suite): routes `api/src/routes/mercury/*` + `mercury/` frontend. Reads Vulcan low-stock (already in the shared DB). Holds `MercuryItem` (public), `MercuryRequest`, request status. Suite auth, per-grant (`requireApp('mercury')`), Jupiter tile + `mercury: pending-requests` badge.
- **Local-Mercury** (standalone, on-prem): own repo/app + own local DB (SQLite for zero-admin, or local Postgres). Authenticates to cloud-Mercury with a dedicated service token (owner/`mercury-local` principal) over HTTPS. Pulls pending `MercuryRequest`s; resolves via SecretMap; builds POs; sends via Gmail (OAuth/Gmail API, token stored locally); pushes order-status + secret-item receipts back to cloud-Mercury.
- **The doorway is deliberately small and one-directional for secrets:** secrets only ever flow *down is never* — local pulls requests and pushes back only status + receipt quantities (never the resolved real name/vendor/cost).

## 5. Data model

**Cloud (shared DB, additive tables — Minerva api is the sole migrator, ADD-only):**
- `MercuryItem`: id, displayName, isSecret(bool), vulcanSku (nullable, **null for secret items**), active, createdAt.
- `MercuryRequest`: id, itemId→MercuryItem, qty (String, Juno money/number convention if priced — but requests are usually qty-only), requestedById→Agent, note, status(`pending|ordered|received|cancelled`), createdAt, orderedAt, receivedAt.
- (Optional) `MercuryReceipt` for cloud-side receipts of ordinary items → feeds a Vulcan stock update.

**Local (local DB only — never migrated into the shared schema):**
- `SecretMap`: cloudItemId(unique), realName, vendorId→Vendor, realSku, unitCost, currency, leadTime, moq, classification(`normal|special`), photoRef.
- `Vendor`: id, name, email, ccList, country (Taiwan flag), contactName, terms, notes.
- `PurchaseOrder`: id, vendorId, poNumber, lines[{cloudItemId, realName, realSku, qty, unitCost}], status(`draft|sent`), emailedAt, pdfPath.
- Local pulls `MercuryRequest`s from cloud to seed PO drafts.

## 6. PO generation & email (retires the two skills)

- Build a **clean English PO** grouped by vendor. Reuse the skills' rules: **Taiwan orders split normal vs special** against reference classification, **product picture per line**, English-only, item name + order qty + unit split, **CC list**, no internal code column.
- Attachment = **PDF** (Excel optional). Product pictures embedded/attached for Taiwan per `/purchase-orders-taiwan`.
- **Send from purchasing@prominentdental.com** (Google Workspace) via Gmail API (OAuth) or SMTP app-password, credential stored **locally** on the owner's machine. **Review-then-send**: local-Mercury shows the composed email + PO; owner approves; it sends; marks the requests `ordered` (status flows back to cloud so the team sees "สั่งแล้ว"). **Never auto-send.**
- **Build-time setup (owner + build session):** the send credential. Recommended = a Gmail API OAuth client (a Google Cloud project on the Workspace org → OAuth consent + client, then a one-time local authorize that stores a refresh token on the owner's machine — revocable if the machine is lost). Simpler fallback = a Workspace SMTP app-password. `purchasing@` is a send-as alias on the owner's paid seat, so Mercury authenticates as that seat and sets From=purchasing@ (verified send-as). Also add `sales@`/`info@` the same free-alias way if wanted later.

## 7. Goods-receipt → Vulcan

- **Ordinary items** (vulcanSku on the cloud row): team/store can mark received in cloud-Mercury → cloud pushes the qty to Vulcan stock (shared api / same write path Vulcan's import uses).
- **Secret items** (no SKU on cloud): received from **local-Mercury**, which knows the real SKU via SecretMap → pushes the stock update. The received *quantity* can sync to cloud as status; the *SKU* never does.
- Reuse Vulcan's stock-write path; do not invent a second stock source of truth (Vulcan owns `Product.stock`).

## 8. Security (non-negotiable)

- **The cloud node must never receive** vendor names, real names behind aliases, real SKUs of secret items, or cost/margin. Enforce at the schema level (the fields don't exist on cloud rows), not just by access control.
- **Local-Mercury holds every secret + sends mail** → its machine needs **full-disk encryption + a backup routine + a screen lock**. Write a short `docs/MERCURY_LOCAL_RUNBOOK.md` covering install, Gmail OAuth, backup, and machine hardening. The local Gmail token and DB file are sensitive — document where they live and how to rotate.
- Local↔cloud auth = a dedicated service token, HTTPS only, least-privilege (can read own pending requests + write status/receipts; cannot read other apps).
- Standard suite carry-overs: never log secrets/PINs; probes use the agent login; `SEED_PASSWORD` rotated — never ask the owner to paste passwords; cloud per-grant auth via `requireApp('mercury')`; Jupiter tile/badge gated by the grant.

## 9. Suite conventions (cloud node)

Monorepo `github.com/khunnmaker/minerva`, `main` auto-deploys on Railway. Cloud-Mercury = Vite+React+Tailwind static frontend (`mercury/`, own Railway service, `VITE_API_URL`, origin appended to `WEB_ORIGIN`), Thai UI, suite card-list login, per-grant access (`requireApp('mercury')`, register `'mercury'` in `auth/jwt.ts` AppName + `routes/auth.ts` APP_NAMES like Venus did). Pick a distinct theme (e.g. amber/orange — commerce). SKU convention: dashed key stored, bare displayed, dash-insensitive search. Local-Mercury is its OWN small codebase (can live in the same monorepo under `mercury-local/` or a separate repo — recommend a `mercury-local/` folder so it shares types, but it deploys nowhere/runs locally).

## 10. Build order

1. **Phase 1 — Cloud-Mercury**: `MercuryItem`/`MercuryRequest` tables, mercury routes + `mercury/` frontend, team request flow, Vulcan low-stock → reorder queue, per-grant auth + Jupiter tile/badge. Ordinary items only (no secrets yet). Ships + is useful alone (a team reorder board).
2. **Phase 2 — Local-Mercury core**: local app + local DB + SecretMap + Vendor + pull-requests-from-cloud + PO PDF builder (normal/special + pictures) + Gmail review-then-send. `docs/MERCURY_LOCAL_RUNBOOK.md`.
3. **Phase 3 — Loop close**: order-status sync back to cloud; goods-receipt → Vulcan (ordinary cloud-side, secret local-side). Alias unmasking fully wired.

## 11. Open items for the build session

- Confirm the Vulcan stock-write path Mercury should reuse (endpoint vs shared function) — read `api/src/routes/*stock*` / Vulcan brief first.
- Local DB choice: SQLite (zero-admin, single-file backup — recommended) vs local Postgres.
- Gmail send: Gmail API OAuth (nicer, revocable) vs SMTP app-password (simpler) — recommend Gmail API.
- Whether cloud-Mercury requests are qty-only or can carry a team-suggested vendor for *ordinary* items (secret items never).
- Which staff get the `mercury` grant (owner names them; roster edits are confidential per `minerva-staff-auth`).
- Later: dedicated `purchasing@` sender; Taiwan reference-folder location for the normal/special classification + pictures (the skills point at specific folders — carry those in).

## 12. Protocol

Build via **/delegate** (Fable/Opus specs + reviews, Sonnet executes) per the standing rule; cloud node in an isolated git worktree (junction node_modules; unlink link-only BEFORE any recursive delete); commit via Bash `git commit -F <file>`; expect `main` to move mid-build — rebase, never force-push. Local-Mercury has no deploy target (runs on the owner's machine) — deliver it with the runbook.
