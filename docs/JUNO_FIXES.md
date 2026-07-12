# Juno — post-review fix plan (execution brief)

> Hand this file to a fresh session. It is self-contained. Juno (the finance app) was built in
> commit `710cf80` on branch **`juno`** of this repo (`C:\Users\khunn\Project\Minerva`,
> `github.com/khunnmaker/minerva`) per `docs/JUNO_BRIEF.md` + `docs/JUNO_DEPLOY.md`. An
> adversarial multi-agent review then confirmed the issues below. **Your job: apply every fix
> in this file on the `juno` branch, verify, and commit. Do NOT merge to `main` or push
> unless the owner says so** (`main` auto-deploys to production).

## 0. Setup

```bash
cd C:\Users\khunn\Project\Minerva
git checkout juno            # the working tree may be on main; untracked juno/ artifacts (node_modules, dist) are fine
git log --oneline -1         # expect: 710cf80 Add Juno finance app ...
```

Line numbers below refer to the files **as committed in 710cf80**. If they've drifted, locate
by the quoted code instead.

**Global rules (do not violate):**
- The shared Postgres is LIVE production for Minerva. Migrations must be **ADD-only**.
- Never let a Juno addition block the existing slip flow beyond what's specified here.
- Match house patterns: `safeParse`+400 (see `api/src/routes/diana.ts`), `clearSession()` on
  logout (see `vesta/src/Stock.tsx:75-78`), `th-TH` locale date formatting (see
  `vesta/src/Stock.tsx` `fmtDate`/`fmtDateTime`).
- Owner-locked decisions — do NOT change: supervisor-role gating, `amount` as String, Google
  Sheet mirror stays on, lifecycle `received→verified→recorded (+void)`, tax invoice track-only.
- After all fixes: run the verification in §9 before committing.

---

## 1. Schema: unique constraint on `Payment.slipMessageId`

**Why:** nothing prevents two Payment rows for the same slip; reports machine-sum the table, so
a duplicate silently double-counts revenue. This constraint underpins fixes §2 and §3.

**Where:** `api/prisma/schema.prisma` (Payment model, ~line 219) and
`api/prisma/migrations/20260701000000_juno_payment/migration.sql`.

**What:**
1. In `schema.prisma`, change
   `slipMessageId String? // the Minerva Message (image) this came from`
   to
   `slipMessageId String? @unique // the Minerva Message this came from — one Payment per slip (idempotent re-forward)`
2. Edit the existing migration file `20260701000000_juno_payment/migration.sql` **in place**
   (safe: this migration has never been deployed anywhere — the commit was never merged to
   `main` and no local DB applied it). Add after the other `CREATE INDEX` lines:
   ```sql
   CREATE UNIQUE INDEX "Payment_slipMessageId_key" ON "Payment"("slipMessageId");
   ```
   (If you find evidence the migration WAS applied somewhere, instead create a new ADD-only
   migration folder `20260702000000_juno_payment_unique_slip` with just that statement.)
3. `cd api && npx prisma validate && npx prisma generate`.

House precedent: migration `20260624121731_m2_reply_idempotency` created the analogous
`Message_answersMessageId_key` unique index for idempotent replies.

---

## 2. `/to-finance` hook rework: Payment is the record of truth, idempotent, guarded

**Why (three confirmed bugs, one rework):**
- (a) No server-side double-forward guard — the "แจ้งการเงิน" button is hidden only in the
  clicking agent's local React state, so a second agent / stale tab / post-timeout retry
  creates a duplicate Payment.
- (b) The sheet post gates the Payment write: `sendToFinance` failure returns 502 **before**
  `payment.create` runs — a mirror outage makes the record of truth unwritable.
- (c) A failed `payment.create` is swallowed (console.error only) while `financeSentAt` still
  gets set — the payment becomes permanently invisible to Juno with no retry path.

**Where:** `api/src/routes/messages.ts`, the `POST /api/messages/:id/to-finance` handler
(starts ~line 163; the Payment block added by 710cf80 is ~lines 225-252).

**What — restructure the handler body to this exact order:**

1. After the existing `msg` lookup + `attachmentType !== 'image'` check, add the idempotency
   guard:
   ```ts
   if (msg.financeSentAt) return reply.code(409).send({ error: 'already_sent', financeSentAt: msg.financeSentAt });
   ```
2. Keep the existing computation of `nickname`, `realName`, `amount`, `bank`, `transferAt`,
   `ref`, `taxInvoice`, `note`, `slipUrl`, `sales`, `ocrAmount` (= `msg.slipAmount ?? ''`) and
   `corrected` (= `!!ocrAmount && ocrAmount !== amount`) — but compute `ocrAmount`/`corrected`
   BEFORE the payment write (in 710cf80 they're computed after the sheet post; move them up).
3. **Write the Payment FIRST, as an upsert, and fail loudly if it fails** (replaces the current
   fire-and-forget `.catch(console.error)` block):
   ```ts
   // Juno: the Payment row is the record of truth (the sheet below is a mirror). Upsert on
   // slipMessageId so a retry after a failed sheet post updates the same row instead of
   // duplicating. If this write fails the forward fails — staff retry; never silent.
   try {
     await prisma.payment.upsert({
       where: { slipMessageId: msg.id },
       create: {
         customerId: customer.id,
         customerCode: customer.code ?? '',
         customerName: nickname,
         senderName: realName,
         amount, ocrAmount, bank, transferAt, ref,
         slipMessageId: msg.id,
         slipUrl,
         taxInvoice,
         taxInvoiceStatus: taxInvoice ? 'requested' : 'none',
         salesAgentId: req.agent?.id ?? null,
         salesName: sales,
         note,
         status: 'received',
         flagged: corrected,
       },
       // Refresh only Minerva-sourced fields; never touch Juno-owned lifecycle fields
       // (status/verifiedById/verifiedAt) on a retry.
       update: {
         customerCode: customer.code ?? '',
         customerName: nickname,
         senderName: realName,
         amount, ocrAmount, bank, transferAt, ref,
         slipUrl,
         taxInvoice,
         taxInvoiceStatus: taxInvoice ? 'requested' : 'none',
         salesAgentId: req.agent?.id ?? null,
         salesName: sales,
         note,
         flagged: corrected,
       },
     });
   } catch (err) {
     req.log.error({ err, messageId: msg.id }, 'juno payment write failed');
     return reply.code(500).send({ error: 'payment_record_failed' });
   }
   ```
   Note: use `req.log.error` (the structured Fastify logger), not `console.error`.
4. THEN the existing `sendToFinance(...)` sheet post, unchanged, still returning 502 on
   failure. (The Payment row already exists; the staff retry re-enters, passes the
   `financeSentAt` guard — it's still unset — and the upsert makes it idempotent.)
5. THEN the existing `FinanceAudit` block (unchanged, only when `corrected`).
6. THEN the existing `message.update` setting `financeSentAt` and the `return`.

**Optional (recommended) broadcast** so other open consoles hide the forward button: after the
`financeSentAt` update, add `pushToConsole('finance:sent', { messageId: msg.id });`
(`pushToConsole` is already imported in this file). In `web/src/Console.tsx`, mirror the
existing socket-listener pattern (search for how `draft:new` is consumed) to patch that
message's `financeSentAt` in local state. If the web listener is more than ~20 lines of
plumbing, skip the web side — the server 409 already protects the data — but keep the emit.

**Also (frontend, Minerva console):** the FinanceModal caller should treat HTTP 409 as
"already sent" (informational toast), not a generic failure. Find the `to-finance` fetch in
`web/src/Console.tsx` and, on 409, show something like `ส่งให้การเงินไปแล้ว` and mark the
message as sent in local state.

---

## 3. Timezone: all day math and display in Thai time (UTC+7)

**Why:** Railway runs UTC; users are UTC+7. As committed: report "day" buckets use the UTC
day, from/to filters build UTC windows (`new Date('YYYY-MM-DD')` = UTC midnight = 07:00 Thai;
`to.setHours(...)` is server-local), and the frontend renders raw ISO slices. Any payment
forwarded 00:00–07:00 Thai lands on yesterday's date everywhere; drawer times are 7h off;
daily totals never reconcile with the bank.

### 3a. Backend — `api/src/routes/juno.ts`

1. Add near the top of the file:
   ```ts
   // All finance day-math is Thai business time (UTC+7) regardless of server TZ.
   const TH_OFFSET_MS = 7 * 3600 * 1000;
   const thaiDayKey = (d: Date): string => new Date(d.getTime() + TH_OFFSET_MS).toISOString().slice(0, 10);
   // "YYYY-MM-DD" (from the UI date inputs) → an inclusive UTC instant range for the Thai day.
   function thaiDayRange(from?: string, to?: string): { gte?: Date; lte?: Date } | null {
     const range: { gte?: Date; lte?: Date } = {};
     if (from) { const d = new Date(`${from}T00:00:00+07:00`); if (!Number.isNaN(d.getTime())) range.gte = d; }
     if (to)   { const d = new Date(`${to}T23:59:59.999+07:00`); if (!Number.isNaN(d.getTime())) range.lte = d; }
     return range.gte || range.lte ? range : null;
   }
   ```
2. Replace all THREE duplicated from/to blocks (in `GET /payments` ~lines 94-101, `GET
   /reports` ~lines 188-194, `GET /export.csv` ~lines 236-243) with:
   ```ts
   const range = thaiDayRange(q.from, q.to);
   if (range) where.createdAt = range;
   ```
   Delete the now-unused `to.setHours(...)` logic entirely.
3. In `GET /reports`, groupBy `'day'`: replace
   `key = r.createdAt.toISOString().slice(0, 10)` with `key = thaiDayKey(r.createdAt)`
   (label = key, unchanged).
4. In the CSV row builder, replace `p.createdAt.toISOString()` with a Thai-time string and
   rename the header so the column is unambiguous:
   header `'createdAt'` → `'createdAt (UTC+7)'`; value →
   `new Date(p.createdAt.getTime() + TH_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')`.

### 3b. Frontend — `juno/src/Juno.tsx`

1. Add module-level helpers (copy the Vesta pattern, `vesta/src/Stock.tsx` ~lines 43-49):
   ```ts
   const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
   const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
   ```
2. Inbox date cell (~line 210): `{p.createdAt.slice(0, 10)}` → `{fmtDate(p.createdAt)}`.
3. Drawer วันที่ส่งเข้า field (~line 305): `p.createdAt.slice(0, 16).replace('T', ' ')` →
   `fmtDateTime(p.createdAt)`.
4. Reports day-group labels come from the server key (already Thai-day after 3a.3) — leave.

---

## 4. CSV export hardening (`api/src/routes/juno.ts`, `GET /export.csv`)

### 4a. Excel formula injection (**confirmed exploitable**)

**Why:** `esc()` (~line 251) only quotes structural characters. Customer-controlled values
(LINE display name → `customerName`; OCR of a customer-crafted slip → `senderName`/`bank`/
`ref`/`transferAt`; sales-typed `note`/`taxInvoice`) reach Excel verbatim; a leading `=`,
`+`, `-`, `@` executes as a formula even inside a quoted field (data exfiltration via
`=HYPERLINK`/`=WEBSERVICE`, DDE on legacy Excel). Also the quote-trigger regex omits `\r`,
which corrupts `\r\n`-delimited rows.

**What:** replace `esc()` with:
```ts
const esc = (v: unknown): string => {
  const raw = String(v ?? '');
  // Excel evaluates a leading =/+/-/@ as a formula even inside a quoted field — neutralize
  // with a leading apostrophe (renders as text). Also fold \t and \r into the safe path.
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
```

### 4b. Export ignores the search filter (over-inclusive PII file)

**Why:** the UI sends `q` (the route comment even says "Same filters as the inbox") but the
export's zod schema omits `q`, and zod strips unknown keys — searching one customer then
clicking CSV downloads up to 5,000 payments for ALL customers.

**What:** extract ONE shared filter builder used by both `GET /payments` and `GET /export.csv`
so they can never drift again:
```ts
const listFilterSchema = z.object({
  q: z.string().max(120).optional(),
  status: z.enum(['all', ...STATUSES]).optional(),
  flagged: z.enum(['0', '1']).optional(),
  tax: z.enum(['all', ...TAX_STATUSES]).optional(),
  noVoid: z.enum(['0', '1']).optional(),   // see §8e (Reports CSV)
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
function buildListWhere(q: z.infer<typeof listFilterSchema>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (q.status && q.status !== 'all') where.status = q.status;
  else if (q.noVoid === '1') where.status = { not: 'void' };
  if (q.flagged === '1') where.flagged = true;
  if (q.tax && q.tax !== 'all') where.taxInvoiceStatus = q.tax;
  // flag/tax queues exclude voided rows to match the summary badges (§7a)
  if ((q.flagged === '1' || (q.tax && q.tax !== 'all')) && !where.status) where.status = { not: 'void' };
  const range = thaiDayRange(q.from, q.to);
  if (range) where.createdAt = range;
  const term = q.q?.trim();
  if (term) {
    where.OR = [
      { customerName: { contains: term, mode: 'insensitive' } },
      { customerCode: { contains: term, mode: 'insensitive' } },
      { senderName: { contains: term, mode: 'insensitive' } },
      { ref: { contains: term, mode: 'insensitive' } },
      { bank: { contains: term, mode: 'insensitive' } },
      { salesName: { contains: term, mode: 'insensitive' } },
      { amount: { contains: term } },
    ];
  }
  return where;
}
```
Both routes then do `const q = listFilterSchema.safeParse(req.query ?? {})` (see §5) and
`const where = buildListWhere(q.data)`. `GET /payments` keeps its extra `limit` field — parse
it separately or extend the schema for that route only.

### 4c. Silent truncation at 5,000 rows

**Why:** `take: 5000`, newest-first — an all-time export silently drops the OLDEST rows;
finance reconciling totals has no signal the file is partial.

**What:** page through everything with a stable cursor instead of a single capped query:
```ts
const rows: PaymentRow[] = [];
let cursor: string | undefined;
for (;;) {
  const batch = await prisma.payment.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],   // id tiebreak → stable cursor pagination
    take: 5000,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  rows.push(...batch);
  if (batch.length < 5000) break;
  cursor = batch[batch.length - 1].id;
}
```
(Volumes are modest — tens per day — so memory is a non-issue for years; the loop just removes
the silent cliff.)

---

## 5. zod `.parse` → `safeParse` + 400 (house pattern)

**Why:** `GET /payments`, `GET /reports`, `GET /export.csv` call `.parse(req.query)`. A
ZodError has no statusCode and no global error handler exists, so any invalid query
(`?limit=501`, `?status=bogus`) returns **500** with a stack in the logs. Every other route in
the codebase uses `safeParse` + 400 (`api/src/routes/diana.ts` ~143, 294, 348).

**What:** in all three GET routes:
```ts
const parsed = listFilterSchema.safeParse(req.query ?? {});   // (reports: its own schema)
if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
const q = parsed.data;
```

---

## 6. Frontend security/session fixes

### 6a. Logout must clear the stored JWT — `juno/src/Juno.tsx`

**Why:** the ออก button only does `onLogout` → `setAgent(null)`; `juno_token`/`juno_agent`
stay in localStorage, so F5 silently restores the full supervisor session on a shared
computer for the rest of the 12h JWT. Vesta calls `clearSession()`; Juno dropped it.

**What:** import `clearSession` from `./lib/api` and change the header button (~line 57) to
`onClick={() => { clearSession(); onLogout(); }}`.

### 6b. 401 (daily token expiry) must return the user to Login — `juno/src/lib/api.ts` + `App.tsx`

**Why:** `authed()` clears the session on 401 and throws, but nothing updates React state —
after the 12h expiry the app is a dead husk of "โหลดข้อมูลไม่สำเร็จ" with no path back to
Login except a manual reload nothing hints at.

**What:** in `api.ts`:
```ts
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn; }
```
…and inside `authed()`'s 401 branch, after `clearSession()`, add `onUnauthorized?.();`.
In `App.tsx`:
```ts
useEffect(() => { setOnUnauthorized(() => setAgent(null)); return () => setOnUnauthorized(null); }, []);
```
(import `useEffect` and `setOnUnauthorized`).

---

## 7. Lifecycle-consistency fixes — `api/src/routes/juno.ts`

### 7a. Voided rows must leave the flag/tax queues

**Why:** the summary badges exclude `void` (`~lines 69-70`) but the list queries don't — a
voided flagged payment stays in the ตรวจสอบยอด list forever while the badge says otherwise.

**What:** already handled by `buildListWhere` in §4b (the `flagged/tax → status not void`
line). Verify both queue tabs match their badges after the change.

### 7b. Status transitions: clear stamps, lock void

**Why:** (1) moving a payment BACK to `received` (or to `void`) keeps the old
`verifiedById`/`verifiedAt` — the row reads as simultaneously unverified and verified-by-Dr.M.
(2) All 4×4 transitions are accepted, so a mis-click on a voided duplicate one-click
resurrects it into `recorded` and every report total.

**What:** in `POST /payments/:id/status`, fetch the current status (extend the existing
`findUnique` select to `{ id: true, status: true }`), then:
```ts
const cur = /* the fetched row */;
if (!cur) return reply.code(404).send({ error: 'not_found' });
// A voided payment must be explicitly restored to 'received' before re-verifying.
if (cur.status === 'void' && (body.data.status === 'verified' || body.data.status === 'recorded')) {
  return reply.code(409).send({ error: 'void_locked' });
}
const advancing = body.data.status === 'verified' || body.data.status === 'recorded';
const p = await prisma.payment.update({
  where: { id: req.params.id },
  data: {
    status: body.data.status,
    ...(advancing
      ? { verifiedById: req.agent?.id ?? null, verifiedAt: new Date() }
      : { verifiedById: null, verifiedAt: null }),   // received/void clear the stamps
  },
});
```
Frontend (`juno/src/Juno.tsx` Detail drawer): when `p.status === 'void'`, disable the
ตรวจแล้ว/บันทึกแล้ว buttons (keep รอตรวจ enabled as the un-void path) so the 409 is never hit
in normal use.

### 7c. Flag-note append: make it atomic

**Why:** the flag route does findUnique → JS string-concat → update; two near-simultaneous
flag notes lose one (an audit-trail entry on the fraud queue vanishes silently).

**What:** replace the read-modify-write with a single SQL statement, then re-read for the
response:
```ts
const extra = body.data.note?.trim();
const tag = extra ? `[finance] ${extra}` : null;
const updated = await prisma.$executeRaw`
  UPDATE "Payment"
  SET "flagged" = ${body.data.flagged},
      "note" = CASE WHEN ${tag}::text IS NULL THEN "note"
                    WHEN "note" = '' THEN ${tag}
                    ELSE "note" || E'\n' || ${tag} END
  WHERE "id" = ${req.params.id}`;
if (updated === 0) return reply.code(404).send({ error: 'not_found' });
const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
return { ok: true, payment: toRow(p!) };
```
(Remove the now-unneeded prior `findUnique`.)

---

## 8. Frontend UX fixes — `juno/src/Juno.tsx` (+ small `lib/api.ts` additions)

### 8a. Mobile: the Detail drawer must be reachable

**Why:** the drawer root is `w-[380px] shrink-0 hidden md:block` — on any phone, tapping a row
highlights it and shows NOTHING. The entire verify/flag/tax workflow is dead on mobile.

**What:** render the drawer as a full-screen overlay below `md` and keep the sidebar at `md+`.
Concretely, change the Detail root from
`<div className="w-[380px] shrink-0 hidden md:block">` to:
```tsx
<div className="fixed inset-0 z-30 bg-slate-900/40 md:static md:z-auto md:bg-transparent md:w-[380px] md:shrink-0">
  <div className="absolute inset-x-0 bottom-0 top-10 md:static bg-white rounded-t-2xl md:rounded-xl border border-slate-200 overflow-y-auto md:sticky md:top-[104px] md:max-h-[calc(100vh-120px)]">
    ... existing drawer content unchanged ...
  </div>
</div>
```
(i.e. move the white-card classes onto the inner div; the existing sticky/max-h classes move
to `md:` variants). Ensure the ✕ close button remains visible at the top on mobile. Verify
with `npm run dev` + a narrow viewport: tap row → overlay opens; ✕ closes it.

### 8b. Drawer actions must surface failures

**Why:** `run()` has `catch { /* ... */ }` — a failed verify/record/void/flag/tax click shows
a spinner flash and then nothing. In a money workflow the operator believes it registered.
Vesta's EditPanel shows 'บันทึกไม่สำเร็จ'.

**What:** in `Detail`, add `const [error, setError] = useState('');`. In `run()`: clear it on
entry (`setError('')`), and in the catch:
```ts
catch (e) {
  setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');
}
```
Render it once, above the lifecycle-actions section:
```tsx
{error && <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} /> {error}</div>}
```

### 8c. `applyUpdate`: no side effects inside the state updater

**Why:** `setRows((prev) => { ... load(); return prev; })` runs a network fetch inside a state
updater — React 18 StrictMode double-invokes updaters (double fetch, out-of-order settle), and
React may replay updaters when re-basing. The branch doesn't even use `prev`.

**What:** replace `applyUpdate` with:
```ts
function applyUpdate(p: Payment) {
  setSelected(p);
  // a row may drop out of a pre-filtered queue (unflagged / tax issued) → refetch those
  if ((view === 'flags' && !p.flagged) || (view === 'tax' && p.taxInvoiceStatus !== 'requested')) {
    load();
  } else {
    setRows((prev) => prev.map((r) => (r.id === p.id ? p : r)));
  }
  onChanged();
}
```

### 8d. Drawer selection: re-sync on refetch, close on tab switch

**Why:** `selected` holds the object from the click; refreshes replace `rows` but not
`selected` (drawer can show 'รอตรวจ' beside a row badge saying 'ยกเลิก'), and switching tabs
keeps a foreign payment open beside the wrong queue.

**What:** in `load()`'s `.then`, after `setRows(r.payments)`, add:
```ts
setSelected((prev) => (prev ? r.payments.find((x) => x.id === prev.id) ?? prev : null));
```
And add `useEffect(() => setSelected(null), [view]);` in `PaymentsView`.

### 8e. Tax invoice: reachable after the fact + Reports CSV consistency

**Why:** (1) the tax block renders only when a request was captured at forward time — but the
common real case is the customer asking for ใบกำกับภาษี days later; the backend accepts
`requested` any time, the UI just never offers it. Also a wrong request can only be buried by
falsely marking it `issued` ('none' is accepted by the API but unreachable). (2) The Reports
tab's CSV button exports voided payments the on-screen report excludes (totals won't
reconcile), and its `.catch(() => undefined)` hides download failures entirely.

**What:**
1. In the Detail drawer, remove the `(p.taxInvoiceStatus !== 'none' || p.taxInvoice) &&`
   render condition — always show the tax block. When `p.taxInvoiceStatus === 'none'`, show a
   single `ขอใบกำกับภาษี` button → `run('taxreq', () => setTaxInvoice(p.id, 'requested'))`.
   When `requested`, ALSO show a small `ยกเลิกคำขอ` text-button → `setTaxInvoice(p.id, 'none')`
   (the API's enum already allows it). Keep the requested/issued buttons as-is otherwise.
2. In `juno/src/lib/api.ts`, add `excludeVoid?: boolean` to `PaymentFilter` and in
   `filterQuery`: `if (f.excludeVoid) p.set('noVoid', '1');` (server side handled in §4b).
3. Reports CSV button: `downloadCsv({ from: from || undefined, to: to || undefined, excludeVoid: true })`.
4. Reports: add `const [error, setError] = useState('');`, replace `.catch(() => undefined)`
   with `.catch(() => setError('ดาวน์โหลดไม่สำเร็จ'))`, render the error next to the button.

---

## 9. Config/docs — local compose CORS + env documentation

**Why:** out of the box, `docker compose up` + http://localhost:5176 cannot even log in: the
api's CORS default (`WEB_ORIGIN: http://localhost:5173`) rejects Juno's origin. `JUNO_API_URL`
(and the pre-existing `DIANA_API_URL`) appear in compose but not `.env.example`.

**What:**
1. `docker-compose.yml`, api service:
   `WEB_ORIGIN: ${WEB_ORIGIN:-http://localhost:5173}` →
   `WEB_ORIGIN: ${WEB_ORIGIN:-http://localhost:5173,http://localhost:5175,http://localhost:5176}`.
2. `.env.example`: update the `WEB_ORIGIN` line to the same comma-separated default and add:
   ```
   # Diana / Juno static bundles: public URL of the api, baked at build (compose build args)
   DIANA_API_URL=http://localhost:3000
   JUNO_API_URL=http://localhost:3000
   ```
3. `docs/JUNO_DEPLOY.md`: under Railway step 3, add one line: "For local docker-compose the
   api's WEB_ORIGIN must likewise include http://localhost:5176 (the compose default now
   does)."

---

## 10. Verify, then commit

Run ALL of these; every one must pass:

```bash
cd C:\Users\khunn\Project\Minerva\api
npx prisma validate
npx prisma generate
npx tsc --noEmit

cd ..\juno
npm run build          # tsc -b && vite build
```

Grep sanity checks (expect NO matches):
```bash
cd C:\Users\khunn\Project\Minerva
grep -n "\.parse(req.query" api/src/routes/juno.ts        # all safeParse now
grep -n "console.error" api/src/routes/messages.ts | grep -i juno   # req.log.error now
grep -rn "hidden md:block" juno/src/Juno.tsx               # mobile overlay now
```
And expect matches:
```bash
grep -n "@unique" api/prisma/schema.prisma | grep slipMessageId
grep -n "clearSession" juno/src/Juno.tsx
grep -n "financeSentAt" api/src/routes/messages.ts | grep 409
```

Manual smoke (optional, needs Docker): `docker compose up db api` then exercise
`POST /api/messages/:id/to-finance` twice — second call must 409; check exactly one Payment
row exists.

Commit on the `juno` branch (do NOT touch `main`, do NOT push unless told):
```
Juno review fixes: idempotent payment write, Thai-time day math, CSV hardening, session + UX fixes

- Payment: unique slipMessageId; /to-finance now 409s on re-forward, upserts the Payment
  BEFORE the sheet post (record of truth no longer gated by the mirror), fails loudly
- All day bucketing/filters/display in UTC+7 (was UTC — wrong dates for 00:00-07:00 Thai)
- CSV: formula-injection neutralized, q filter honored (shared where-builder), cursor-paged
  (no silent 5000-row cliff)
- safeParse+400 on GET queries (was .parse → 500)
- Logout clears the JWT; 401 returns to Login; drawer errors surfaced; mobile overlay for
  the detail drawer; void locks verify/record + clears stamps; voided rows leave the queues;
  atomic flag-note append; tax-invoice requestable after the fact; Reports CSV excludes voids
- Local compose CORS default includes the Juno/Diana origins; env vars documented
```

## Known non-issues (do not "fix")

- `juno/` has no `.dockerignore` — reviewed and REFUTED as a build-breaker (Docker COPY merges
  directories; the image's Linux node_modules survive). Matches diana/vesta. Leave it.
- `amount` as String, supervisor-role gating, sheet mirror on, track-only tax invoices —
  owner-locked decisions.
- `FinanceAudit` coexisting with `Payment.flagged` — intentional; do not remove.
