# Juno — บิลมือ (Manual Bill) v1 build brief

Owner spec (2026-07-13): บิลมือ gets its **own tab in Juno** and **acts like the RE system in Express** — Juno issues/records manual bills with running numbers. Bill lines can **add products from the shared catalog/stock** (the Product table managed by the stock app "Vesta", dir `vulcan/`) as well as free-text lines. In the ตรวจแล้ว dialog, **FIN can type a บิลมือ number instead of an RE number** on a payment.

Business context: บิลมือ = the manual billing lane, used when (a) the item sold is not in Express, or (b) the buyer is not a regular customer (walk-in, no account). These sales never get an Express RE, so they can never appear in กระทบยอด RE — the บิลมือ tab is their equivalent. The Payment row remains the income record (reports unchanged); the ManualBill is the receivable/receipt document, like ReReceipt is for REs.

## HARD CONSTRAINTS
- **ADD-only** Prisma migration, folder name exactly `20260718000000_juno_manual_bill` (must sort after `20260717000000_party_identity`). New model + new column only; never alter/drop existing columns. Write the migration SQL by hand consistent with neighbors (or via `prisma migrate diff`), and run `npx prisma validate`.
- **NO new npm dependencies.** NEVER run `npm install`; never modify any `package-lock.json`. If you need node_modules to verify, use `npm ci` only.
- **Do NOT write to `Product.stock`** or any Product field. Read-only product access. No Vesta/vulcan frontend changes.
- **Do NOT `git commit` or push.** Leave all changes uncommitted in this worktree.
- All "today"/year derivation in **Asia/Bangkok (UTC+7)** — see existing UTC+7 handling in the codebase; never raw `new Date()` day-math in UTC.
- Money stays the repo's **String-amount convention**; compare with the existing satang-equality helpers (see how ReRecon/`grossOf` do it in `api/src/routes/juno.ts`).
- Follow existing Juno patterns exactly — same middleware/gating as sibling routes in `api/src/routes/juno.ts`, same UI idioms as `juno/src/Juno.tsx` / `ReRecon.tsx` / `PrintCovers.tsx`. Thai labels, emerald theme.

## 1) Schema (`api/prisma/schema.prisma`)
New model (names/types final):

```prisma
model ManualBill {
  id            String    @id @default(cuid())
  billNo        String    @unique            // "MB69-0001" auto, or legacy paper no. (normalized, no "/")
  billedAt      String    @default("")       // user-entered date string, same convention as Payment.transferAt
  buyerName     String    @default("")
  buyerPhone    String    @default("")
  buyerAddress  String    @default("")
  items         Json?                         // [{productId?, sku?, name, qty, unitPrice, amount}] display-only
  amount        String    @default("")       // total = Σ line amounts, String
  note          String    @default("")
  status        String    @default("open")   // open | void   (paid-ness is computed live, never stored)
  voidedAt      DateTime?
  voidedById    String?
  createdAt     DateTime  @default(now())
  createdById   String?
  createdByName String    @default("")
  updatedAt     DateTime  @updatedAt

  @@index([status])
  @@index([createdAt])
}
```

Plus ONE new column on `Payment` (lines ~237–316): `billNos String[] @default([])` — mirrors `reNumbers` exactly (no extra index needed; joins are live JS joins like ReRecon).

## 2) Bill numbers
- Auto-number on create when `billNo` omitted: `MB` + 2-digit Buddhist year (Asia/Bangkok, e.g. 2026→2569→`69`) + `-` + 4-digit running per year → `MB69-0001`. Compute next = max existing `MB69-####` + 1 inside a transaction; on unique-violation race, retry once.
- Manual `billNo` allowed (back-entering old paper bills). **Charset rule: no `/`, `,`, or whitespace** (the verify-dialog chips input splits on those). UI auto-replaces `/`→`-` as the user types (paper books use เล่ม/เลขที่ like "38/13" → stored "38-13"); server zod rejects `[/\s,]` with a clear Thai message. Uppercase-normalize. Friendly 409 "เลขบิลนี้มีอยู่แล้ว" on duplicates.

## 3) API routes (in `api/src/routes/juno.ts`, same auth middleware as siblings)
- `GET /api/juno/bills?q=&status=` — list, newest first. Each bill returned with `linkedPayments` (id, amount, whtAmount, status, source, createdAt, customerName) and computed `billStatus`: `void` if voided; else no linked payments → `unpaid`; else Σ linked payments' **gross** (`grossOf` = amount+wht, satang-exact) == bill amount → `paid`; else `mismatch`. Live join in JS: 1 bill query + 1 payment query (`billNos` non-empty), join by billNo — copy ReRecon's approach/semantics (`GET /api/juno/re`). Also return `counts: { unpaid, mismatch }` for the tab badge. `q` matches billNo/buyerName (insensitive).
- `POST /api/juno/bills` — create (auto-number per §2). zod: billNo optional (regex per §2), billedAt/buyerName/buyerPhone/buyerAddress/note strings with sane max lengths, items = array (max 40) of `{productId? sku? name(1..300) qty(number>0) unitPrice(string max 40) amount(string max 40)}`, amount (total) required. Stamp createdById/createdByName from the authenticated agent (same as POST /payments does).
- `PATCH /api/juno/bills/:id` — edit descriptive fields (billedAt, buyer*, items, amount, note; billNo NOT editable after create). No detach logic needed — status is live-computed.
- `POST /api/juno/bills/:id/void` — set status='void', voidedAt/voidedById; body `{ void: boolean }` to allow undo, mirroring how payments handle reversible state stamps.
- `GET /api/juno/products?q=` — read-only picker over the shared `Product` model: search name + SKU **dash-insensitive** (071009 matches 07-10-09 — reuse/mimic the existing dash-insensitive SKU search used elsewhere in the repo, e.g. Diana/catalog search), limit 20, return `{id, sku (bare, dashes stripped for display per repo convention), name, price, stock, stockAt}` — check the actual Product field names in schema.prisma and use whatever the catalog price field is; omit price if the model has none.
- Extend `POST /api/juno/payments/:id/verify` (the ตรวจแล้ว endpoint): accept optional `billNos: string[]` (max 20, each per §2 regex) alongside reNumbers; persist to `Payment.billNos`. Rate-0 style semantics: absent → leave unchanged? No — mirror reNumbers handling exactly (the dialog always sends the full current array).

## 4) Frontend — new tab (in `juno/src/`)
Tab entry in the `tabs` array (`Juno.tsx` ~lines 110–128): key `bills`, label **บิลมือ**, lucide icon `ReceiptText`, badge = unpaid+mismatch count, visible to ALL Juno users, placed after `reRecon`. Renders new `Bills.tsx` (model it on `ReRecon.tsx` structure: toolbar + table + drawer).

- **List**: เลขบิล, วันที่, ผู้ซื้อ, ยอดรวม, status chip (⏳ ยังไม่จ่าย / ⚠️ ยอดไม่ตรง / ✅ จับคู่แล้ว / ยกเลิก — same visual language as ReRecon), search box, status filter, `+ ออกบิล` button.
- **Create/edit modal**: date (default today, Bangkok), buyer name/phone/address, note, and a **line-items editor**: each row = product search box (autocomplete dropdown hitting `GET /api/juno/products?q=`, shows sku · name · price · "คงเหลือ n" stock hint; picking fills sku+name+unitPrice, all still editable) OR free-text toggle for off-catalog items (name only, type price yourself); qty × unitPrice auto-computes the row amount (editable); total = Σ rows, shown live, not directly editable. Debounce the product search.
- **Drawer**: full bill detail, items table, linked payments list (from `linkedPayments`), buttons: พิมพ์บิล, แก้ไข, ยกเลิกบิล/กู้คืน (confirm dialog; available to all Juno users, same as payment void).
- **Print (`PrintBill.tsx`)**: sibling of `PrintCovers.tsx` — same overlay pattern (`window.print()` + `afterprint` + `@media print`), `@page A5 portrait`, one page per bill. Layout = Thai **บิลเงินสด**: company header block (lift the real company name/address/phone from the Diana site source under `diana/` — grep for the contact/footer info; leave a `// TODO owner review` marker on the header), เลขที่บิล + วันที่, buyer block, items table (ลำดับ/รายการ/จำนวน/หน่วยละ/จำนวนเงิน), รวมทั้งสิ้น, ผู้รับเงิน + ผู้ซื้อ signature lines. No VAT / no tax-invoice fields — this is the non-Express lane.

## 5) ตรวจแล้ว dialog change (in `Juno.tsx`, the verify/RE dialog with the reNumbers chips)
The existing chips input (splits on `/`, `,`, space; each chip currently must be 7-digit RE) becomes dual-type: a token matching `/^\d{7}$/` → RE chip (existing style/validation); any other valid token (per §2 charset, uppercased) → **บิลมือ chip** (visually distinct, e.g. amber). Soft-validate bill chips against existing bills (fetch-check; unknown → warning style "ไม่พบบิลนี้ในระบบ" but still saveable — the bill may be entered later). On save, split into `reNumbers[]` + `billNos[]` for the verify POST. พิมพ์ใบปะหน้า (covers) stays RE-only — bills print their own document from the บิลมือ tab, no cover.

Display billNos wherever reNumbers show: payment drawer (field "บิลมือ"), inbox row chips if reNumbers show there, and **export.csv** gains a บิลมือ column (`billNos.join('/')`, passed through the existing formula-injection guard). The edit-details PATCH keeps billNos structurally excluded (workflow field, like reNumbers).

## 6) Out of scope (do NOT build)
Express back-keying; any Vesta/stock write or stock decrement; ใบกำกับภาษี on bills; Venus/customer linkage; hard-delete of bills (void only); changes to Recon.tsx/refText (อ้างอิงอื่น stays as-is for legacy/other refs); reports changes (bills are not income rows — payments already carry the income).

## 7) Self-verification (all must pass before you finish)
1. `npx prisma validate` (in `api/`), and the migration folder sorts last + is ADD-only.
2. `api`: `npm ci` then `npx tsc --noEmit` clean (run `npx prisma generate` first if types are missing).
3. `juno`: `npm ci` then `npm run build` clean.
4. Grep-verify no `package-lock.json` changed (`git status`), no writes to Product, no new deps in any package.json.
5. Print a concise final summary: files changed, migration name, verification results, and anything you had to decide that deviates from this brief.
