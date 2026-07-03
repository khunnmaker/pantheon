# Ceres — Expenses & Petty Cash (build brief)

> Hand this file to a fresh session. It is self-contained: it assumes **no** memory of the chat
> it was written in. Ceres is a NEW project in Prominent's "Deities" suite — **Minerva** (sales/
> LINE AI), **Vulcan** (stock), **Diana** (B2B website), **Juno** (income/payments) — and it is
> the **EXPENSE** side of the money: Juno watches money IN, Ceres watches money OUT, on the same
> shared database. Build Ceres in the **same monorepo** (`C:\Users\khunn\Project\Minerva`).
> (Ceres: Roman goddess of the harvest — the money that feeds daily operations.)

---

## 1. Mission

Ceres replaces a Google Apps Script web app ("ระบบค่าใช้จ่าย MSG") + Google Sheets that today
manage Prominent's **petty-cash float and company expenses**. The GAS version works but is
Sheets-as-database: settlement is literally data surgery (sentinel "System: Rollover" rows,
deleting/moving rows between Data_Log → History_Log), balances are full-sheet scans, there is a
hardcoded admin password, no per-user accountability, and anyone with sheet access can silently
edit history. Ceres re-founds the SAME battle-tested workflow on Postgres with real logins, an
AI reviewer, and tamper-evident records. **The GAS app is fully replaced** (owner decision — no
sheet mirror this time).

## 2. The five processes (owner's spec — build to these)

**P1 — Petty cash (messengers, daily):**
1. Every morning each messenger (คนส่งของ: ต้า, อาร์ม, แมน, บุญสอน, แก้ว, ลุงโก๊ะ, วง, แป๋ง, นุ่น, นี,
   พิณ, เล็กแม่บ้าน, ด้า + carrier categories J&T / LALAMOVE Prom / LALAMOVE Dentalport / ทั่วไป)
   comes to the MD (**Nee**), who gives them an estimated cash advance.
2. Each messenger spends (delivery fees, fuel, tolls, misc), keeps change + receipts, and
   **enters their own expenses into Ceres from their phone** (photo of each receipt).
3. End of day: messenger returns change + receipts to Nee. Ceres shows Nee the **expected
   change per messenger** (advance − approved expenses) so she counts cash against the number.
   She approves each entry / the person's day.
4. Nee **closes the day manually** (settlement). Outstanding advances roll forward per person;
   remaining cash becomes the new float base. In Postgres this is an APPEND-ONLY snapshot —
   never move/delete rows like the GAS version did.
5. After Nee's approval, the **AI reviews** (post-hoc second pair of eyes) and the **CEO
   reviews nightly** (P4).

**P2 — MD's company-account small payments (PRE-approval — corrected):**
1. Before paying anything from the company account, MD submits the payment to Ceres and **must
   get approval BEFORE paying**: the **AI approves** when it's within written policy; an AI
   reject/escalation goes to the **CEO**; and **any amount > 5,000 THB always requires CEO
   approval before payment**. Nothing is paid without a green light.

**P3 — Recurring payments (electric, phone, …):**
1. Handled by MD, **AI-approved against a recurring template** (same payee, amount within
   tolerance of history, correct billing period, not already paid this cycle) — else escalate
   to CEO. Bonus: Ceres knows the schedule, so it should **alert when an expected bill has NOT
   appeared** (missed-payment reminder).

**P4 — CEO nightly oversight + top-up:**
1. The CEO reviews every day: escalations awaiting him, **every AI decision with its logged
   reasoning**, the day's cash picture.
2. When the balance drops **below 40,000 THB**, the CEO transfers a top-up that brings it
   **just above the floor** (Ceres computes/suggests the shortfall amount).

**P5 — Bank statement + reconciliation (daily/weekly):**
1. Nee exports the bank statement **every day** and uploads it into Ceres (it is thereby "sent
   to the CEO" — it appears in his nightly view, archived immutably).
2. Ceres auto-matches statement lines ↔ recorded transactions (P2/P3 payments, P4 top-ups) and
   flags unmatched lines BOTH ways. Petty cash (P1) reconciles physically at Nee's daily close.
3. **Integrity model (owner's explicit concern: "even she can modify the record"):** records
   are append-only with a visible revision trail (an edit after approval creates a new revision,
   never a silent overwrite); every uploaded statement file is archived with a SHA-256 hash.
   The CEO does a **weekly physical cross-check** against paper records — Ceres provides a
   weekly export pack for that.

## 3. Decisions locked (do not re-litigate)

1. Messengers **self-enter** on their phones; **Nee approves**; **AI + CEO review**.
2. **Replace** the GAS app entirely (no sheet mirror).
3. Receipts are **uploaded photos** (phone camera, document-scan feel: capture + crop) stored
   in the app — NOT Google Drive links.
4. Daily settlement stays **manual** (Nee presses close).
5. **Every expense is tagged by entity: PROM or DENL** (Dentalport) — the categories already
   half-encode this (LALAMOVE Prom vs LALAMOVE Dentalport).
6. P2 = **pre-approval** (AI gate BEFORE payment); **> 5,000 THB = CEO pre-approval, always**.
7. Top-up target = **just above the 40,000 floor** (suggest the shortfall, round up).
8. Daily statement upload by Nee; **weekly physical cross-check by the CEO**.
9. AI reviewer is **fail-closed**: ambiguous or AI-unavailable → escalate to CEO, never
   auto-approve. Every verdict logged with reasoning.

## 4. Context you need

- **Repo:** `C:\Users\khunn\Project\Minerva` (monorepo) — github.com/khunnmaker/minerva; `main`
  auto-deploys on Railway. Siblings already in it: `/api` + `/web` (Minerva, Node+TS+Fastify+
  Prisma+Postgres / Vite+React+Tailwind), `vulcan/` and `juno/` (separate static Vite frontends
  served by `serve`, each its own Railway service, pointed at the api via `VITE_API_URL`).
- **One Prisma schema, one DB, Minerva's api is the SOLE migrator.** Add Ceres tables to
  `api/prisma/schema.prisma`, migrations ADD-only. Ceres backend routes live IN the api (like
  `api/src/routes/juno.ts` / `stock.ts`).
- **Auth pattern to reuse:** JWT + bcrypt (`api/src/auth/`), roles re-validated against the live
  DB row per request; canonical staff synced on boot from env passwords
  (`api/src/db/ensureSeeded.ts`). Ceres adds new roles (see §5).
- **Receipt-OCR pattern to reuse:** Minerva already OCRs payment slips with Claude vision
  (`api/src/llm/readSlip.ts` + `callClaudeWithImage` in `api/src/llm/anthropic.ts` — note the
  `SystemPrompt` cached-blocks type). Same approach for receipts: vision reads amount / date /
  vendor → PREFILLS the messenger's form (editable — receipts are messier than bank slips);
  a mismatch between OCR and the entered amount is flagged to Nee and the AI reviewer.
- **Bank import — COORDINATE WITH JUNO:** the Juno workstream is building KBIZ (Kasikorn) CSV
  statement import + reconciliation for the INCOME side (see `docs/JUNO_PROCESS_BRIEF.md`,
  branch `juno-re-check`, Phase B). **Reuse the same KBIZ parser** for Ceres's P5 — do not
  write a second one. Ask the owner which account Nee's statement comes from (see §10).
- **The old GAS system** (for reference + possible history import): sheets `Data_Log`
  (timestamp, date, name, expenseType, amount, status, receiptLink, adminApproval),
  `Budget_Log` (timestamp, amount, Withdrawal|Refund|Deposit, name, expenseType),
  `History_Log`, `Settlement_History`. Expense types embed carrier + customer name
  ("ค่าขนส่ง SD - ลูกค้า: X"). ⚠️ Its admin password (`prom5951`) is hardcoded in source and has
  been shared in chat — **remind the owner to rotate/kill the GAS deployment** during cutover.

## 5. Roles & auth

| Role | Who | Can |
|---|---|---|
| `messenger` | each messenger (per-person login, phone-friendly) | create/edit OWN pending expenses only; see own history/outstanding |
| `md` | Nee | give advances, approve P1 entries, record P2/P3 (submit for approval), daily close, upload statements, reconcile |
| `ceo` | the owner | everything read; approve escalations + >5k; nightly review; top-ups; weekly pack |

Reuse the Agent table with new role values (Minerva console routes are already gated to
`agent`/`supervisor`, so messengers get nothing there). Messenger accounts: simplest is a
boot-synced list like Minerva's staff (env password per group or per person — CONFIRM with the
owner; 13+ people, phone logins, maybe a shared messenger password + per-person account, or
PINs). Ceres frontend must be genuinely mobile-first — messengers use phones.

## 6. Schema sketch (names indicative; ADD-only migration)

- `CashAccount` — `pettyCash` (physical box) and `bank` (MD's company account); balance is a
  QUERY over movements, never a stored mutable number.
- `CashMovement` — deposit / advance(withdrawal) / refund / topup; accountId, personName or
  agentId, entity, amount, note, createdBy, createdAt. Append-only.
- `CeresExpense` — who (messenger agentId or MD), entity `PROM|DENL`, category (keep the GAS
  category set incl. per-carrier shipping + customer-name note), amount, receipt image ref,
  OCR-extracted fields, status lifecycle `pending → approved (Nee) → ai_reviewed
  (ok|flagged) → settled`, revision trail (edits after approval = new revision rows or an
  `ExpenseRevision` table).
- `PaymentRequest` — P2/P3 pre-approval objects: requester, entity, payee, amount, category,
  recurringTemplateId?, status `requested → ai_approved | escalated → ceo_approved |
  rejected → paid` (MD marks paid AFTER approval; >5,000 skips straight to `escalated`).
- `RecurringTemplate` — payee, entity, expected amount + tolerance, period (monthly/…),
  nextDueAt; drives P3 auto-checks + missed-payment alerts.
- `AIReview` — subjectType/subjectId, verdict `approve|reject|escalate`, reasoning text,
  policyVersion, model, createdAt. EVERY AI decision rowed here.
- `CeresSettlement` — daily close snapshot: per-person outstanding carried forward, float
  remaining, closedBy, closedAt. Snapshot only — no row moving/deleting.
- `StatementImport` + `StatementLine` — raw file (stored + sha256), parsed lines, match status
  (matchedTo PaymentRequest/CashMovement id | unmatched), reconciledBy.

## 7. The AI reviewer (the novel piece — build carefully)

- A written policy the AI applies (keep it in code/config, versioned): allowed categories,
  per-category ceilings, receipt present + OCR amount matches entry, no duplicates (same
  vendor+amount+date; same receipt image hash reused), payee plausibility, recurring within
  tolerance. **Anything outside policy or ambiguous → escalate. AI down → escalate. Fail
  closed, always.** Log verdict + reasoning to `AIReview` for the CEO's nightly read.
- P2/P3: the AI is a **pre-payment GATE** (MD cannot mark paid without approval).
- P1: the AI reviews **after Nee's approval** (post-hoc second pair of eyes; flags go to the
  CEO's nightly view, they don't block the messenger).
- Use the existing `callClaude`/`callClaudeWithImage` client (it already supports prompt-cache
  blocks — put the static policy in a cached block).

## 8. Config (env, Railway)

- `CERES_FLOOR` = 40000 (top-up trigger; suggested top-up = shortfall to just above the floor)
- `CERES_CEO_THRESHOLD` = 5000 (mandatory CEO pre-approval above this)
- Entities: `PROM`, `DENL` (constant list, mirrors the rest of the suite)

## 9. First steps for the new session

1. Read this file; then `api/prisma/schema.prisma`, `api/src/db/ensureSeeded.ts` (auth/boot
   pattern), `api/src/routes/juno.ts` + `juno/` (the sibling-app pattern to copy),
   `api/src/llm/readSlip.ts` + `api/src/llm/anthropic.ts` (vision OCR + SystemPrompt),
   `docs/JUNO_PROCESS_BRIEF.md` (bank import overlap).
2. Confirm the open questions (§10) with the owner BEFORE building.
3. Build in this order: **P1** (messenger mobile entry + receipt capture/OCR + Nee approval +
   expected-change board + manual close) → **P2/P3** (PaymentRequest + AI gate + recurring
   templates) → **P4** (CEO nightly view + escalation queue + top-up suggestion) → **P5**
   (statement import — reuse Juno's KBIZ parser — matching + weekly pack).
4. Deploy as its own Railway service (`ceres/` frontend, root `/ceres`, `VITE_API_URL`; append
   the new domain to the api `WEB_ORIGIN`).

## 10. Open questions to confirm with the owner early

1. **Which bank account** does Nee export daily — the same Kasikorn/KBIZ account Juno imports
   (income), or a separate expense account? (Determines parser reuse + whether income and
   expense reconcile against one statement.)
2. **Messenger logins:** per-person passwords synced from env (like Minerva staff), a shared
   messenger password with per-person accounts, or PINs? How comfortable are they with phones?
3. **History:** import the old GAS sheets (Data_Log / History_Log / Budget_Log) so balancesและ
   history carry over, or start fresh from a counted float on day 1? (Recommend: fresh start
   with an opening-balance deposit; keep the old sheets read-only as archive.)
4. **CEO approval channel** for escalations/>5k during the day: is the Ceres web UI enough, or
   does the owner want a push (e.g. LINE notify) so MD isn't blocked for hours?
5. The AI policy specifics: category ceilings and the initial allowed-category list (seed from
   the GAS expense-type list).

## 11. Cautions

- **Shared live DB**: ADD-only migrations; never touch Minerva/Vulcan/Juno tables; Minerva api
  stays the sole migrator. Coordinate migration timestamps with in-flight Juno work.
- **Money data**: append-only + revision trails everywhere; balances are queries; no code path
  may hard-delete or silently overwrite an approved record.
- **Fail-closed AI**: an LLM outage must block P2/P3 payments into the CEO queue — never
  auto-approve, never silently skip review.
- Mobile-first for messengers; Thai UI throughout (match the GAS app's language).
- Secrets only in Railway env. Rotate/kill the old GAS deployment at cutover (§4 warning).
- PII/financial data behind auth; receipt images NOT publicly listable (tokenized URLs like
  Minerva's slip links).
