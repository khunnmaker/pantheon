# Venus — CRM deity (build brief)

> Handoff brief for a fresh session. Written 2026-07-04 from two grilled requirement sessions with the owner (Dr. M / CEO). Read this whole file before writing code. Companions: `docs/VULCAN_BRIEF.md` (the import pattern Venus copies), `docs/JUNO_BRIEF.md` + `docs/JUNO_PROCESS_BRIEF.md` (payment data Venus reads), `docs/CERES_BRIEF.md`, `docs/JUPITER_BRIEF.md` (portal that will badge Venus later).

## 1. What Venus is

**The 360° customer brain of the suite: who buys what, who's trending up, who's quietly fading, what to offer next, and what to be careful about — per customer.** Venus **tracks and tells; it never acts**: no auto-messages, no auto-discounts — it feeds humans (and later Minerva's context) with computed, auditable signals. Two lenses on the same data: the **rep lens** (open one customer, see everything before replying) and the **management lens** (segments, at-risk list, opportunity queue).

**Explicitly NOT Venus:** sending anything to customers, order entry, pricing changes, replacing Express, marketing automation.

## 2. Owner decisions (locked)

| Decision | Choice |
|---|---|
| #1 job (earlier session) | See a customer's **whole history in one place** |
| Stage model | **One stage per customer**, mirroring Minerva's stage field — same value, not a copy |
| Autonomy | **Track-and-tell only** — suggest to humans, never act |
| Lenses | **Both** rep and management |
| Purchase data (2026-07-04) | **Express sales-report import** — same preview→apply pattern as Vulcan's stock import; real line items (product, qty, price, date, customer) |
| Decline/trend logic | **RFM scores + Thai segments PLUS own-history trend** (last 90d vs previous 90d) — pure math in code, recomputed nightly, no AI |
| Suggestions | **Rules compute, AI writes** — deterministic signals; weekly AI batch writes one short Thai card ONLY for flagged customers |
| Precautions | **All four**: payment/credit behavior (from Juno), churn risk (RFM at-risk + evidence), complaint history (AI-tagged from LINE chats), manual pinned ข้อควรระวัง note |

Defaults accepted with the brief: shared customer pool + optional ดูแลโดย tag; agents read everything + write notes, imports/config supervisor-only; nightly math + weekly AI cards; **Phase 0 = verify a real sample Express sales report before any code**.

## 3. Suite conventions (do not break)

Monorepo `github.com/khunnmaker/minerva`; `main` auto-deploys on Railway. One Postgres, one Prisma schema, **Minerva `api/` = sole migrator, migrations ADD-only**. Venus backend = routes in the shared api (`api/src/routes/venus/*`); frontend = `venus/` static Vite+React+Tailwind (suggest port 5178, rose/pink theme — it's Venus), own Railway service via `VITE_API_URL`, origin appended to `WEB_ORIGIN`. Thai UI. Login follows the card-list layout standard (see `web/src/Login.tsx`). Role gate: **supervisor + agents** (this is the first non-Minerva deity agents can enter; `messenger`/`md` roles are Ceres-only — exclude them). SKU convention: store dashed key, display/type bare, dash-insensitive search (see the SKU convention used by Minerva/Vulcan).

Existing data Venus builds on: `Customer` (code = **Express customer code** — the join key for the import), `Product` (+ Vulcan stock), Minerva chat history + CustomerMemory + cross-sell relationships (real bought-together data), Juno `Payment` (+ RE numbers, ประเภทลูกค้า: โอนก่อนส่ง/เครดิต/เก็บปลายทาง, bank recon). **Nobody records product line items today — that's the gap the Express import fills.**

## 4. Phase 0 — the sample file (BLOCKING)

Ask the owner for **one real Express sales report export** (by invoice/receipt with line items, ideally covering a few months). Verify: encoding (Vulcan's stock .txt is the precedent — likely TIS-620/CP874 or UTF-8), columns (customer code, date, doc number, SKU, qty, unit price, amount), and whether credit notes/returns appear. Write the parser against the REAL file with self-certifying totals (Juno's bank parsers set the standard: parse → compare against the file's own declared totals). No sample, no build.

## 5. Import (Phase 1) — copy Vulcan's shape

- `POST /api/venus/import` (supervisor): upload → **preview** (parsed lines, matched/unmatched customers & SKUs, totals) → **apply** in one transaction. Dedupe on document number + line so re-importing an overlapping export is safe (Juno/Ceres bank dedupe = precedent).
- Additive tables (suggested): `SaleDoc` (docNo unique, customerId nullable until matched, date, total) + `SaleLine` (sku→Product nullable, qty, unitPrice, amount). Unmatched customer codes / SKUs land in a review list, resolvable later — imports must never silently drop lines; show excluded counts (no-silent-caps rule).
- History backfill: owner exports as far back as Express allows — RFM needs ≥ a year to be honest. Show the data-coverage window in the UI so nobody misreads a short window as a real trend.

## 6. Analytics engine (Phase 2) — nightly, pure code, no AI

Nightly job (also on-demand after an import):

- **RFM**: R = days since last purchase, F = purchase count, M = revenue, windowed 365d; score 1–5 by quintile within the customer base; map to Thai segments — ลูกค้าชั้นดี (Champions), ลูกค้าประจำ (Loyal), มาใหม่ (New), เสี่ยงหาย (At-Risk: high F/M history, R stretching), หายไปแล้ว (Lost). Store scores + segment on a `CustomerStats` row (one per customer, overwritten nightly — stats are derived, not append-only money).
- **Trend**: last-90d revenue & order count vs previous 90d → ▲/▼ % (needs both windows inside the data-coverage window).
- **Reorder cycles** (consumables): per customer×product with ≥3 purchases, median gap between purchases; flag **ถึงรอบสั่ง** when `today − lastPurchase > 1.25 × median`. Equipment (one-off big-ticket — heuristic: purchased once + unit price above a configurable threshold; supervisor can override per product) is excluded from cycles; its signal is big-ticket anniversary (service/upgrade timing) instead.
- All thresholds (windows, 1.25 multiplier, price threshold) = env/config with the defaults above; document each.

## 7. Suggestions & precautions (Phase 3)

**Signals (code)** per customer: due-to-reorder items, cross-sell gaps (Minerva's bought-together pairs the customer lacks), trend moves, segment transitions, big-ticket anniversaries.

**AI cards (weekly batch)**: ONLY customers with ≥1 active signal; prompt = the computed signals + a compact purchase summary; output = one short Thai suggestion card. **The AI may only restate computed signals — never invent numbers, prices, or products**; store the card WITH its input-signals JSON for audit; show a "คำแนะนำจาก AI (ตรวจสอบก่อนใช้)" label. Fail-soft: no LLM → signals still show as badges (the rules layer is the product; AI is the narrator).

**Precaution flags on every customer card:**
1. **การชำระเงิน** — from Juno: ประเภทลูกค้า = เครดิต + payment patterns (slow/irregular vs their own history). Juno data starts 2026-07, so this flag ramps up over months — display "ข้อมูลยังน้อย" below a minimum sample instead of a confident verdict.
2. **เสี่ยงหาย** — the RFM at-risk/lost segments surfaced as a warning WITH evidence ("หายไป 3 เดือน ทั้งที่เคยซื้อทุกเดือน").
3. **เคยมีปัญหา** — a batch AI pass tags complaint moments in LINE history (broken item, late delivery, wrong price) → `ComplaintTag` rows referencing the actual messages (clickable evidence, non-destructive, re-runnable). Supervisor can dismiss false positives.
4. **ข้อควรระวัง (manual)** — free-text pinned note, writable by agents + supervisor, shown in Venus AND in the Minerva console customer header (small console touch — keep it to a pin icon + tooltip/expand).

## 8. UI (`venus/`)

- **Rep lens — customer card**: header (name/code/stage/ดูแลโดย/segment chip/precaution pins) + tabs: ภาพรวม (RFM, trend arrows, active signals, latest AI card), การซื้อ (timeline + per-product table with cycle status), แชท (deep-link to the Minerva console), การชำระเงิน (Juno payments read-only), โน้ต.
- **Management lens — dashboard**: segment distribution, at-risk list ranked by M (lose the biggest first), top movers ▲▼, opportunity queue (all active signals across customers), import status + data-coverage window.
- Customer list: search by name/nickname/bare code (dash-insensitive), filter by segment/signal/precaution. Mobile-friendly; reps live on phones.

## 9. Build order

Phase 0 sample file → Phase 1 import + purchases view → Phase 2 stats engine + segments + dashboard → Phase 3 signals + AI cards + precautions (complaint tagging last — it needs its own review round for false positives).

## 10. Protocol & security

- Build via **/delegate** (Fable specs + reviews hunk-by-hunk, Sonnet executes); isolated git worktree (junction node_modules; unlink junctions link-only BEFORE any recursive delete); commit via Bash `git commit -F <file>`; expect `main` to move mid-build — rebase, never force-push.
- Never log PINs; probes use the **agent** login only (SEED_PASSWORD rotated — never ask the owner to paste passwords). Customer data stays internal — no external calls beyond the LLM API; complaint-tag prompts must treat chat text as untrusted content (prompt-injection boundary: customer text stays in the user turn, per Minerva's standard).
- Open items for the build session: real report format (Phase 0), equipment threshold + per-product overrides, whether ดูแลโดย should later gate lists per rep (owner said shared pool for now), Jupiter badge (`venus: at-risk count`) once Jupiter exists.
