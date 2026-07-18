# Ceres production smoke runbook

This smoke test exercises the production Ceres workflow-v2 staff request through the API process's local HTTP listener. It is deliberately dependency-free and reads credentials only from the API container's environment.

## Safety contract

- Run only inside the production Railway **API container**, where `EMPLOYEE_PINS` and `GM_PASSWORD` (or legacy fallback `MD_PASSWORD`) already exist.
- Do not pass credentials on the command line, copy them into the file, print the environment, or run with shell tracing.
- The script uses `http://localhost:${PORT:-3000}` and never calls a public hostname.
- It creates a 5 THB `advance` request with memo `ทดสอบระบบ (smoke test) — จะถูก reverse` and never enters the CEO decision path.
- Do not run two copies concurrently. Each run is idempotent only for retries within that run's request; it intentionally appends audit events.

## Run

Copy `ceresSmoke.mjs` into the API container as `/tmp/ceresSmoke.mjs`, then run:

```sh
node /tmp/ceresSmoke.mjs
```

Do not source an environment file. Railway supplies the variables to the already-running container.

## Expected behavior

1. The script intersects the canonical seeded Ceres employee slugs with `EMPLOYEE_PINS` and `/api/auth/logins?app=ceres`, logs in one PIN account, and verifies its messenger bootstrap/party.
2. It creates the v2 advance and polls `GET /api/ceres/requests/:id` for `aiScreenStatus`.
3. `escalate` is a successful fail-closed branch: the requester cancels the request and all GM/CEO/money steps are skipped.
4. `clear` continues with Nee's GM login and `nee-decision`. A status other than `approved` is cancelled without touching CEO and reported `PARTIAL`.
5. CASH is attempted first. `insufficient_cash` or `cash_account_missing` is an expected guard; the script then constructs a valid 1x1 PNG, uploads it as `transfer_slip`, and fulfills through TRANSFER.
6. It verifies the request projection, money event, physical cash movement (or its required absence for TRANSFER), and box balance; reverses the fulfillment; then verifies the compensating projection and exact balance restoration.
7. Finally it attempts request cancellation. Cleanup also runs after unexpected failures and reverses any active fulfillment it can identify.

## Output and exit codes

Output contains only numbered `STEP ... PASS|FAIL|SKIP` lines followed by one JSON object with `result`, `steps`, `requestId`, and `cleanup`.

- Exit `0`, `FULL`: the selected branch completed and cleanup reached its supported terminal state.
- Exit `0`, `PARTIAL`: an expected API guard stopped a lane or terminal cleanup; the JSON names the exact step and guard.
- Exit `1`, `FAIL`: configuration, authentication, contract validation, HTTP behavior, reversal, or balance restoration failed. Inspect the final `cleanup` object before any manual action.

The script never prints a PIN, password, bearer token, or any fragment of those values. It also does not call `/api/auth/logout`, because that endpoint increments the account-wide `authVersion` and would invalidate other live sessions.

## Known deployed-revision limitation

At `e7f514d`, a successful reversal changes `fulfillmentStatus` to `reversed`, while `cancelStaffRequest` allows manager cancellation only when it is `unfulfilled`; there is no payment-request void endpoint. Therefore a normal clear/approve/fulfill/reverse run restores all money and the exact cash-box balance but ends with:

```text
STEP ... SKIP - terminally cancel request: guard not_cancellable
```

and a `PARTIAL` result. The remaining request projection is `approvalStatus: approved`, `fulfillmentStatus: reversed`; its money events and any paired cash movements are fully compensated. Do not use the CEO endpoint or direct database writes to force a terminal status. The API needs a supported cancel/void transition from `reversed` before this branch can return `FULL`.

## Endpoint contract sources checked

- Auth and roster: `api/src/db/ensureSeeded.ts`, `api/src/routes/auth.ts`, `api/src/auth/loginCards.ts`
- Ceres auth/bootstrap/media: `api/src/ceres/auth.ts`, `api/src/routes/ceres/index.ts`, `api/src/routes/ceres/p1.ts`, `api/src/ceres/mediaAccess.ts`
- Request, approval, fulfillment, reversal, cancellation: `api/src/routes/ceres/requests.ts`, `api/src/ceres/requestService.ts`, `api/src/ceres/requestMoney.ts`, `api/src/routes/ceres/common.ts`
- Route/service tests: `ceresRequests.test.ts`, `ceresApproval.test.ts`, `ceresFulfillment.test.ts`, `ceresCashLedger.test.ts`, `ceresMedia.test.ts`, `ceresSsoCutover.test.ts`, and `authSessionRoutes.test.ts`
