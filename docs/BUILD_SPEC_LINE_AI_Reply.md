# BUILD SPEC — LINE AI Customer-Reply Assistant (human-in-the-loop)
**Client:** Prominent (dental distribution, Thailand) · **For:** Claude Code · **v1.0 · 23 Jun 2026**

> **สำหรับคุณไม้ (สรุปสั้น):** เอกสารนี้คือสเปกฉบับ "ส่งให้ Claude Code สร้าง" — รวมทุกอย่างที่เราทดลองในต้นแบบ (ตอบจาก KB, guardrails, คนอนุมัติก่อนส่ง, ประวัติรายลูกค้า, login, เรียนรู้, ความจำอัตโนมัติ, retrieval) แปลงเป็นระบบจริง พร้อม DB schema, prompt, และลำดับการสร้าง ให้ Claude Code ทำตามได้เลย UI เริ่มจากไฟล์ต้นแบบ `line_ai_reply_prototype.jsx` ที่มีอยู่แล้ว

---

## 1. Goal
Build an internal tool where **customer questions on LINE are answered by staff, assisted by an AI that drafts replies from a curated knowledge base (KB)**. The AI **never sends automatically** — a logged-in staff member reviews/edits/approves every reply. The system remembers each customer (3-layer memory) and learns from staff edits.

## 2. Scope
**In (v1):** single LINE Official Account; AI draft + human approval; per-customer memory (summary + retrieval + recent window); agent login & attribution; learning loop (capture staff edits → supervisor approval → promote to KB); guardrails (price/stock/clinical → human).
**Out (v1):** auto-send; live price/stock from ERP (Odoo) — phase 2; order placement via bot; multi-channel; image/voice understanding.

## 3. Tech stack (concrete — use these unless owner objects)
- **Backend:** Node.js + TypeScript, **Fastify**. SDKs: `@line/bot-sdk`, `@anthropic-ai/sdk`.
- **DB:** **PostgreSQL + `pgvector`** extension (one DB for relational data *and* vector retrieval). ORM: **Prisma**.
- **Embeddings:** **Voyage AI** (`voyage-3`, Anthropic-recommended) → store vectors in pgvector. Swappable behind an `EmbeddingProvider` interface.
- **LLM (drafting & summarizing):** **Claude API** — model `claude-sonnet-4-6`, `max_tokens` ~1000.
- **Frontend (agent console):** React + TypeScript + Tailwind + **Vite**. **Start from the existing `line_ai_reply_prototype.jsx`** as the UI foundation; wire it to the real API instead of calling the LLM directly.
- **Realtime:** WebSocket (Socket.IO) to push incoming questions/drafts to the console queue.
- **Auth:** email + password (bcrypt) + JWT; roles `agent` / `supervisor`.
- **Deploy:** Dockerized; `docker-compose` with `postgres` (pgvector image), `api`, `web`.

## 4. Architecture — the draft pipeline
```
LINE customer message
  → POST /webhook/line  (verify X-Line-Signature; never auto-reply)
  → upsert Customer (by lineUserId) + insert Message(role=customer)
  → embed question (Voyage) and run pipeline:
       a. load CustomerMemory.summary
       b. retrieve: top-K relevant past Messages (pgvector) + top-K relevant KbEntries (pgvector)
       c. build prompt (KB + summary + retrieved old msgs + recent window)
       d. call Claude → JSON {type, draft, used_kb, note}
       e. store Draft, push to console via WebSocket
  → agent (logged in) reviews in console → approve/edit
  → POST /api/messages/:id/reply → send via LINE push API
       · insert Message(role=agent, agentId, kbIds) ; embed it
       · if edited (final ≠ ai draft) → insert LearnedAnswer(status=pending)
  → on session end (inactivity 30m OR explicit "end") → summarize → update CustomerMemory
```

## 5. Data model (Prisma)
```prisma
model Customer {
  id          String   @id @default(cuid())
  lineUserId  String   @unique
  displayName String?
  firstSeen   DateTime @default(now())
  lastSeen    DateTime @default(now())
  messages    Message[]
  memory      CustomerMemory?
  sessions    Session[]
}
model Session {
  id         String    @id @default(cuid())
  customerId String
  customer   Customer  @relation(fields: [customerId], references: [id])
  status     String    @default("open")     // open | ended
  startedAt  DateTime  @default(now())
  endedAt    DateTime?
  messages   Message[]
}
model Message {
  id          String   @id @default(cuid())
  customerId  String
  sessionId   String?
  role        String                          // customer | agent
  text        String
  agentId     String?                         // who sent (if agent)
  kbIds       String[]                        // KB entries used
  channelMsgId String?                        // LINE message id
  createdAt   DateTime @default(now())
  customer    Customer @relation(fields: [customerId], references: [id])
  // embedding stored in separate table (pgvector) — see note
}
model CustomerMemory {
  customerId         String   @id
  customer           Customer @relation(fields: [customerId], references: [id])
  summary            String   @default("")
  summarizedThroughN Int      @default(0)     // message count covered by summary
  updatedAt          DateTime @updatedAt
}
model Agent {
  id           String   @id @default(cuid())
  email        String   @unique
  name         String
  passwordHash String
  role         String   @default("agent")     // agent | supervisor
  createdAt    DateTime @default(now())
}
model KbEntry {
  id              String   @id @default(cuid())
  category        String
  questionVariants String[]
  answer          String
  sku             String?
  sensitivity     String   @default("normal") // normal | price_stock | clinical | no_auto
  status          String   @default("active")  // active | pending | archived
  source          String   @default("manual")  // manual | learned
  lastVerifiedAt  DateTime @default(now())
  ownerAgentId    String?
  // embedding in pgvector
}
model LearnedAnswer {
  id              String   @id @default(cuid())
  customerQuestion String
  aiDraft         String
  finalAnswer     String
  agentId         String
  edited          Boolean  @default(true)
  status          String   @default("pending") // pending | approved | rejected
  promotedKbId    String?
  createdAt       DateTime @default(now())
}
model Draft {
  id          String   @id @default(cuid())
  messageId   String   @unique               // the customer message it answers
  type        String                          // draft | needs_human | out_of_scope
  draftText   String
  usedKb      String[]
  note        String?
  retrievedMsgIds String[]
  createdAt   DateTime @default(now())
}
```
**pgvector note:** add two embedding tables (or raw SQL columns of type `vector(1024)`): `message_embedding(message_id, embedding)` and `kb_embedding(kb_id, embedding)`. Create IVFFlat/HNSW indexes. Retrieval = cosine distance `ORDER BY embedding <=> $queryVec LIMIT k`.

## 6. Three-layer memory (the part that makes it scale)
For every draft, assemble context from:
1. **Long-term summary** — `CustomerMemory.summary` (gist of the whole relationship). Updated **automatically on session end** (inactivity timer 30 min, or explicit end). Generated by Claude from the full conversation.
2. **Retrieval** — embed the current question; pgvector cosine search returns top-K (default 3) relevant **past messages** + top-K relevant **KB entries**. This recalls specific old facts without sending the whole history.
3. **Recent window** — last N (default 10) messages verbatim for immediate continuity.

This keeps token cost/latency ~constant regardless of history length.

## 7. LLM contract (drafting)
**Model:** `claude-sonnet-4-6`. **Output: strict JSON only.** Prompt template (Thai — keep verbatim, inject variables):
```
คุณคือผู้ช่วย "ร่าง" คำตอบให้ลูกค้าของบริษัท Prominent (จำหน่ายอุปกรณ์ทันตกรรม) ผ่าน LINE
คำตอบจะถูกพนักงานตรวจก่อนส่งจริงเสมอ

ฐานความรู้ (KB ที่เกี่ยวข้อง):
{retrieved_kb}

{ถ้ามี} สรุป/ความจำระยะยาวของลูกค้าคนนี้:
{summary}

{ถ้ามี} ข้อความเก่าที่เกี่ยวข้องกับคำถามนี้ (retrieval):
{retrieved_messages}

ข้อความล่าสุดในบทสนทนา:
{recent_window}

กฎ:
1. ตอบจาก KB เท่านั้น ห้ามแต่งข้อมูล/ตัวเลขเพิ่มเอง
2. ถามเรื่องราคา หรือ มีของ/สต็อก/พร้อมส่ง → type "needs_human", draft ขอเช็คให้สักครู่ ห้ามเดาตัวเลข
3. คำถามเชิงคลินิก/การรักษา/วินิจฉัยอาการ → type "needs_human", note ว่าต้องให้ทันตแพทย์/ผู้เชี่ยวชาญตอบ
4. KB ไม่ครอบคลุม → type "out_of_scope"
5. ตอบได้ → type "draft"
6. โทน: พนักงานบริการหญิง สุภาพ อบอุ่น กระชับ ลงท้าย ค่ะ/คะ

ตอบ JSON อย่างเดียว: {"type":"draft|needs_human|out_of_scope","draft":"...","used_kb":["KB-..."],"note":"..."}

คำถามลูกค้า: "{question}"
```
**Summary prompt:** ask Claude to produce 2–3 sentence Thai summary of the conversation as durable memory.
**Parsing:** strip ```` ```json ```` fences, `JSON.parse`, validate shape; on failure → fall back to `type:"needs_human"` (safe default) and log.

## 8. Guardrails (must implement)
- `price_stock` / `clinical` questions → `needs_human` (never auto-draft an answer; v2 may pull live price from Odoo).
- KB-only answering; if not covered → `out_of_scope` + escalate.
- Any draft containing numbers (price/qty/date) → console requires explicit confirm (not one-tap).
- **LearnedAnswer → KB promotion requires `supervisor` approval** (never auto-add to KB).
- Verify LINE signature on webhook; reject if invalid.

## 9. LINE integration
- Webhook `POST /webhook/line`: verify `X-Line-Signature` (HMAC-SHA256 with channel secret). Handle `message`/`text` events. **Reply via push API only after agent approval** (do not use auto-reply token flow for sends; store and push).
- Send: `client.pushMessage(lineUserId, {type:'text', text})`.
- Map LINE `userId` → `Customer.lineUserId`.

## 10. API (REST + WS)
```
POST /webhook/line                  # LINE events (no auth, signature-verified)
WS   /console                       # push new pending drafts to logged-in agents
POST /api/auth/login                # {email,password} → JWT
GET  /api/queue                     # pending customer msgs + their drafts
GET  /api/customers/:id             # profile + memory + recent messages + stats
POST /api/messages/:id/reply        # {finalText} → send LINE, store, capture learned
POST /api/customers/:id/end-session # mark ended → trigger summary
GET/POST/PUT/DELETE /api/kb         # KB CRUD (write = supervisor)
GET  /api/learned                   # learned answers (pending/approved)
POST /api/learned/:id/promote       # supervisor → create KbEntry(source=learned)
POST /api/learned/:id/reject
GET  /api/metrics                   # % drafts approved unedited, response time, top topics
```
All `/api/*` require JWT; KB writes & learned-promote require role `supervisor`.

## 11. Learning loop
On approve, if `finalText !== draft.draftText` → create `LearnedAnswer(status=pending)`. Supervisor reviews in a "Learning" view; **promote** creates a new `KbEntry(source=learned, status=active)` (embed it so future retrieval uses it) or **reject**. Surface metric: edit-rate by KB category (= where KB is weak).

## 12. Non-functional
- **PDPA (Thailand):** store only necessary customer data; configurable retention (e.g., purge raw messages after N months, keep summaries); use Anthropic zero-data-retention option; document data flow; consent note on the LINE OA. 
- **Security:** secrets via env only; verify webhook signature; hash passwords; rate-limit `/api/*`.
- **Cost control:** retrieval keeps prompts small; cap `max_tokens`; cache KB embeddings; only embed messages once.
- **Reliability:** wrap all LLM/LINE calls in try/catch with retries + structured logging; safe-default to `needs_human` on any LLM/parse error.

## 13. Env vars
```
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
DATABASE_URL=postgresql://...
JWT_SECRET=
RECENT_WINDOW=10
RETRIEVE_K=3
SESSION_IDLE_MINUTES=30
```

## 14. Build milestones (order for Claude Code)
- **M0 — Scaffold:** monorepo (`/api`, `/web`), docker-compose (postgres+pgvector), Prisma schema + migrations, env loading, health check.
- **M1 — Ingest + console shell + auth:** LINE webhook (signature verify) → store customer/message; agent login (JWT, roles); console queue via WS (port the prototype UI, show incoming questions). *Accept:* a real LINE message appears in the console; login works.
- **M2 — Draft + send (human-in-the-loop) + guardrails:** KB CRUD + seed; draft pipeline (build prompt, call Claude, parse JSON); reply endpoint sends via LINE; price/stock/clinical → needs_human. *Accept:* staff can approve an AI draft and the customer receives it on LINE; price question is escalated, not answered.
- **M3 — 3-layer memory:** Voyage embeddings for messages + KB; pgvector retrieval; recent window; session-end auto-summary (idle timer + manual end). *Accept:* a question referencing old context is answered correctly via retrieval; summary updates after session ends.
- **M4 — Learning loop:** capture edits → LearnedAnswer; supervisor approve → promote to KB (embedded). *Accept:* an edited answer, once promoted, changes future drafts for the same question.
- **M5 — Polish:** metrics dashboard (edit-rate, response time, top topics), KB admin UI, PDPA retention job, basic tests, error handling pass.

## 15. Starting assets & open decisions
- **UI starting point:** `line_ai_reply_prototype.jsx` (already built) — reuse its layout/flow; replace direct LLM calls with the real API/WS.
- **Confirm with owner (คุณไม้):** (1) LINE OA channel access token + secret; (2) embeddings provider (Voyage vs alternative) + budget; (3) hosting (cloud/VPS); (4) initial KB content (top 30–50 real FAQs) — **collect before M2**; (5) whether agent auth should integrate an existing system (e.g., Google Workspace SSO).
- **Phase 2 (note, not v1):** live price/stock via Odoo integration; auto-send for ultra-safe intents (hours/address); image/voice; multi-OA.

## 16. Suggested repo structure
```
/api
  /src
    /line        webhook, signature, push
    /llm         anthropic client, prompt builder, parser
    /memory      embeddings, retrieval, summarizer
    /kb          crud, seed
    /learning    capture, promote
    /auth        jwt, roles
    /routes      rest + ws
    /db          prisma client
  prisma/schema.prisma
/web             (Vite React console — from prototype)
docker-compose.yml
README.md        (setup, env, run)
```

---
*This spec is implementation-ready. Claude Code should scaffold M0 first, confirm the open decisions in §15 with the owner where blocking, and implement milestone-by-milestone with the acceptance criteria as the definition of done. Safe-default everywhere: when unsure, route to a human, never auto-send.*
