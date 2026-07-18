# Odoo accounting rescue

One-shot, read-only JSON-RPC extraction for all five Appoint Alliance companies. It uses plain Node.js 18+ with no packages and writes the rescue outside this repository.

## 1. Mint an API key

1. Sign in to `https://appoint.odoo.com` as a user that can read all five companies and all accounting records.
2. Open the user menu, then **Preferences → Account Security → New API Key**.
3. Give the key a short-lived name such as `Odoo rescue 2026-07`, copy it once, and keep it out of files, shell history, screenshots, and chat.
4. Revoke the key after the verified rescue is copied to durable backup storage.

Run the export while users are not posting or editing accounting entries. The count checks detect additions/deletions, but no JSON-RPC export can provide a database-wide transaction snapshot while records are changing.

## 2. Configure exact company names

The small `CONFIG.companyNameToCode` block at the top of `odoo-rescue.js` is the only company mapping. Matching is case/whitespace-normalized but never fuzzy.

On the first smoke run, the tool prints every visible `res.company`. If any name is unmapped it exits before counts or export. Copy the exact printed names into the config and rerun. It also refuses duplicate codes, extra companies, or anything other than exactly `PROM`, `TONR`, `DENC`, `DENL`, and `KPKF`.

## 3. Set credentials for this PowerShell session

```powershell
$env:ODOO_URL = "https://appoint.odoo.com"
$env:ODOO_DB = "appoint"
$env:ODOO_LOGIN = "<your Odoo login>"
$env:ODOO_API_KEY = "<paste the newly minted API key>"
```

`ODOO_URL` and `ODOO_DB` have the values above by default. `ODOO_LOGIN` and `ODOO_API_KEY` are required. The script never prints the API key and never stores credentials in output or checkpoints.

## 4. Smoke test

From the repository root:

```powershell
node tools/odoo-rescue/odoo-rescue.js --smoke
```

Smoke mode authenticates, prints the company mapping, prints `search_count` for accounts, journals, taxes, moves, and move lines per company, and groups `ir.attachment` metadata counts by `res_model`. It does not download attachments or write export files. Do not proceed until all five mappings and the visible counts look plausible.

## 5. Full extraction

```powershell
node tools/odoo-rescue/odoo-rescue.js
```

The default destination is:

```text
C:\Users\khunn\OdooRescue\<UTC-run-timestamp>\
```

The run contains `_global` for companies, currencies, and all partners; one folder per company for accounts, journals, taxes, moves, journal items, GL CSV, trial-balance files, and partner-ledger files; `.checkpoints`; and `manifest.json`. JSONL is the archival source of truth. CSV files are UTF-8 with BOM for Thai text in Excel.

To choose a brand-new empty run directory:

```powershell
node tools/odoo-rescue/odoo-rescue.js --output "C:\Users\khunn\OdooRescue\manual-run-name"
```

## 6. Resume after a crash

Use the exact existing run directory; do not start a second default run:

```powershell
node tools/odoo-rescue/odoo-rescue.js --resume "C:\Users\khunn\OdooRescue\<run-timestamp>"
```

Each `(model, company)` has a durable checkpoint containing the last ID, committed byte offset, and row count. On resume, the JSONL file is truncated to that byte offset before the `id > lastId` cursor continues, preventing duplicates after a crash between a file append and checkpoint update. Completed model snapshots are reused only if their file count still equals Odoo; if Odoo changed afterward, start a fresh run.

## 7. Mandatory verification before cancellation

Open `manifest.json` and require all of the following:

- `status` is `complete`, `errors` is empty, and `beYearFlags` is empty.
- Every entry has `fileRows == serverSearchCountAfter`.
- Each company verification has equal `postedDebit` and `postedCredit`.
- Every company has `trialBalanceNonzeroDiffs: 0`; inspect its client, server, and diff TB files.
- The five company folders and `_global` are present, files are non-empty where smoke counts were nonzero, and Thai text opens correctly in CSV.

Any date-like value whose year is 2400 or later is recorded as a loud Buddhist-era alert and makes the run fail. Odoo dates are expected to be Gregorian ISO dates.

After verification, copy the entire timestamped directory (including manifest and checkpoints) to at least two controlled backup locations. Keep the original JSONL unchanged; use CSV or copies for analysis/import work.

## Offline verification and help

```powershell
node --check tools/odoo-rescue/odoo-rescue.js
node tools/odoo-rescue/odoo-rescue.js --selftest
node tools/odoo-rescue/odoo-rescue.js --help
```

`--selftest` uses a built-in fake RPC fixture under the operating-system temp directory. It tests paging, a simulated crash and duplicate-free resume, trial-balance grouping, JSONL, UTF-8-BOM CSV escaping, and checkpoint completion, then removes its scratch directory.

## Follow-ups intentionally out of scope for v1

- Download actual attachment and invoice PDF binaries (smoke mode exports counts only).
- Stock and inventory models, valuation layers, lots/serials, and warehouse history.
- HR, employee, attendance, leave, and payroll models.
