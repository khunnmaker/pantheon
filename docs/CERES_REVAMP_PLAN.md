# 1. Current-state survey

The repository is ahead of parts of the mission brief:

- Ceres has the 13 original tables from `20260705000000_ceres` plus the later expense-void migration. Money is stored as string-valued append-only movements and queried into balances; daily closes create immutable settlement snapshots.
- The staff roster and authentication use four live tiers: `supervisor`, `gm`, `central`, and `employee`. The Central Office tier was introduced in `a185175` as `agm` (formerly AGM); raw `agm`, `messenger`, and `md` Agent roles are retired.
- Ceres already boots from the Pantheon shared SSO cookie and uses the portal `?redirect=` flow. Ceres access is live-checked from `Agent.apps`.
- `CERES_MESSENGER_PINS` still exists in `api/src/env.ts`, but nothing consumes it. Current PIN login uses the suite-wide Agent accounts provisioned from `EMPLOYEE_PINS`/legacy `AGENT_PINS`.
- The canonical roster currently contains 23 employee records, and all 23 declare a Ceres grant. `ensureCeres.ts` creates or repairs a `CeresParty` for every employee, not merely the original messenger group. Existing messenger PIN users are therefore already represented by normal Agent accounts and parties.
- The Ceres login screen still offers an app-local card/PIN UI as a fallback, but it calls the central `/api/auth/login`; it is not a separate Ceres credential system.
- Ceres currently maps:
  - `supervisor` → `ceo`
  - any `gm` → Ceres management
  - granted `central`/`employee` → `messenger`
- Nee is not the only current approver: Noon is also seeded as `gm`, and every `gm` can perform the same Ceres actions. This needs an owner decision if “Nee approves everything” is intended to be identity-specific.
- The entity list has already expanded from PROM/DENL to the five Jupiter company codes: PROM, TONR, DENC, DENL, and KPKF.
- The current approval architecture does not match the new brief:
  - Messenger cash expenses are approved by GM/CEO, followed by an advisory post-hoc AI review. This AI is not fail-closed.
  - `CeresPaymentRequest` is currently created only by GM/CEO. AI immediately auto-approves it or escalates it to CEO; there is no Nee approval step.
  - Therefore neither existing flow implements “staff submits → Nee approves everything → CEO if over threshold/AI escalation.”
- A bank-transfer-like flow already exists for GM payment requests: an approved request can be marked `paid` with free-text `paidRef`, and KBIZ outgoing lines can reconcile against it. It has no mandatory transfer slip and is unavailable to staff.
- CEO LINE escalation and the nightly CEO digest already exist. Requester notifications do not.
- Apollo’s LINE binding already stores shared `Agent.lineUserId` and `Agent.lineBindCode`; the binding route and UI are Apollo-named, but the resulting Agent binding can be reused by Ceres.
- The management UI currently has eight tabs, or nine for CEO, in a horizontally scrolling bar. Staff see only the existing messenger expense screen.
- Receipt files are stored correctly on persistent storage and hash-checked, but their public HMAC URLs have no expiry.
- The negative cash-box hazard is real: the close checks “already closed” and “pending expenses,” but not a negative box balance. Advance creation also does not atomically prevent overdrawing the box.
- Receipt OCR is returned to the browser and used to prefill the form, but the create/update expense payload does not persist `ocrAmount`, `ocrVendor`, or `ocrDate`. Consequently, stored OCR mismatch review is usually ineffective.
- Pending legacy expenses can still be hard-deleted. Approved/settled entries use revision and void patterns. New company-wide requests should use cancel/void events rather than hard deletion after submission.

# 2. Data model changes

## Recommended approach

Promote `CeresPaymentRequest` into the canonical company-wide request table instead of creating a competing `CeresRequest` table. This preserves existing AI reviews, recurring templates, bank reconciliation, exports, and historical links.

Legacy rows must not be guessed into one of the new three request types. They remain `legacy_payment` and continue through their existing workflow until complete.

Use application-level TypeScript/Zod string unions stored as `TEXT`, matching current Ceres conventions. Avoid PostgreSQL enum types because they complicate additive rollout and future workflow expansion.

## Migration names

1. `20260726000000_ceres_staff_requests`
   - Add all nullable/defaulted columns and new tables.
   - Backfill legacy discriminator and cash direction values.
   - Add non-blocking indexes.
   - No drops, renames, or destructive status conversion.

2. `20260728000000_ceres_request_integrity`
   - Deploy only after the dual-read/dual-write code has run in production and an audit reports no invalid rows.
   - Add/validate conditional checks and uniqueness constraints, especially money-event reversal and statement-match uniqueness.

These timestamps sort after the repository’s current migrations through `20260725000000_*`.

## Changed tables

### `CeresPaymentRequest`

Add:

- `workflowVersion Int @default(1)`
  - Existing rows remain v1.
  - New company-wide requests use v2.
- `requestType String @default("legacy_payment")`
  - `legacy_payment | advance | reimbursement | purchase`
- `approvalStatus String @default("legacy")`
  - `legacy | pending_nee | pending_ceo | approved | rejected | cancelled | void`
- `fulfillmentStatus String @default("legacy")`
  - `legacy | unfulfilled | paid | bought | settling | settled | reversed`
- `requesterPartyId String?`
  - Links the Agent requester to the cash/outstanding party ledger without relying only on a name.
- `requestPhotoUploadId String?`
- `requestPhotoSha String @default("")`
- `ocrAmount String @default("")`
- `ocrVendor String @default("")`
- `ocrDate String @default("")`
- `aiScreenStatus String @default("legacy")`
  - `legacy | pending | clear | escalate`
- `neeDecidedById String?`
- `neeDecidedByName String @default("")`
- `neeDecidedAt DateTime?`
- `neeDecisionNote String @default("")`
- `rowVersion Int @default(1)`
  - Used for optimistic concurrency on approval and fulfillment actions.
- `updatedAt DateTime @updatedAt`
- Void metadata: `voidedById`, `voidedAt`, `voidReason`.

Keep the existing `status`, CEO `decided*`, and `paid*` fields untouched for v1 compatibility. V2 UI and services read the new split approval/fulfillment fields. Existing endpoints continue to understand v1 rows.

Add indexes on:

- `(workflowVersion, approvalStatus, createdAt)`
- `(requestedById, createdAt)`
- `(requestType, fulfillmentStatus)`
- `requesterPartyId`
- `requestPhotoSha`

### `CashMovement`

Add:

- `direction String?`
  - `in | out`
- `requestId String?`
- `requestMoneyEventId String?`
- `reversesMovementId String?`

Backfill:

- `advance` → `out`
- `deposit`, `topup`, `refund` → `in`

New request-related types:

- `request_payment`
- `request_refund`
- `reversal`

All new balance queries use `direction`; during compatibility rollout, null direction falls back to the legacy type mapping.

Add indexes on `requestId`, `requestMoneyEventId`, and `reversesMovementId`. The integrity migration makes `requestMoneyEventId` and `reversesMovementId` unique when non-null.

### `CeresExpense`

Add:

- `advanceRequestId String?`
- `fundingLane String @default("cash")`
  - `cash | transfer | self_funded`

Existing expenses backfill to `cash`.

This distinction is essential: an expense liquidating a transferred advance must not change the physical cash-box settlement. Existing unlinked messenger expenses continue to count as cash expenses.

Add an index on `advanceRequestId`.

### `CeresStatementLine`

No new columns are required because `matchedType` and `matchedId` are already generic strings.

Add the new match target:

- `requestMoneyEvent`

Continue accepting `paymentRequest` for legacy v1 reconciliation.

After checking existing data for duplicates, add a partial unique index ensuring that one request money event cannot be reconciled to multiple statement lines.

## New tables

### `CeresMedia`

Registry for files stored by the existing receipt store:

- `id` — same value as the filesystem upload ID
- `purpose`
  - `legacy_receipt | request_photo | reimbursement_receipt | purchase_receipt | transfer_slip | refund_slip`
- `sha256`
- `uploadedById`
- `uploadedByName`
- `createdAt`

Backfill existing `CeresExpense.receiptUploadId` references as `legacy_receipt`. File MIME type continues to come from the existing sidecar file.

This table prevents a user from attaching another user’s arbitrary upload ID to a request.

### `CeresRequestEvent`

Immutable request timeline:

- `id`
- `requestId`
- `kind`
  - `submitted | edited | ai_reviewed | nee_approved | nee_rejected | ceo_approved | ceo_rejected | cancelled | paid | bought | liquidation_added | settled | voided`
- `actorId`
- `actorName`
- `note`
- `payload Json`
- `idempotencyKey String? @unique`
- `createdAt`

The mutable status columns on `CeresPaymentRequest` are a query projection; this table is the authoritative audit timeline. Request field edits also continue to create `CeresRevision` rows.

### `CeresRequestMoneyEvent`

Append-only record of money fulfillment:

- `id`
- `requestId`
- `kind`
  - `payment | purchase | refund | reversal`
- `lane`
  - `cash | transfer`
- `amount`
- `transferSlipUploadId`
- `purchaseReceiptUploadId`
- `cashMovementId`
- `reversesEventId`
- `createdById`
- `createdByName`
- `note`
- `createdAt`
- `idempotencyKey String? @unique`

Rules:

- A transfer payment/refund requires a transfer slip.
- A purchase fulfillment requires a purchase receipt.
- A cash event requires a linked append-only `CashMovement`.
- Corrections create a reversal event; rows are never edited or deleted.
- Reversing a cash event also creates a compensating `CashMovement`.
- Only one unreversed initial fulfillment may exist per request; enforce this transactionally with request locking and idempotency.

### `CeresSettlementRequestLine`

Immutable supplement to the existing daily cash close:

- `id`
- `settlementId`
- `requestId`
- `moneyEventId @unique`
- `kind`
- `partyName`
- `amount`
- `createdAt`

The existing `CeresSettlementLine` messenger calculation remains intact. This new table records direct request-related cash payments included in the same physical-box close.

## V2 workflow rules

### Approval

1. Staff submits.
2. AI pre-screen runs and writes `CeresAIReview`.
3. Request remains `pending_nee`; AI never grants payment authority.
4. Nee rejects, or approves.
5. Nee approval becomes:
   - `pending_ceo` if amount is strictly greater than the configured threshold or AI says `escalate`.
   - `approved` otherwise.
6. CEO approves/rejects `pending_ceo`.
7. Only final `approved` requests can be fulfilled.

An AI outage, malformed answer, missing required receipt, duplicate evidence, or ambiguous policy decision produces `aiScreenStatus=escalate`. It never produces automatic approval.

### Fulfillment

- Advance/reimbursement: final action is `paid`.
- Purchase: final action is `bought`.
- Nee chooses the actual lane at fulfillment, keeping the staff form short.
- Cash fulfillment creates both a request money event and a cash movement in one transaction.
- Transfer fulfillment requires a slip and creates only the request money event.
- An advance remains open for liquidation until approved linked expenses plus returns account for the advance.

# 3. Phased plan

## Phase 1 — Additive foundation and safety guards

### Scope

Ship the schema foundation without changing the existing messenger or management UX. Add the money-event service, media registry, expiring media links, cash locking, and negative-balance protection. All current v1 APIs and frontend bundles must remain functional.

### Files touched

- `api/prisma/schema.prisma`
- `api/prisma/migrations/20260726000000_ceres_staff_requests/migration.sql`
- `api/src/routes/ceres/index.ts`
- `api/src/routes/ceres/common.ts`
- `api/src/routes/ceres/p1.ts`
- `api/src/ceres/receiptStore.ts`
- `api/src/ceres/receiptLink.ts`
- New `api/src/ceres/requestMoney.ts`
- New `api/src/ceres/mediaAccess.ts`
- `api/src/db/ensureCeres.ts`
- New tests:
  - `api/test/ceresCashLedger.test.ts`
  - `api/test/ceresMedia.test.ts`
  - `api/test/ceresCompatibility.test.ts`

### API endpoints

- Keep `POST /api/ceres/receipts` as a compatibility alias.
- Add `POST /api/ceres/media`
  - Authenticated upload with declared purpose.
- Add `GET /api/ceres/media/:id/url`
  - Performs request/expense ownership or management authorization and returns a short-lived signed URL.
- Keep `/content/ceres-receipt/:id`, but require an expiry-bound signature for newly generated URLs.
- Existing advances, expenses, board, and close endpoints remain available.

### Frontend screens

No navigation change. Existing receipt images simply receive expiring URLs from the existing API row mappers.

### Safety behavior

- Lock the `CashAccount.pettyCash` row before computing and inserting any outgoing cash movement.
- Reject an advance or request cash payment that would make the box negative.
- Add `negative_box_balance` to the close guard.
- Close and cash-out operations use the same lock order to avoid races.
- Persist OCR fields when creating/updating a legacy expense.
- New media URLs include upload ID, expiry, and HMAC; recommended TTL is ten minutes.
- During one compatibility release, optionally accept the old stable token format behind a rollback flag. Do not generate new stable links.

### Acceptance criteria

- The old Ceres frontend can create expenses, approve them, issue advances, and close the box without modification.
- All existing movement balances before and after migration are identical.
- An attempted outgoing cash movement exceeding the physical balance returns a clear 409 and writes nothing.
- A negative box cannot be closed.
- Two simultaneous cash payouts cannot both spend the same remaining balance.
- A new media URL expires and cannot be extended by changing its expiry query parameter.
- An employee cannot attach media uploaded by another employee.
- Existing settlement history and old receipt files remain readable through authorized API-generated links.
- API tests, Prisma generation, API typecheck, and the existing Ceres build pass.

## Phase 2 — Staff request front door and unified approval queue

### Scope

Introduce the three v2 request types for all Ceres-granted staff. Preserve the existing messenger expense button as a secondary action so the advance/receipt/close workflow continues uninterrupted.

Implement the new approval sequence: AI screen, then Nee, then CEO when required.

### Files touched

Backend:

- `api/src/routes/ceres/requests.ts`
- `api/src/routes/ceres/common.ts`
- `api/src/ceres/aiReview.ts`
- `api/src/ceres/notifyCeo.ts`
- New `api/src/ceres/requestService.ts`
- `api/src/routes/ceres/ceo.ts`
- `api/src/routes/pantheon.ts`
- `api/src/ceres/nightlyDigest.ts`

Frontend:

- `ceres/src/Ceres.tsx`
- `ceres/src/Messenger.tsx`
- `ceres/src/Md.tsx`
- `ceres/src/lib/api.ts`
- New `ceres/src/RequestSheet.tsx`
- New `ceres/src/MyRequests.tsx`
- New `ceres/src/NeeApprovalQueue.tsx`
- Update `ceres/src/CeoOverview.tsx`

Tests:

- New `api/test/ceresRequests.test.ts`
- New `api/test/ceresApproval.test.ts`
- New `api/test/ceresAccess.test.ts`

### API endpoints

Expand the existing request namespace while preserving v1 behavior:

- `POST /api/ceres/requests`
  - Without `requestType`, retain the legacy GM v1 behavior temporarily.
  - With a v2 `requestType`, allow any Ceres-granted staff account.
- `GET /api/ceres/requests?scope=mine|queue|all&workflow=2`
- `GET /api/ceres/requests/:id`
  - Staff can read only their own; management can read all.
- `PATCH /api/ceres/requests/:id`
  - Requester only while `pending_nee`.
  - Creates revision/event and reruns AI.
- `POST /api/ceres/requests/:id/cancel`
  - Requester only while awaiting Nee; management may cancel before fulfillment.
- `POST /api/ceres/requests/:id/nee-decision`
  - GM/Ceres approver only.
- Keep `POST /api/ceres/requests/:id/decide` as the legacy CEO alias.
- Add `POST /api/ceres/requests/:id/ceo-decision` for v2.

### Request validation

- Advance:
  - amount and reason required;
  - supporting photo optional.
- Reimbursement:
  - amount, reason, and receipt required at submission.
- Purchase:
  - amount and reason required;
  - quote/item photo optional at submission;
  - purchase receipt required later when marked bought.
- Server derives requester identity, party, and reimbursement payee. It never accepts requester identity from the client.
- Staff may choose the company entity and category from active reference data.
- Submitted requests are never hard-deleted.

### Frontend screens

Staff home:

- Primary “ส่งคำขอเงิน” action.
- Three large request-type choices.
- A single mobile sheet optimized for amount, reason, and photo.
- “คำขอของฉัน” list with plain Thai status text and rejection reason.
- Existing “บันทึกค่าใช้จ่าย/ใบเสร็จเงินเบิกเดิม” remains visible as a secondary cash-flow action.

Nee home:

- Default to the approval queue rather than the cash board.
- Queue cards show requester, type, amount, reason, photo, entity, duplicate/OCR warnings, and AI reasoning.
- Approve/reject from the card.
- Items requiring CEO clearly show that Nee’s approval will forward rather than finalize them.

CEO home:

- `pending_ceo` requests appear in the existing overview.
- CEO cannot act before Nee has approved.

### Acceptance criteria

- Every granted employee/Central Office user can create and view only their own three request types.
- A reimbursement cannot be submitted without a receipt.
- Staff cannot forge requester ID, access another person’s request, or attach another person’s upload.
- AI unavailability and malformed AI output both produce escalation, never approval.
- Nee must act on every request.
- An amount strictly over the threshold always goes to CEO after Nee approval.
- A below-threshold AI-flagged request also goes to CEO.
- A clean below-threshold request becomes approved after Nee approval.
- Editing amount, reason, type, entity, category, or evidence invalidates the previous AI result and reruns screening.
- Existing messenger expense entry and daily close continue unchanged.
- The request form is usable one-handed on a narrow phone and requires no more than the three primary inputs for the normal case.

## Phase 3 — Cash/transfer fulfillment, advance liquidation, and reconciliation

### Scope

Allow Nee to fulfill approved requests through the physical cash box or bank transfer. Add mandatory transfer slips, purchase receipts, append-only reversals, linked advance expenses, and a dedicated transfer reconciliation view.

### Files touched

Backend:

- `api/src/ceres/requestMoney.ts`
- `api/src/routes/ceres/requests.ts`
- `api/src/routes/ceres/p1.ts`
- `api/src/routes/ceres/statements.ts`
- `api/src/routes/ceres/exports.ts`
- `api/src/routes/ceres/ceo.ts`
- `api/src/routes/ceres/common.ts`
- `api/src/ceres/nightlyDigest.ts`
- `api/prisma/migrations/20260728000000_ceres_request_integrity/migration.sql`

Frontend:

- `ceres/src/lib/api.ts`
- New `ceres/src/NeeFulfillmentQueue.tsx`
- New `ceres/src/RequestDetail.tsx`
- Update `ceres/src/ExpenseSheet.tsx`
- Update `ceres/src/MdClose.tsx`
- Replace/refocus `ceres/src/MdRecon.tsx` as the transfer reconciliation workspace
- Update `ceres/src/MdExpenses.tsx`
- Update `ceres/src/CeoOverview.tsx`

Tests:

- New `api/test/ceresFulfillment.test.ts`
- New `api/test/ceresReconciliation.test.ts`
- Extend cash-ledger and close tests.

### API endpoints

- `POST /api/ceres/requests/:id/fulfill`
  - Body selects `cash|transfer`.
  - Advance/reimbursement → payment.
  - Purchase → bought, with required receipt.
- `POST /api/ceres/requests/:id/refund`
  - Records returned advance money through cash or transfer.
- `POST /api/ceres/request-money-events/:id/reverse`
  - Management only, reason required, append-only compensation.
- `POST /api/ceres/expenses`
  - Accept `advanceRequestId`.
  - Validate ownership and that the advance has been paid.
- `GET /api/ceres/requests/:id/liquidation`
  - Advance, approved expenses, returns, remaining outstanding.
- Extend:
  - `GET /api/ceres/statements/lines`
  - `POST /api/ceres/statements/automatch`
  - `POST /api/ceres/statements/lines/:id/match`
  - `GET /api/ceres/statements/summary`
- Add `GET /api/ceres/transfers/reconciliation`
  - Transfer money events, slip status, bank-match state, unmatched bank lines.

### Cash behavior

- Cash fulfillment and its `CashMovement` are created in one locked transaction.
- Cash advance expenses offset the party’s expected change exactly as they do today.
- Transfer-funded advance expenses are excluded from the physical-box computation.
- Direct cash reimbursements and purchases reduce the box through `direction=out`.
- Cash returns increase it through `direction=in`.
- Daily close still represents one physical box and retains the current messenger settlement lines.
- The close additionally snapshots request cash events in `CeresSettlementRequestLine`; old UI versions safely ignore these lines.

### Transfer behavior

- Every transfer payment or refund requires a slip uploaded for the appropriate purpose.
- The slip alone does not mark bank reconciliation complete.
- KBIZ outgoing lines auto-match unreconciled transfer payment events by exact amount and date window only when unambiguous in both directions.
- Incoming return events can match incoming lines.
- Legacy paid requests continue matching as `paymentRequest`.
- Manual match/unmatch remains available, with actor and timestamp.
- One statement line may match one target, and one money event may match one statement line.

### Advance liquidation

- After a paid advance, staff can add one or more receipt-backed expenses from the request detail.
- Nee retains the current expense approval step and post-hoc AI review for those liquidation receipts; the already-approved advance is not sent through CEO approval a second time.
- Approved expenses plus recorded returns reduce the request’s outstanding amount.
- When the remaining amount reaches zero, write a `settled` request event.
- Never force a transfer-funded advance into the physical daily close.

### Acceptance criteria

- No request can be fulfilled before final approval.
- Double-tapping or concurrent fulfillment produces one money event and one cash movement at most.
- A transfer cannot be recorded without a slip.
- A purchase cannot be marked bought without a purchase receipt.
- A failed upload or database action leaves neither half of a cash transaction behind.
- Reversals preserve the original event and create compensating records.
- Cash and transfer advance expenses affect the correct lane only.
- Existing messenger close totals remain correct.
- Direct cash request payments are included in the box balance and close snapshot.
- Transfer reconciliation shows unmatched events in both directions and never auto-matches ambiguous equal-amount transactions.
- Weekly exports include request type, requester, approval actors, lane, slip/receipt presence, money events, reversal state, and reconciliation state without exposing stable media URLs.

## Phase 4 — Role-based homes and requester LINE notifications

### Scope

Complete the UX revamp and reuse the shared Apollo LINE binding at suite level. Replace the nine-tab mental model with three role-specific front doors and grouped secondary tools.

### Files touched

Backend:

- New `api/src/line/staffBind.ts`
- New `api/src/routes/staffLine.ts`
- New `api/src/ceres/notifyRequester.ts`
- `api/src/routes/webhook.ts`
- `api/src/routes/apollo.ts`
- `api/src/index.ts`
- `api/src/routes/ceres/requests.ts`
- `api/src/routes/ceres/ceo.ts`
- `api/src/routes/pantheon.ts`
- `api/src/ceres/nightlyDigest.ts`

Frontend:

- `ceres/src/Ceres.tsx`
- Replace `ceres/src/Md.tsx` tab shell
- New `ceres/src/StaffHome.tsx`
- New `ceres/src/NeeHome.tsx`
- New `ceres/src/CeoHome.tsx`
- New `ceres/src/MoreMenu.tsx`
- New `ceres/src/Settings.tsx`
- `ceres/src/lib/api.ts`
- `pantheon/src/lib/apps.ts`

### API endpoints

- `GET /api/staff/line-bind`
- `POST /api/staff/line-bind`
- Preserve Apollo’s existing `/api/apollo/line-bind` endpoints as aliases.
- Webhook accepts the existing Apollo binding form and a suite/Ceres binding form, both writing the same Agent fields.
- No Ceres action requires LINE binding.

### Frontend screens

Staff:

- Home: new request button plus recent requests.
- My requests: searchable history and request detail.
- Settings: optional LINE binding.
- Existing advance-receipt action remains reachable from request detail and “More.”

Nee:

- Home cards: waiting for approval, approved awaiting payment/buying, transfer reconciliation exceptions, today’s cash-box state.
- Primary bottom navigation limited to Home, Approvals, Fulfillment, More.
- More groups the existing board, advance/refund tools, close, expense history, recurring templates, reconciliation, and exports.

CEO:

- Default overview with pending CEO decisions, daily outflow by lane/type, cash balance, unreconciled transfers, AI flags, and close status.
- Secondary history/export tools under More.
- CEO does not land on the old operational tab bar.

### Notifications

Send a best-effort LINE push to the request owner when:

- final approval is reached;
- rejected by Nee or CEO;
- paid;
- purchase marked bought.

Each message includes Thai status, amount, short reason/type, and a Ceres deep link. Do not include receipt or slip URLs.

Notify only after the database transaction commits. A LINE failure must not roll back or change the request. Repeated API retries use request event idempotency to avoid duplicate state changes.

### Acceptance criteria

- No role sees the nine-tab horizontal scroller as its primary navigation.
- Staff land on their own requests and cannot see management counts.
- Nee lands on actionable work.
- CEO lands on oversight and escalation.
- A user can bind LINE using the shared Agent binding; existing Apollo binding remains valid for Ceres.
- Bound users receive the four required status notifications.
- Unbound users see a non-blocking invitation and every app feature remains usable.
- Notification or LINE API failure never changes approval/payment state.
- Pantheon Ceres badge reflects:
  - staff: own rejected/action-needed requests;
  - GM: pending Nee approvals plus approved items awaiting fulfillment;
  - CEO: pending CEO decisions.

## Phase 5 — Portal-only SSO cutover and legacy cleanup

### Scope

Complete the already-started auth migration without forcing existing messenger users out mid-session.

### Files touched

- `ceres/src/App.tsx`
- `ceres/src/Login.tsx`
- `ceres/src/lib/api.ts`
- `api/src/ceres/auth.ts`
- `api/src/routes/ceres/index.ts`
- `api/src/auth/loginCards.ts`
- `api/src/db/ensureSeeded.ts`
- `api/src/db/ensureCeres.ts`
- `api/src/env.ts`
- `.env.example`
- `pantheon/src/App.tsx`
- `pantheon/src/lib/redirect.ts`
- Auth/access tests.

### API/endpoints

- Continue `/api/auth/me`, `/api/auth/login`, and `/api/auth/logout` unchanged.
- Keep `/api/ceres/logins` during the compatibility window.
- After successful observation, retire `/api/ceres/logins` or expose it only when the break-glass local-login flag is enabled.
- Ceres routes continue requiring live Agent identity plus Ceres access.
- Return 403, rather than a generic 401, when an authenticated account lacks the Ceres grant so the portal can show a clear access-denied screen.

### Frontend behavior

- Normal logged-out entry always redirects to Pantheon with `?redirect=<ceres-url>`.
- Existing localStorage bearer tokens remain accepted until their normal expiry.
- Existing valid shared cookies bootstrap normally.
- App-local login is available only via an explicit break-glass `?local=1` path during the rollback window.
- After the observation window, remove the normal local-login screen from the Ceres bundle.

### Acceptance criteria

- Every legacy messenger account can sign into Pantheon and return to Ceres using its existing central Agent credential.
- No active Ceres token is forcibly invalidated during deployment.
- Removing a Ceres grant takes effect immediately because routes reread the live Agent row.
- A granted staff account without a `CeresParty` is detected by the readiness audit and repaired before cutover.
- No Ceres-specific PIN values or secrets are migrated, logged, or exposed.
- `CERES_MESSENGER_PINS` can be removed from the application schema because no runtime code uses it.
- The compatibility login can be re-enabled without a database rollback.

# 4. Auth cutover plan with rollback

The repository has already completed most of the technical migration. The remaining work is an operational cutover from “Ceres can still show its own central-auth login screen” to “Pantheon is the only normal front door.”

## Step A — Pre-cutover audit

Run a read-only report containing counts and identifiers only, never credentials:

- Every currently active legacy messenger has an Agent row.
- Every target staff account has a Ceres grant or implicit GM/supervisor access.
- Every employee/Central Office requester has an active `CeresParty` linked by `agentEmail`.
- No two active parties map to the same Agent email.
- Each legacy expense party remains present even if inactive.
- Confirm portal redirect origin and the production shared-cookie domain.
- Confirm successful Ceres bootstrap for representative supervisor, GM, Central Office, employee, and original messenger accounts.

Repair grants or party links additively before changing the frontend.

## Step B — Dual-path compatibility release

For at least one release window:

- Portal redirect is the default.
- Existing Ceres bearer tokens remain valid.
- Shared-cookie bootstrap remains valid.
- `?local=1` still exposes the current central Agent login cards.
- `/api/ceres/logins` remains available.
- Existing messenger expense and close routes are unchanged.
- Record successful sign-in/account counts without logging PINs or credential material.

This is sufficient to keep existing PIN users working: they are not being converted into new accounts; they are using the same Agent accounts through the portal.

## Step C — Portal-only default

After all target accounts have successfully used the new path:

- Remove the normal Ceres login fallback.
- If `/api/auth/me` fails, redirect to Pantheon rather than displaying account cards.
- Keep `?local=1` behind a deploy-time compatibility flag for one additional release.
- Keep existing bearer tokens until natural expiry; do not mass-revoke them.
- Remove the unused `CERES_MESSENGER_PINS` declaration and deployment variable only after confirming it is not referenced by any deployed older API instance.
- Retain `EMPLOYEE_PINS` or its suite-wide successor because it is the central staff credential source, not a Ceres-specific mechanism.

## Step D — Final cleanup

- Remove `/api/ceres/logins` and the app-local `Login.tsx` path after the rollback window.
- Keep the central `/api/auth/login` endpoint for Pantheon.
- Do not remove Agent rows, `CeresParty` rows, or historical party email snapshots.
- Update Ceres documentation to describe grants and portal SSO, not messenger roles/PIN configuration.

## Rollback

Rollback is frontend/configuration-only:

1. Re-enable the explicit local-login compatibility flag or redeploy the previous Ceres frontend.
2. Keep `/api/ceres/logins` available during the entire rollback window.
3. Existing Agent credentials, grants, bearer auth, and CeresParty mappings are unchanged, so no database rollback is needed.
4. Do not restore `CERES_MESSENGER_PINS`; it is unused and would recreate two credential sources.
5. If shared-cookie configuration is the failure, local central login still obtains a bearer token and lets messengers continue the existing workflow while SSO is repaired.

# 5. Risks and open questions for the owner

1. **Meaning of “Nee approves everything.”**  
   Current code allows every `gm`, including Noon, to approve and operate Ceres. Recommendation: treat “Nee” as the Ceres approver role for continuity, but confirm whether Noon should retain identical authority or whether Ceres needs a finer `approver` capability.

2. **AI escalation semantics.**  
   Recommendation: AI never approves money by itself. It pre-screens, Nee always decides first, and either amount over the threshold or an AI concern forces CEO approval. Confirm that an AI concern should escalate rather than block Nee from forwarding it.

3. **Exact threshold boundary.**  
   Current code and brief say strictly greater than 5,000 THB. Confirm that exactly 5,000 does not require CEO unless AI flags it.

4. **Who chooses the payment lane.**  
   Recommendation: staff do not choose it; Nee chooses cash or transfer at fulfillment. This keeps the request under 30 seconds and reflects the method actually used.

5. **Photo requirements.**  
   Recommendation:
   - advance: optional supporting photo;
   - reimbursement: receipt mandatory at request time;
   - purchase: optional quote/item photo at request time, purchase receipt mandatory when bought.  
   Confirm whether every advance must also include a photo.

6. **Transferred advance liquidation.**  
   The new model can support receipts and returns without touching the physical box, but the owner should confirm how staff return unused transferred money and what happens when approved expenses exceed the advance. Recommendation: record transfer returns with a slip; create a linked reimbursement for an overrun rather than silently increasing the original advance.

7. **Double approval of advance receipts.**  
   Recommendation: CEO approval applies to the advance request once; later liquidation receipts receive Nee verification plus the current post-hoc AI review, not a second CEO threshold gate.

8. **Purchase-request detail level.**  
   The owner-approved v1 can remain amount + reason + photo, with Nee marking bought and attaching the final receipt. Confirm that v1 does not require structured quantity, vendor, SKU, or partial fulfillment.

9. **Partial fulfillment.**  
   The proposed v1 assumes one active payment/buy event per request, with reversals for correction. Confirm whether partial purchases or split cash/transfer payments are needed now. If yes, the money-event table supports them, but UI and status rules must expose remaining amount.

10. **Expense bank account.**  
    Existing reconciliation assumes a separate KBIZ expense account. Confirm that transfers for all five entities appear in this same export, or define account/entity ownership before enabling automatic matching.

11. **Multiple company bank accounts.**  
    If each entity has its own account, `CeresStatementImport` and request money events need a `bankAccountId` dimension before rollout. Free-text entity alone is not enough for safe reconciliation.

12. **Legacy payment requests.**  
    Recommendation: leave all existing rows as `legacy_payment`; do not infer whether they were reimbursements or purchases. They can finish under the current workflow and remain visible in history/export.

13. **Stable media URL transition.**  
    Ten-minute signed URLs are appropriate for the app, but old bookmarked/exported receipt links will expire. Exports should contain evidence presence/ID, not reusable public links. Confirm whether accounting needs a separate authenticated batch-download feature.

14. **Current pending-expense hard delete.**  
    New v2 requests should never hard-delete. For zero downtime, keep deletion for old pending messenger drafts initially, then remove it after old drafts clear if the owner wants the append-only rule to cover even unsubmitted/pending expense drafts.

15. **Roster ownership.**  
    All 23 current employee seeds already have Ceres access. Confirm whether “company-wide” means every future employee automatically receives Ceres or whether grants remain explicit. Recommendation: explicit grant with an onboarding check, not automatic access to financial data.

16. **No current Ceres-specific test suite.**  
    The repository has general auth and bank parser tests but almost no Ceres workflow tests. Approval state, concurrent fulfillment, cash locking, media authorization, and reconciliation tests should be release blockers.

17. **AI latency versus the phone target.**  
    The form itself can be completed in under 30 seconds, but OCR and AI screening may take longer after submission. The UI should save the request first, show a clear “กำลังตรวจ” state, and prevent approval until a logged review exists. Any stuck review must age into fail-closed escalation rather than remain silently pending.

18. **Transfer reversal is an accounting correction, not an actual bank reversal.**  
    Reversing a recorded transfer should create an exception requiring reconciliation with the real compensating bank transaction. It must not simply make the original debit disappear from reports.
