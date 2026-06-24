# M2 Security Review — outcomes

Multi-agent adversarial review of M2 (AI draft + approve/send + guardrails + learning).
4 lenses (guardrail-bypass, authz-send, pipeline-robustness, data-exposure) → adversarial
verification. **21 raw findings → 18 confirmed real → 6 fixed in M2; 12 deferred.**

## Fixed in M2

1. **Guardrail keyword denylist was trivially evadable** (`llm/guardrails.ts`) — added text
   normalization (lowercase + strip whitespace/zero-width), English/romanized terms, and a
   numeric+currency (`baht/บาท/THB/฿`) pattern. Verified: `PRICE?`, `ร า ค า`, `do you have stock?`,
   `50000 baht` all → `price_stock`.
2. **Customer text was interpolated raw into a single user prompt** (`llm/prompt.ts`,
   `llm/anthropic.ts`) — split into a trusted **system** prompt (rules + KB + anti-injection) and a
   **user** turn with the customer message fenced and labelled as untrusted data.
3. **`applyGuardrails` could keep a model `needs_human` draft containing a fabricated number**, and a
   `draft` could assert a price the keyword check missed (`llm/guardrails.ts`) — now: (a) a model
   `needs_human` draft is kept only if number-free, else the canned override is used; (b) the AI's own
   draft text is scanned, so a `draft` that states a price/stock/clinical answer is downgraded to
   `needs_human`. Benign numeric drafts (e.g. "จัดส่ง 2-3 วัน") are NOT over-escalated.
4. **`/reply` had no replay guard → double-send** (`routes/messages.ts`, schema) — added a unique
   `Message.answersMessageId`; the agent reply is claimed atomically before the LINE push, so a
   double-click / retry / concurrent request gets `409 already_replied`. Send failure releases the claim.
5. **Webhook re-drafted on LINE's normal delivery retries** (`routes/webhook.ts`) — dedup by
   `channelMsgId` (skip already-stored events) + cap events per request at 50.
6. **Dry-run send logged LINE userId + full reply text** (PDPA) (`line/send.ts`) — now logs a masked
   userId and the reply length only, never the text.

## Deferred (tracked for later hardening / M3)

All are human-in-the-loop-mitigated (a staff member approves every send; the AI never auto-sends) and
gated by the numbers-confirm on send. None break a spec §8 invariant.

- **medium** — No input-length cap on customer text before Claude (`llm/draft.ts`). Bounded by LINE's
  ~5000-char limit + signature gate; add a clamp before M3.
- **low** — Numbers-confirm is a client-asserted one-click boolean, not a server-issued two-step token
  (`routes/messages.ts`).
- **low** — KB-sensitivity escalation trusts model-declared `used_kb` (`llm/draft.ts`); the independent
  question/draft scan is the real backstop. Revisit with M3 retrieval (scan retrieved set).
- **low** — Sensitivity detection not re-run on the outgoing `finalText` at send time (`routes/messages.ts`).
- **low** — Reply doesn't consult `draft.type`; agent `Message` doesn't persist `guardrailReason` for audit.
- **low** — `learned→KB` promote copies customer-derived `questionVariants` verbatim (supervisor-gated;
  let the supervisor edit before save / sanitize) (`routes/learning.ts`).
- **low** — Fire-and-forget draft generation: a DB (not LLM) failure leaves no draft + no `needs_human`
  placeholder (`routes/webhook.ts`). Message itself is not lost; emit a `draft:error` signal.
- **low** — Parser doesn't clamp draft/note length and uses a global fence-strip (`llm/parser.ts`).
- **low** — No explicit Fastify `bodyLimit` (default 1MB) (`index.ts`).
- **low** — Draft-failure error object logged unscrubbed; could echo row data on a DB error (`routes/webhook.ts`).
- **info** — `used_kb` id matching is case-insensitive and correct (no bug).
