# EGERIA — Staff Knowledge Deity (Plan)

*Drafted by Fable, 2026-07-18. Status: awaiting Mike's read + go/no-go per phase.*

Egeria — the divine counselor who taught King Numa the laws and procedures of Rome — is the
Pantheon's **internal knowledge base**: staff ask "how does X work here?" in a dedicated LINE OA,
an AI answers from a curated company KB with citations, and anything it can't answer is routed to
the department that knows, whose reply is distilled back into the KB. Knowledge migrates out of
heads into the system, question by question.

She is a *minor* deity by design: the locked 12-god lineup is untouched. (Name alternative
considered: Moneta — Roman Mnemosyne — rejected for collision with Juno Moneta while Juno is
finance. **Final name = Mike's call**; everything below uses Egeria.)

---

## 1. The problem being solved

- Company knowledge is siloed per department; staff interrupt each other (or Mike) for answers.
- Nobody writes documentation proactively, so a classic wiki would stay empty.
- Therefore the system is built around **question-driven capture**: a human answers any given
  question at most once; after that the KB answers it. This is Minerva's learning-loop pattern
  (`LearnedAnswer` → distill → `KbEntry`) pointed inward at staff instead of outward at customers.

## 2. Channel decision — separate LINE OA, same provider

A **new LINE OA** dedicated to Egeria (working display name: "Egeria ผู้ช่วยความรู้"), kept strictly
apart from the customer OA — staff Q&A must never sit in the customer channel, and vice versa.

**Provider is the critical pre-flight check.** LINE userIds are namespaced per *provider*, and the
repo confirms all existing staff bindings (`Agent.lineUserId`, written by the APOLLO-/CERES-code
flow in `api/src/line/staffBind.ts`) live on the main company channel. So:

- **If the Egeria OA is created under the SAME provider as the main company OA** → every existing
  staff binding works on Egeria's channel immediately; bound staff just add the OA as a friend and
  start asking. This is the strongly preferred path.
- If it must be a different provider (like the AppDent owner OA was) → all staff re-bind via a new
  `EGERIA-XXXXXXXX` code (the bind-code machinery is generic; adding a prefix is trivial).

The plan implements the `EGERIA-` bind command either way — it doubles as onboarding for staff who
never bound to Apollo/Ceres.

**Env vars** (following the established service-prefix convention in `api/src/env.ts`):
`EGERIA_LINE_CHANNEL_ACCESS_TOKEN`, `EGERIA_LINE_CHANNEL_SECRET`.

**Reply economics:** unlike Minerva (whose replies wait for staff approval and therefore must use
`pushMessage`), Egeria answers autonomously within seconds — so it uses the **replyToken first**
(free, doesn't consume the OA's monthly message quota) and falls back to push only when the token
has expired (slow LLM call) or for escalation notifications. This keeps a free-plan OA viable far
longer; if push volume (escalations + fallbacks) ever nears the free cap, upgrading the Egeria OA
is a ~300฿/mo decision, not an architecture change.

## 3. Architecture

One new webhook + one new frontend on the existing monorepo pattern (single `api/` Fastify+Prisma
backend, per-deity Vite frontend as its own Railway service).

```
staff LINE message ──► POST /webhook/egeria  (signature: EGERIA_LINE_CHANNEL_SECRET)
                          │
                          ├─ unbound userId ──► fail-closed: "ผูกบัญชีก่อนนะคะ" + how-to (no knowledge, ever)
                          ├─ EGERIA-XXXXXXXX ──► bind (reuse staffBind.ts machinery)
                          └─ bound staff question
                                │
                                ▼
                        RAG answer pipeline (api/src/egeria/answer.ts)
                          1. embed question        (Voyage voyage-3, reuse api/src/memory/embeddings.ts)
                          2. retrieve top-K articles scoped to asker's role tier
                             (knowledge_embedding, pgvector HNSW — same shape as kb_embedding)
                          3. confidence gate (top cosine similarity + LLM self-check)
                          ├─ confident ──► Claude answers WITH CITATIONS ("ที่มา: [บทความ]")
                          │                → replyToken (push fallback) + log QnA row
                          └─ not confident ──► escalate:
                               • KnowledgeQuestion row (status: waiting)
                               • ask staff which department if unclear (quick-reply buttons)
                               • push to department answerer(s) w/ deep link to portal inbox
                               • asker told "ส่งต่อให้แผนก X แล้วค่ะ จะแจ้งเมื่อได้คำตอบ"
                                     │
                                     ▼
                        answerer answers (portal inbox; LINE #id reply = Phase-2 stretch)
                          → answer relayed to asker immediately (push)
                          → distillArticle() LLM pass → DRAFT article → review queue
                          → approved → published + embedded → next asker gets instant answer
```

**Hard isolation from Minerva's customer KB:** Egeria gets its **own tables**. Internal staff
knowledge must never be retrievable by `selectRelevantKb` (which can inject the *entire* customer
KB into drafts when it's small) — sharing `KbEntry` would be a leakage bug waiting to happen.

## 4. Data model (new Prisma models + one raw vector table)

```
KnowledgeArticle    id, title, body (Thai), departmentId, audience ('everyone'|'gm_plus'|'supervisor'),
                    lineExposable Boolean @default(true)   // supervisor-tier defaults false: portal-only
                    status ('draft'|'published'|'archived'), source ('seed'|'distilled'|'manual'),
                    authorAgentId, sourceQuestionId?, createdAt, updatedAt

KnowledgeDepartment id, code, nameTh, answererAgentIds String[]   // routing target for escalations

KnowledgeQuestion   id, askerAgentId, channel ('line'|'web'), questionText,
                    status ('answered_auto'|'waiting'|'answered_human'|'rejected'),
                    matchedArticleIds String[], topSimilarity Float?,
                    departmentId?, answererAgentId?, humanAnswer?, distilledArticleId?,
                    askedAt, answeredAt
                    // doubles as the full Q&A audit log AND the "what to document next" metric

knowledge_embedding (raw SQL, add-only migration): article_id PK/FK, embedding vector(1024),
                    HNSW cosine index — clone of the kb_embedding migration
```

Auth reuse: role tiers from `api/src/auth/jwt.ts`; `'egeria'` becomes an **all-staff app** (special
case in `hasAppAccess`: any active Agent passes for `'egeria'` — a knowledge base everyone can't
read defeats its purpose). Article-level `audience` does the real gating: retrieval filters to the
asker's tier, and gm_plus/supervisor articles never surface to employees — enforced in the SQL
retrieval query, not post-hoc.

**Conservative v1 content rule:** LINE answers draw only from `lineExposable` articles
(everyone/gm_plus); supervisor-tier material is portal-only. Phones get borrowed.

**Cost guardrails:** every LLM/embedding call tags `{ app: 'egeria', feature: 'staff-answer' |
'confidence' | 'distill' | 'kb-embed' }` through the `callClaude` choke point → visible in
Jupiter's ต้นทุน AI tab from day one. Per-staff rate limit (default 30 questions/day) bounds
token spend. Answer model = Sonnet-class (this is retrieval-grounded Q&A, not judgment work).

## 5. Frontend — `egeria/` workspace (Thai UI, mirrors suite conventions)

New Vite/React app + Railway service + `egeria.prominentdental.com`, SSO boot via
`@pantheon/ui` `redirectToPortalLogin` (copy Apollo's `App.tsx` bootstrap), `?local=1` fallback,
**`public/serve.json` copied verbatim** (cache-header lesson), portal tile added in `pantheon`.

Pages:
1. **ถามเอเจเรีย** — web ask box (same pipeline as LINE; useful at a desk + for supervisor-tier Qs)
2. **คลังความรู้** — browse/search published articles, filtered to viewer's tier; department facets
3. **คำถามรอตอบ** — answerer inbox (visible to department answerers + supervisor): waiting
   questions, answer form, one-click "answer + ส่งให้ผู้ถาม"
4. **ตรวจร่างบทความ** — distill review queue: approve / edit / reject drafts before publish
5. **จัดการ** (supervisor): departments + answerers, article CRUD (identity/code field FIRST in
   forms, per the standing form-order rule), metrics (auto-answer rate, escalations by department,
   token cost)

## 6. Seeding — beat the cold start (no "please write docs" ever)

- Fable/Sol draft **15–20 Thai how-to articles per Pantheon app** (Juno slip flow, บิลมือ, Ceres
  requests, Vesta stock, Apollo tasks, Minerva console, portal login…) sourced from `docs/*_BRIEF`
  + the shipped UIs — this is "how the system works" content we already possess. Seeded via
  `api/scripts/seed-egeria.ts`, marked `source: 'seed'`, reviewed by Mike before publish.
- Department/company-policy articles start EMPTY on purpose — the escalation loop fills them in
  demand order, which is the whole point.

## 7. Phases

**Phase 0 — pre-flight (Mike, ~15 min):** confirm deity name; create the Egeria OA **under the
same provider as the main company OA** (check in LINE Official Account Manager — if impossible,
say so and staff will re-bind); enable Messaging API; hand channel secret/token → Railway env
(values off-chat, per standing hygiene); decide department list + one answerer each.

**Phase 1 — backend core (Sol):** schema + add-only migrations; `/webhook/egeria` (signature,
fail-closed bind gate, EGERIA-bind command); answer pipeline with tier-scoped retrieval,
confidence gate, citations, replyToken-first sending; rate limit; TokenUsage tagging; tests
(bind gate, tier scoping, confidence branches). *Accept: bound staff gets a cited answer in LINE;
unbound gets only the bind prompt; employee never receives gm_plus content.*

**Phase 2 — escalation loop (Sol):** department routing + quick-reply department picker; answerer
push w/ deep link; portal answer inbox API; relay-to-asker; `distillArticle()` + review queue +
publish-embeds. Stretch: `#<id> คำตอบ` LINE reply capture when the answerer has exactly one open
question. *Accept: unanswerable question reaches the right human's LINE within seconds; their
portal answer reaches the asker; approved distill becomes a retrievable article that answers the
same question automatically.*

**Phase 3 — frontend + deploy (sonnet, Fable judges UX):** the 5 pages above; Railway service +
DNS + portal tile; SSO round-trip verified. *Accept: all pages live at egeria.prominentdental.com
behind SSO; tier filtering verified per role.*

**Phase 4 — seed + pilot:** seed articles in; pilot = 3–5 staff across 2 departments for one week;
watch auto-answer rate + escalation log; tune confidence threshold; then announce to all staff.

## 8. Open questions for Mike

1. **Name:** Egeria — ok? (Alternative: Moneta, with the Juno-collision caveat.)
2. **Provider:** can the new OA live under the main company OA's provider? (Determines re-bind.)
3. **Departments + answerers:** first list (e.g. บัญชี/การเงิน, คลังสินค้า, ขาย/บริการลูกค้า, HR)?
4. **All-staff access default** for the app itself — confirm.
5. **Supervisor-tier content in v1** — plan says portal-only, none over LINE. Confirm.

## 9. Standing lessons applied (so nobody re-learns them)

- Migrations are **add-only**; `npm ci` at repo **root** only (workspaces).
- Never regen `package-lock.json` on Windows with `node_modules` present.
- `public/serve.json` copied into the new frontend (stale-bundle fix).
- Work from a worktree; never assume the shared tree is clean/main.
- Real secret values never in chat, briefs, or prompts — placeholders only.
