# Jupiter Phase 2 — TONR/DENC Book-of-Record Cutover Plan

## 1. Recommended design

Make the double-entry ledger the book of record for TONR and DENC. Keep `JupiterTxn` intact as the Phase-1 management cockpit/intake table, but do not treat it as accounting evidence and do not flatten imported Odoo journal entries into it.

The transition model should be:

- `JupiterJournalEntry` + `JupiterJournalLine` are the authoritative books.
- TONR/DENC cockpit summaries switch to posted ledger P&L lines after cutover.
- Other companies continue using `JupiterTxn` until separately migrated.
- Imported Odoo moves never create `JupiterTxn` rows.
- A future Phase-1 transaction may produce at most one ledger entry through `JupiterJournalEntry.originTxnId`; until that entry is posted, the transaction is not part of the books.
- Manual Phase-1 and AI/NL transaction creation must be disabled for TONR/DENC once their `ledgerMode` becomes `book_of_record`. New accounting activity goes through the manual journal-entry form.
- Existing `JupiterTxn` routes and data remain operational for PROM/DENL/KPKF.

This avoids double counting, preserves the existing cockpit, and allows capital, construction in progress, loans, bank balances, VAT, payables, and equity to remain proper double-entry records.

---

## 2. Current-state summary

### Jupiter Phase 1

Current implementation:

- `api/prisma/schema.prisma`
  - `JupiterCompany`: five active company codes.
  - `JupiterTxn`: income/expense only, String money fields plus nullable `Decimal(14,2)` shadows.
- `api/src/routes/jupiterAccounting.ts`
  - Supervisor-only `/api/jupiter/acct/*`.
  - Summary, transaction CRUD, tax-register rollups, NL parser, and Juno sync.
  - Existing `baht()`/`decOf()` paths pass money through JavaScript `number`; these must not be reused by the ledger.
- `jupiter/src/Accounting.tsx`
  - Thai Phase-1 cockpit: ภาพรวม, บันทึกรายการ, ปิดรอบบัญชี.
  - Manual form and AI/NL form create `JupiterTxn`, not journal entries.
- `api/src/jupiter/companies.ts` and `api/src/db/ensureSeeded.ts`
  - Operational company list is PROM/TONR/DENC/DENL/KPKF.

### Verified rescue extract

Snapshot: `C:\Users\khunn\OdooRescue\2026-07-18T07-56-32-944Z\`

`manifest.json` reports `complete`, with no warnings, errors, or verification failures. No README exists in the snapshot or elsewhere under `C:\Users\khunn\OdooRescue`; therefore the importer should treat the manifest plus actual JSONL/CSV schemas as authoritative.

| Company | Accounts | Journals | Taxes | Moves | Lines | Posted subset | Posted debit = credit |
|---|---:|---:|---:|---:|---:|---|---:|
| TONR | 220 | 9 | 46 | 29 | 69 | 29 moves / 69 lines | ฿26,542,091.53 |
| DENC | 220 | 9 | 46 | 18 | 53 | 16 moves / 49 lines | ฿807,996.87 |

Additional facts:

- DENC has 2 draft moves/4 draft lines. Import them as drafts and exclude them from GL/TB/partner-ledger posted totals.
- TONR’s 29 moves are all posted.
- Account codes are present and unique for all 220 accounts in each company.
- The extract contains 22 global `res.partner` rows.
- TONR verification: 13 TB accounts, 6 partner-ledger detail lines across 2 partners.
- DENC verification: 17 TB accounts, 2 partner-ledger detail lines for 1 partner.
- Client and server rescue trial balances have zero differences.
- Odoo fields use mixed many2one representations such as `[id, displayName]` or `false`; the importer must normalize these explicitly.
- The extract includes one DENC vendor bill, tax lines, applied tax IDs, maturity dates, and both draft and posted states.

---

## 3. Prisma schema

### 3.1 Migration policy

Create `api/prisma/migrations/<next_timestamp>_jupiter_double_entry/migration.sql`.

The migration is additive only:

- No table or column removal.
- No renaming of `JupiterTxn`.
- No conversion of its String fields.
- Add nullable/defaulted ledger settings to `JupiterCompany`.
- Create new ledger tables, indexes, constraints, and immutability triggers.
- `JupiterTxn` receives only a Prisma back-relation; its database table need not change because the foreign key lives on `JupiterJournalEntry.originTxnId`.

### 3.2 Company controls

Add to `JupiterCompany`:

```prisma
baseCurrency     String    @default("THB")
ledgerMode       String    @default("cockpit") // cockpit | shadow | book_of_record | paper_only
ledgerCutoverDate DateTime? @db.Date
ledgerLockDate    DateTime? @db.Date
```

Semantics:

- `cockpit`: Phase-1 `JupiterTxn` behavior.
- `shadow`: ledger exists for validation but is not yet authoritative.
- `book_of_record`: posted journal lines are authoritative.
- `paper_only`: known legal entity, hidden from operational selection and posting.
- `ledgerLockDate`: no create, edit, post, void, or reversal dated on or before this date.
- Lock-date changes are written to the audit log. Moving the lock backward requires a reason.

### 3.3 New models

Use these model names and principal fields:

```prisma
model JupiterLedgerAccount {
  id            String   @id @default(cuid())
  companyCode   String
  code          String   // String preserves Thai CoA formatting and leading zeroes
  name          String
  accountType   String   // exact Odoo type: asset_cash, liability_payable, etc.
  accountClass  String   // asset | liability | equity | income | expense | off_balance
  normalBalance String   // debit | credit
  reconcile     Boolean  @default(false)
  active        Boolean  @default(true)
  currencyCode  String?
  source        String   @default("manual")
  sourceRef     String?
  contentHash   String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  company JupiterCompany @relation(fields: [companyCode], references: [code])

  @@unique([companyCode, code])
  @@unique([companyCode, source, sourceRef])
  @@index([companyCode, accountClass, active])
}

model JupiterLedgerJournal {
  id               String   @id @default(cuid())
  companyCode      String
  code             String
  name             String
  journalType      String   // general | bank | cash | sale | purchase
  active           Boolean  @default(true)
  defaultAccountId String?
  source           String   @default("manual")
  sourceRef        String?
  contentHash      String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([companyCode, code])
  @@unique([companyCode, source, sourceRef])
}

model JupiterLedgerTax {
  id            String   @id @default(cuid())
  companyCode   String
  name          String
  description   String   @default("")
  taxKind       String   @default("unclassified")
  // vat_input | vat_output | wht_payable | wht_receivable | other | unclassified
  usage         String   @default("none") // sale | purchase | none
  amountType    String   @default("percent")
  rate          Decimal  @db.Decimal(9, 6)
  priceIncluded Boolean  @default(false)
  active        Boolean  @default(true)
  source        String   @default("manual")
  sourceRef     String?
  contentHash   String?

  @@unique([companyCode, source, sourceRef])
  @@index([companyCode, taxKind, active])
}

model JupiterLedgerPartner {
  id             String   @id @default(cuid())
  displayName    String
  legalName      String   @default("")
  taxId          String   @default("")
  partnerType    String   @default("other") // customer | vendor | both | other
  address        String   @default("")
  partyId        String?  // optional link to canonical Party; never auto-merge by name
  source         String   @default("manual")
  sourceRef      String?
  contentHash    String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([source, sourceRef])
  @@index([taxId])
  @@index([partyId])
}

model JupiterJournalEntry {
  id                 String    @id @default(cuid())
  companyCode        String
  journalId          String
  entryNo            String?   // assigned atomically on posting; Odoo name for imports
  entryDate          DateTime  @db.Date
  state              String    @default("draft") // draft | posted | void
  entryType          String    @default("general")
  ref                 String   @default("")
  memo                String   @default("")
  partnerId           String?
  documentNo          String   @default("")
  documentDate        DateTime? @db.Date
  dueDate             DateTime? @db.Date
  paymentReference    String   @default("")
  paymentState        String   @default("")
  taxInvoiceNo        String   @default("")
  taxInvoiceDate      DateTime? @db.Date
  whtCertificateNo    String   @default("")
  currencyCode        String   @default("THB")
  version             Int      @default(1)

  source              String   @default("manual")
  sourceRef           String?
  sourceSnapshotRef   String?
  contentHash         String?
  originTxnId         String?   @unique
  reversalOfId        String?   @unique

  createdById         String?
  createdByName       String   @default("")
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  postedById          String?
  postedByName        String   @default("")
  postedAt            DateTime?
  voidedAt            DateTime?

  lines JupiterJournalLine[]

  @@unique([companyCode, entryNo])
  @@unique([companyCode, source, sourceRef])
  @@index([companyCode, entryDate, state])
  @@index([journalId, entryDate])
  @@index([partnerId, entryDate])
}

model JupiterJournalLine {
  id                    String   @id @default(cuid())
  entryId               String
  lineNo                Int
  accountId             String
  partnerId             String?
  label                 String   @default("")
  debit                 Decimal  @default(0) @db.Decimal(18, 2)
  credit                Decimal  @default(0) @db.Decimal(18, 2)
  amountCurrency        Decimal? @db.Decimal(18, 2)
  currencyCode          String?
  maturityDate          DateTime? @db.Date
  reconciled            Boolean  @default(false)
  externalReconcileRef  String?
  sourceRef             String?
  createdAt             DateTime @default(now())

  entry JupiterJournalEntry @relation(fields: [entryId], references: [id])
  taxes JupiterJournalLineTax[]

  @@unique([entryId, lineNo])
  @@unique([entryId, sourceRef])
  @@index([accountId, entryId])
  @@index([partnerId, entryId])
}

model JupiterJournalLineTax {
  id         String   @id @default(cuid())
  lineId     String
  taxId      String
  role       String   // applied | tax_line
  baseAmount Decimal? @db.Decimal(18, 2)
  taxAmount  Decimal? @db.Decimal(18, 2)

  @@unique([lineId, taxId, role])
}

model JupiterJournalSequence {
  id          String @id @default(cuid())
  companyCode String
  journalId   String
  fiscalYear  Int
  nextNo      Int    @default(1)

  @@unique([companyCode, journalId, fiscalYear])
}

model JupiterLedgerImportBatch {
  id               String    @id @default(cuid())
  source           String    // sync:odoo
  snapshotRef      String    // e.g. 2026-07-18T07-56-32-944Z
  manifestSha256   String
  status           String    // running | verified | failed
  requestedCompanies Json
  result           Json?
  startedAt        DateTime  @default(now())
  completedAt      DateTime?
  createdByName    String    @default("cli")

  @@unique([source, manifestSha256])
}

model JupiterLedgerAudit {
  id          String   @id @default(cuid())
  companyCode String?
  entityType  String   // entry | line | company_lock | import_batch
  entityId    String
  action      String   // create | edit_draft | post | reverse | void | lock_change | import
  reason      String   @default("")
  before      Json?
  after       Json?
  actorId     String?
  actorName   String   @default("")
  requestId   String?
  createdAt   DateTime @default(now())

  @@index([entityType, entityId, createdAt])
  @@index([companyCode, createdAt])
}
```

### 3.4 Database and service invariants

Add PostgreSQL checks to the migration:

- `debit >= 0` and `credit >= 0`.
- A line cannot have both debit and credit greater than zero.
- A posted entry must not be updated or deleted.
- Lines belonging to a posted entry must not be inserted, updated, or deleted.
- State and ledger-mode values are limited to their documented values.

Cross-row balance is enforced inside the posting service:

- At least two nonzero lines.
- Every account, journal, and partner reference exists.
- Account and journal belong to the same company as the entry.
- Sum of debits equals sum of credits exactly to ฿0.01.
- Entry date is after `ledgerLockDate`.
- No JavaScript floating-point conversion. Normalize the input String and call `new Prisma.Decimal(normalizedString)` directly.
- JSON responses return amounts as fixed two-decimal Strings.
- Posted corrections use a new reversing entry; the original remains included in reports.
- `version` provides optimistic concurrency for draft editing.

---

## 4. `JupiterTxn` relationship and cockpit behavior

Do not backfill Odoo entries into `JupiterTxn`.

Use `JupiterJournalEntry.originTxnId` as an optional one-to-one link:

- Null: direct manual JE or Odoo import.
- Non-null: entry generated from a Phase-1 intake transaction.
- The ledger entry, not the linked `JupiterTxn`, is the accounting record.
- Only a posted linked entry affects official ledger reports.

Modify existing cockpit reads by company mode:

- `cockpit`: current `JupiterTxn` summary.
- `shadow`: retain current cockpit summary; show ledger reconciliation separately.
- `book_of_record`: calculate revenue from posted income-account credits less debits, and expenses from posted expense-account debits less credits.
- Balance-sheet lines—capital, CIP, loans, bank, receivables, and payables—do not enter revenue/expense KPIs.
- `ALL` may combine ledger-derived TONR/DENC values with Phase-1 values for other companies, but must be labelled “ภาพรวมเพื่อการบริหาร,” not a consolidated financial statement.
- Existing `/txns` data remains visible. For book-of-record companies label it “รายการรับเข้าเดิม — ไม่ใช่สมุดบัญชี.”
- Hide Phase-1 manual and NL creation for TONR/DENC after activation.
- Do not use the existing `/registers` result as official tax data for TONR/DENC. Replace that area with GL/TB/partner-ledger exports and a “tax filing not included in this phase” notice.

Before activation, query whether TONR or DENC already has `JupiterTxn` rows. Review them individually; do not auto-convert them. A real transaction must either receive a deliberate balanced JE linked through `originTxnId` or be documented as excluded/duplicate.

---

## 5. Importer design

### 5.1 Files

Add:

- `api/src/scripts/importOdooRescue.ts` — CLI.
- `api/src/jupiter/ledger/importOdoo.ts` — mapping and persistence.
- `api/src/jupiter/ledger/money.ts` — exact decimal parsing.
- `api/src/jupiter/ledger/posting.ts` — balance/post/reversal rules.
- `api/src/jupiter/ledger/reports.ts` — shared report queries.
- `api/src/jupiter/ledger/types.ts` — source and API types.

CLI:

```text
tsx src/scripts/importOdooRescue.ts \
  --snapshot <path> \
  --companies TONR,DENC \
  --dry-run
```

Apply requires a separate explicit `--apply`. The importer must never delete or truncate ledger data.

### 5.2 Company mapping

Map the manifest’s Odoo company IDs explicitly:

| Odoo ID | Code |
|---:|---|
| 1 | APPT |
| 2 | TONR |
| 3 | DENC |
| 4 | PROM |
| 5 | DENL |
| 6 | KPKF |

Reject any row whose `company_id` disagrees with its folder mapping.

### 5.3 Stable provenance

Use:

- `source = "sync:odoo"`
- Partner `sourceRef = "res.partner:<id>"`
- Account `sourceRef = "<company>:account.account:<id>"`
- Journal `sourceRef = "<company>:account.journal:<id>"`
- Tax `sourceRef = "<company>:account.tax:<id>"`
- Entry `sourceRef = "<company>:account.move:<id>"`
- Line `sourceRef = "<company>:account.move.line:<id>"`

Do not include the snapshot timestamp in `sourceRef`; Odoo record IDs must remain stable across snapshots. Store the timestamp separately in `sourceSnapshotRef` and `JupiterLedgerImportBatch.snapshotRef`.

Canonicalize each source object and store `contentHash`:

- Same `sourceRef` + same hash: no-op.
- Same `sourceRef` + different hash on a draft: update the draft and replace its imported lines transactionally.
- Same `sourceRef` + different hash on a posted entry: fail with `posted_source_conflict`; never mutate it silently.
- New `sourceRef`: insert.

Because posted source changes would create conflicts, rehearse using the current snapshot in a disposable/staging database. Import production only after the final Odoo booking freeze and final snapshot.

### 5.4 Import order

1. Validate `manifest.json`: complete, no failures/errors, expected files present.
2. Import the 22 global partners into `JupiterLedgerPartner`.
3. For TONR and DENC, import accounts.
4. Import journals and resolve default accounts.
5. Import tax masters.
6. Import move headers.
7. Import move lines, resolving account, journal, partner, and tax IDs.
8. Import line-tax associations from `tax_ids` and `tax_line_id`.
9. Validate each move’s balance.
10. Recompute GL, TB, and partner-ledger results from Jupiter.
11. Record counts, hashes, balances, and comparisons in `JupiterLedgerImportBatch.result`.

Use one transaction per company after preflight. Keep company mode at `shadow` throughout import and reconciliation.

### 5.5 Data mapping rules

- Preserve Odoo account code as String without numeric conversion.
- Store exact Odoo `account_type`; derive `accountClass` separately.
- Normalize Odoo `/` draft move names to `entryNo = null`.
- Preserve DENC’s 2 draft moves as `state = "draft"`.
- Only `parent_state = "posted"` lines enter posted reports.
- Preserve line partner, due date, reconcile flag, matching/full-reconcile reference, currency, amount currency, VAT associations, and Odoo line ID.
- Do not infer VAT/WHT classification solely from Thai/English tax names. Import uncertain taxes as `taxKind = "unclassified"` and require an explicit mapping review.
- Do not auto-link imported partners to the canonical `Party` table by name. Only exact Odoo identity, confirmed tax ID, or manual review may create that link.
- Do not commit the business extract or derived fixtures to the repository.

---

## 6. API routes

Keep the existing supervisor gate and `/api/jupiter/acct` prefix. Put new routes in `api/src/routes/jupiterLedger.ts` and register them from `api/src/index.ts`.

### Reference data

- `GET /api/jupiter/acct/accounts?company=TONR&active=true`
- `GET /api/jupiter/acct/journals?company=TONR&active=true`
- `GET /api/jupiter/acct/partners?search=...&limit=50`
- `GET /api/jupiter/acct/taxes?company=DENC&active=true`

### Journal entries

- `GET /api/jupiter/acct/entries?company=&from=&to=&state=&journal=&account=&limit=&cursor=`
- `GET /api/jupiter/acct/entries/:id`
- `POST /api/jupiter/acct/entries` — create draft.
- `PATCH /api/jupiter/acct/entries/:id` — replace header/lines on a draft, requiring `version`.
- `POST /api/jupiter/acct/entries/:id/post`
- `POST /api/jupiter/acct/entries/:id/reverse` — body contains reversal date and reason.
- `POST /api/jupiter/acct/entries/:id/void` — drafts only; retain audit history.
- `PATCH /api/jupiter/acct/companies/:code/ledger-settings` — mode, cutover date, and lock date.

Manual draft request:

```json
{
  "companyCode": "TONR",
  "journalId": "...",
  "entryDate": "2026-07-18",
  "ref": "...",
  "memo": "...",
  "partnerId": null,
  "documentNo": "",
  "documentDate": null,
  "taxInvoiceNo": "",
  "taxInvoiceDate": null,
  "whtCertificateNo": "",
  "version": 1,
  "lines": [
    {
      "lineNo": 1,
      "accountId": "...",
      "partnerId": null,
      "label": "...",
      "debit": "1000.00",
      "credit": "0.00",
      "taxes": []
    },
    {
      "lineNo": 2,
      "accountId": "...",
      "partnerId": null,
      "label": "...",
      "debit": "0.00",
      "credit": "1000.00",
      "taxes": []
    }
  ]
}
```

Return `400` for malformed decimals, `409` for stale version, source conflict, lock-date violation, or attempted posted-entry mutation.

### CPA-facing reports

Company is mandatory; do not issue a pseudo-consolidated CPA report.

- `GET /api/jupiter/acct/reports/gl?company=&from=&to=&state=posted&format=json|csv`
- `GET /api/jupiter/acct/reports/trial-balance?company=&from=&to=&format=json|csv`
- `GET /api/jupiter/acct/reports/partner-ledger?company=&from=&to=&partnerId=&format=json|csv`

Rules:

- Default to posted only.
- Date filters are inclusive and use accounting dates, not UTC timestamps.
- GL order: date, entry number, line number.
- TB includes opening balance, period debit, period credit, and closing balance in JSON.
- A reconciliation-compatible CSV mode emits the rescue columns exactly:
  - TB: `account_id,account_code,account_name,debit,credit,balance,line_count`
  - Partner ledger: existing rescue header including `row_type`, partner, move, account, debit, credit, balance, line ID, and parent state.
- Partner running balance is `debit - credit`.
- CSV uses RFC 4180 quoting, UTF-8 BOM, Thai-safe text, and fixed two-decimal amounts.
- JSON decimal values remain Strings.

---

## 7. UI

Continue the patterns already used in `jupiter/src/Accounting.tsx`: Thai-first labels, company chips, compact Tailwind cards/tables, supervisor-only controls, and the existing violet visual system.

Update:

- `jupiter/src/lib/api.ts` with ledger types and request functions.
- `jupiter/src/Accounting.tsx` for company-mode routing and navigation.
- Prefer new components rather than further enlarging the existing file:
  - `jupiter/src/accounting/JournalEntries.tsx`
  - `jupiter/src/accounting/JournalEntryForm.tsx`
  - `jupiter/src/accounting/LedgerReports.tsx`
  - `jupiter/src/accounting/EntryDetail.tsx`

Recommended tabs:

- `ภาพรวม`
- `สมุดรายวัน`
- `รายการรับเข้าเดิม` — existing Phase-1 rows
- `รายงานบัญชี`
- `ต้นทุน AI`

Manual JE form labels:

- บริษัท
- วันที่ลงบัญชี
- สมุดรายวัน
- เลขที่อ้างอิง
- คู่ค้า
- เลขที่เอกสาร / วันที่เอกสาร
- เลขที่ใบกำกับภาษี / วันที่ใบกำกับภาษี
- เลขที่หนังสือรับรองหัก ณ ที่จ่าย
- รายการบัญชี
- รหัสบัญชี / ชื่อบัญชี
- คำอธิบาย
- เดบิต
- เครดิต
- รวมเดบิต / รวมเครดิต / ผลต่าง
- บันทึกร่าง
- ตรวจสอบและผ่านรายการ

Behavior:

- Account selector searches code and name but always displays the code.
- Debit/credit totals update with exact decimal-string arithmetic.
- Posting is disabled until balanced.
- Posting confirmation clearly states that a posted entry cannot be edited.
- Posted entries offer “กลับรายการ,” not delete/edit.
- Drafts show a visible `ร่าง` badge.
- Imported entries show `นำเข้าจาก Odoo`.
- Book-of-record companies show `สมุดบัญชีหลัก` beside their chips.
- Hide the NL panel for TONR/DENC.
- Replace misleading Phase-1 tax-register cards for TONR/DENC with GL/TB/partner-ledger exports and the notice `ยังไม่รวมการยื่น ภ.พ.30 ในระยะนี้`.

---

## 8. Rollout order

1. **Schema and invariants**
   - Add models, constraints, ledger settings, and Prisma relations.
   - Deploy with every company still in `cockpit`.

2. **Ledger services**
   - Implement exact money parsing, draft validation, posting, sequencing, lock enforcement, reversal, and audit logging.
   - Add synthetic tests; no rescued business data in Git.

3. **Importer rehearsal**
   - Run `--dry-run` against the current rescue extract.
   - Import to a disposable/staging database.
   - Prove expected counts, per-entry balance, TB equality, and partner-ledger equality.

4. **API and reports**
   - Add journal-entry and CPA report routes.
   - Verify CSVs in Excel with Thai names and two-decimal values.

5. **UI**
   - Add manual JE, entry list/detail, and reports.
   - Keep Phase-1 cockpit available.
   - UAT with synthetic TONR/DENC entries and reversals.

6. **Pre-cutover audit**
   - Inspect existing TONR/DENC `JupiterTxn` rows.
   - Confirm tax mapping and treatment of DENC’s two Odoo drafts.
   - Confirm cutover accounting date and lock date.

7. **Odoo booking freeze**
   - Stop new TONR/DENC booking in Odoo.
   - Record the freeze time in Asia/Bangkok and the first Jupiter accounting date.
   - Do not allow the same business transaction to be entered in both systems.

8. **Final rescue snapshot**
   - Take a new full snapshot immediately before cancellation.
   - Require manifest status `complete`, no errors/failures, 100% account-code resolution, and balanced posted totals.
   - Archive the snapshot in two controlled locations.

9. **Production import**
   - Run dry-run against the final snapshot.
   - Import TONR/DENC with `ledgerMode = "shadow"`.
   - Do not activate if any source conflict or reconciliation difference exists.

10. **Reconciliation and sign-off**
    - Compare Jupiter to the final snapshot, not the current baseline.
    - Require:
      - Account, journal, tax, move, line, and partner counts match.
      - Draft/posted counts match.
      - Every posted entry balances.
      - Company posted total debit equals total credit.
      - Every account’s debit, credit, balance, and line count matches `trial_balance_client.csv`.
      - Jupiter TB also agrees with `trial_balance_server.csv`.
      - Partner-ledger detail lines and totals match.
      - Difference is exactly ฿0.00, not a rounded tolerance.
    - Save the reconciliation result in `JupiterLedgerImportBatch.result`.
    - Obtain owner/CPA sign-off.

11. **Activation**
    - Set TONR and DENC to `ledgerMode = "book_of_record"`.
    - Set `ledgerCutoverDate`.
    - Set `ledgerLockDate` only through the last confirmed closed period, not automatically to the import date.
    - Disable TONR/DENC Phase-1 manual/NL creation.
    - Begin all new entries through the manual JE form.

12. **Cancellation**
    - Cancel Odoo only after the final snapshot, exact reconciliation, export archive verification, and sign-off.
    - Retain the rescue snapshot permanently as migration evidence.

Verification commands during implementation:

```text
npm --prefix api run prisma:generate
npm --prefix api run typecheck
npm --prefix api run test
npm --prefix jupiter run typecheck
npm --prefix jupiter run build
```

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Odoo README is absent | Version and validate the actual manifest/JSONL/CSV contracts; reject unknown schema versions. |
| DENC drafts accidentally affect balances | Preserve as drafts; all official reports default to posted only. |
| Float rounding creates imbalance | Never use `parseFloat`, `number`, `baht()`, or current `decOf()` in ledger paths. |
| Cockpit and ledger double-count | Select one summary source per company based on `ledgerMode`; never import Odoo into `JupiterTxn`. |
| Posted Odoo data changes between snapshots | Rehearse in staging; freeze Odoo and import production only from the final snapshot; hash conflicts fail closed. |
| Tax IDs exist but statutory meaning is incomplete | Preserve source tax relations; classify uncertain taxes as `unclassified`; defer tax returns. |
| Odoo tax repartition definitions are not fully exported | Preserve available IDs and line relationships; do not claim ภ.พ.30 readiness. |
| Global partners collide with existing Pantheon parties | Use `JupiterLedgerPartner`; do not name-match into `Party`. |
| Imported entries are edited after cutover | Posted immutability at API and database-trigger levels; corrections by reversal only. |
| Backdated entries alter closed periods | Company lock date plus audited lock changes. |
| Mixed-mode `ALL` summary is mistaken for statutory consolidation | Label it management-only and require a single company for CPA reports. |
| Cutover-day transactions appear in both systems | Record freeze time and review the final snapshot against all first-day Jupiter entries. |
| Local rescue data leaks into Git | Import directly from the external path; use only synthetic committed test fixtures. |

---

## 10. Explicit non-goals

This phase does not include:

- ภ.พ.30 preparation, filing, or submission.
- Full Thai VAT return logic or Odoo tax-repartition reconstruction.
- Express/PROM parallel-ledger comparison.
- PROM, DENL, or KPKF book-of-record cutover.
- Natural-language or AI-generated journal entries.
- Automatic conversion of `JupiterTxn` into journal entries.
- Bank reconciliation UI.
- AR/AP aging, payment matching, or a full reconciliation engine beyond preserving imported references.
- Inventory, fixed-asset depreciation schedules, payroll, or consolidation/elimination entries.
- Direct CPA login or external self-service portal.
- Editing or deleting posted journal entries.

---

## 11. Open questions and recommendations

1. **Add APPT as an inactive sixth company?**  
   **Recommendation: yes.** Add `JupiterCompany(code="APPT", active=false, ledgerMode="paper_only")` so the legal entity and Odoo mapping are not lost. Do not add APPT to the operational `GROUP_COMPANY_CODES`, because that list also controls Ceres and deity tagging. Introduce a separate ledger/import code set containing APPT plus the five operational entities. Do not import APPT’s 218-account CoA in this TONR/DENC phase unless needed for archival browsing.

2. **What happens to DENC’s two Odoo drafts?**  
   **Recommendation:** import them as drafts, clearly marked `นำเข้าจาก Odoo`, but do not post automatically. The owner/CPA should post, void, or replace each after reviewing its supporting document.

3. **What are the effective cutover and lock dates?**  
   **Recommendation:** record a precise Odoo freeze timestamp and explicit first-Jupiter accounting date. Set `ledgerCutoverDate` to that agreed date. Set `ledgerLockDate` only to the last CPA-confirmed closed period—likely month-end—not automatically to the cutover date.

4. **Are there existing TONR/DENC `JupiterTxn` rows?**  
   **Recommendation:** audit before activation. Never bulk-convert them. Link a deliberately prepared JE where the transaction is real; document exclusions and duplicates.

5. **How should the 46 Odoo taxes per company be classified?**  
   **Recommendation:** preserve all source tax records and relationships, then approve a small explicit mapping for taxes actually used by TONR/DENC. Leave unused or ambiguous taxes `unclassified`.

6. **Should the CPA receive system access?**  
   **Recommendation:** not in this phase. Provide supervisor-generated GL, TB, and partner-ledger CSVs. A read-only CPA role can be designed later without delaying cutover.

7. **Should the current Phase-1 tax-register cards remain visible for TONR/DENC?**  
   **Recommendation:** no. Showing `JupiterTxn` VAT/WHT totals beside an authoritative double-entry ledger would be misleading. Replace them with ledger reports and an explicit tax-return non-goal notice.

