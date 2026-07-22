# Venus Visit Reports — บันทึกการเข้าพบ (plan)

Owner request 2026-07-22: the sales team already posts free-form visit reports in a staff LINE
group (who they met, what stock the customer has left, what was proposed, what was ordered, why
something was NOT ordered, customer requests). Venus should ingest these as the qualitative half
of the 360° view. Owner decisions baked in: **listener = Mali's LINE channel** (bot invited into
the group); **unmatched customer names → the bot asks directly in the chat**; **analysis by
Fable** (claude-fable-5) with a **~2-minute quiet window** because reps send consecutive
messages; volume ≈ 5 posts/day (cost is trivial even on Fable; runs on the api's
ANTHROPIC_API_KEY, not the owner's Claude-Code allowance).

Reps change NOTHING about how they post. The bot never spams the group — it speaks only to ask
a customer-match question (and only when matching fails).

## Flow

```
LINE group post(s) ──► POST /webhook/mali (existing, fail-closed)
      │ source.type==='group' && groupId===VENUS_VISITS_GROUP_ID
      ▼
persist each message to VenusVisitMessage (inbox; restart-safe)
      ▼
debounce per (groupId, sender userId): timer resets on each new message,
fires VENUS_VISITS_DEBOUNCE_MS (default 120 000) after the LAST one
      ▼
batch → Fable extraction (text + images, untrusted content in user turn only)
      ├─ isVisitReport=false → mark skipped, stay silent (group chatter)
      ▼
customer match: normalized name vs VenusCustomer.name/searchKey + VenusCustomerAlias
      ├─ confident single match → VenusVisit(status matched) + action items
      └─ no/ambiguous → VenusVisit(status awaiting_match) + bot asks in the group;
         a short reply (1/2/3 or a customer code) resolves it and SAVES an alias
         so the same chat-name auto-matches forever after
      ▼
Venus UI: การเข้าพบ tab on the customer card · follow-up queue + unmatched queue on
the dashboard · last-visit date beside RFM
```

## Backend

**Webhook branch** (`api/src/routes/maliWebhook.ts`): today `handleMaliLineEvent` drops anything
with `source.type !== 'user'`. Add a group branch BEFORE the 1:1 lane: if
`ev.source?.type === 'group'`, then (a) `groupId === env.VENUS_VISITS_GROUP_ID` → visit lane,
(b) any other group → ignore. Mali's 1:1 staff-KB lane is untouched; group messages are NEVER
fed to Mali RAG. Existing fail-closed gates (missing creds → 200 no-op; signature verify) stay
exactly as they are. If `VENUS_VISITS_GROUP_ID` is unset, log arriving groupIds at info level
and do nothing — that log line is how the owner captures the ID during Phase 0.

**Buffering — persist-first** (`api/src/venus/visits.ts`, new): every accepted group message is
written to `VenusVisitMessage` immediately, THEN the in-memory debounce timer (pattern:
`api/src/llm/draftQueue.ts` — one `setTimeout` per key in a Map, reset on each message) is
armed per `(groupId, lineUserId)`. Key includes the sender so two reps posting interleaved
reports don't merge. On timer fire, process all of that sender's unprocessed rows as one batch.
On api boot, sweep unprocessed rows older than the window (covers a redeploy mid-window — no
report is ever silently lost).

**Extraction**: `callClaudeWithImages` (`api/src/llm/anthropic.ts`) with per-call model
override = `env.VENUS_VISITS_MODEL` (default `claude-fable-5`), meta
`{ app: 'venus', feature: 'visit-extract' }` (TokenUsage/Jupiter ต้นทุน AI is automatic).
System prompt: extraction contract only; ALL group text goes in the user turn (untrusted —
suite prompt-injection convention). Images: fetch via a NEW Mali-token variant of
`fetchMessageContent` (`api/src/line/client.ts:88` is hardcoded to the Prominent customer
token — must not touch that one). Sender rep name: Agent row via `source.userId` when the rep
has a LINE bind, else LINE group-member profile lookup, else "ไม่ทราบ". Output JSON:
`{ isVisitReport, customerNameGuess, visitDate?, summary, proposed[], orderedLines[],
objections[], stockNotes[], actionItems[{text, needsOwner}] }`. LLM error → batch stays
unprocessed, boot-sweep retries; never crashes the webhook (Venus cards fail-soft pattern).

**Matching**: `toSearchKey`-style normalization; try `VenusCustomerAlias` first (exact aliasKey),
then contains-match on `VenusCustomer.searchKey`/`name`. One hit → matched. Zero or many → ask
in the group (Thai, warm, ค่ะ; Mali register): up to 3 candidates numbered, "ตอบหมายเลข หรือ
พิมพ์รหัสลูกค้าได้เลยค่ะ". Reply capture is deterministic, no LLM: while a group has a pending
question, a message that is a bare 1–3 or a valid customer code resolves it → visit linked +
alias saved (`source: 'chat-confirm'`). Unanswered questions simply stay in the dashboard
unmatched queue (manual link there also saves the alias). One pending question per group at a
time; a new unmatched visit queues behind it (5 posts/day — contention is theoretical).

**Schema** (additive migration, soft-link by `customerCode` like `VenusNote`/`SaleDoc`):
- `VenusVisitMessage`: id, groupId, lineUserId, lineMessageId @unique, type (text|image),
  text?, visitId?, processedAt?, createdAt. (inbox + audit trail)
- `VenusVisit`: id, groupId, repName, repAgentId?, customerCode?, status
  (matched|awaiting_match|skipped), visitAt (first message ts), summary, extractJson, model,
  createdAt. @@index(customerCode), @@index(status).
- `VenusCustomerAlias`: aliasKey @unique (normalized chat name), customerCode, source
  (chat-confirm|manual), createdAt.
- `VenusActionItem`: id, visitId, customerCode?, text, needsOwner, done @default(false),
  doneBy?, doneAt?, createdAt. @@index(done).

**Routes** (all behind existing `requireApp('venus')` gates in `api/src/routes/venus.ts`):
`GET /api/venus/visits?customerCode=|status=|recent=1` · `POST /api/venus/visits/:id/link`
{customerCode} (manual link + alias) · `GET /api/venus/action-items?open=1` ·
`POST /api/venus/action-items/:id/done` (and undone). No new supervisor-only surface.

**Env**: `VENUS_VISITS_GROUP_ID`, `VENUS_VISITS_DEBOUNCE_MS` (default 120000),
`VENUS_VISITS_MODEL` (default claude-fable-5). Reuses `MALI_LINE_CHANNEL_*` creds.

## Frontend (venus/)

- `CustomerDetail.tsx`: new tab **การเข้าพบ** (after การซื้อ): timeline of visits — date, rep,
  summary, chips for สั่งซื้อ/เสนอ/ไม่ซื้อเพราะ/สต็อก, action items with ✓. Header (ภาพรวม
  tiles): **เข้าพบล่าสุด** date beside RFM.
- `Dashboard.tsx`: two new cards — **รายการติดตาม** (open action items suite-wide, needsOwner
  flagged first — e.g. "ตีราคาหัวกรอ Sunshine ทั้งเล่ม", ✓ to close) and **ยังไม่จับคู่ลูกค้า**
  (awaiting_match visits with a customer-picker; hidden when empty).
- `lib/api.ts`: types + the 4 endpoints above.

## Phases

- **Phase 0 — owner, blocking live wiring**: (1) in the LINE Official Account console for the
  MALI channel, enable "Allow bot to join group chats"; (2) invite Mali's OA into the sales
  group; (3) anyone posts one message; (4) read the logged groupId from Railway api logs →
  set `VENUS_VISITS_GROUP_ID`. (Confirm MALI_LINE_* creds are already on the api service.)
- **Phase 1 — backend** (schema, webhook branch, buffer, extraction, matching, ask-in-chat)
  with mocked-LLM unit tests + webhook tests. Deployable dark: without the env var it only
  logs groupIds.
- **Phase 2 — frontend** (visits tab, follow-up + unmatched queues, last-visit).
- **Phase 3 — later**: archive visit photos onto the card; feed visits into AI suggestion
  cards ("เสนอ X ไว้เมื่อเข้าพบครั้งก่อน ยังไม่สั่ง"); last-visit recency as a §7 signal;
  optional weekly visit digest.

## Verification

Unit: extraction-pipeline tests with mocked LLM (cards.ts pattern), matcher tests (alias hit,
contains hit, ambiguous → question text), reply-capture parser tests, boot-sweep test.
Integration: webhook signature + group-routing tests (wrong group ignored, 1:1 lane untouched).
Live smoke (after Phase 0): owner or a rep posts a real report; verify batch → visit → card
tab → follow-up queue; then an intentionally odd customer name to see the ask-in-chat loop.

## Risks / notes

- LINE content endpoint: image bytes are fetchable for a limited window after send — fine at a
  2-min debounce; Phase 3 archiving would make them permanent.
- In-memory timers die on redeploy — the persist-first inbox + boot sweep covers it.
- `claude-fable-5` must be enabled for the api key; `VENUS_VISITS_MODEL` env-overrides if not.
- The bot must never reply to visit reports themselves (only match questions) — reps should
  not feel watched by an echo; silence is a feature.
- Group text is staff-authored but still untrusted LLM input — user turn only, restate-style
  extraction, no tool use in the extraction call.
