# EXPRESS BRIDGE — Minerva/Diana issue bills straight into Express (Plan)

*Drafted by Fable, 2026-07-22. Status: awaiting Mike's read + go/no-go per phase.*

The **Express Bridge** lets a confirmed sale become a real **Express IV (ขายเชื่อ)** without
accounting re-keying: staff clicks **ออกบิล Express** on a confirmed order in the Minerva console
(LINE lane) or Diana admin (web lane), and the bill appears in Express with its own Express
document number — then flows back out as a PDF the customer receives in LINE.

Not a new deity (12-god lineup stays locked): it is a **bridge component** in the Minerva/Juno
lane, following Mercury's proven two-node pattern (cloud board + on-prem worker, outbound-only).

---

## 1. The problem being solved

- Every sale confirmed in chat is keyed **twice**: once by staff in the conversation, once by
  accounting into Express. Double work, transcription errors, and a lag before the customer can
  receive their bill document.
- Express (FoxPro desktop, PROMINENTSERVER) has **no API and no official document import** —
  vendor forum explicitly discourages injecting transaction documents. So the bridge must go
  through the real UI, where every entry passes Express's own validation, numbering, and posting.

## 2. Decisions locked (owner, 2026-07-22)

| Decision | Choice |
|---|---|
| Trigger | **Staff clicks per bill** — human-in-loop, matches the staged-autonomy roadmap |
| Doc type v1 | **IV — credit sales (ขายเชื่อ)** only; cash/RE later if wanted |
| Lanes | **Minerva (LINE)** in v1; **Diana (web)** as soon as its order capture exists (prereq build) |
| Bridge host | **PROMINENTSERVER itself** — keying is local to the data, immune to the degraded 10 Mbps LAN leg |
| Return leg | **Doc number + PDF back to LINE** — Minerva sends the actual bill document in chat |
| Method | **UI automation keyer** (AutoHotkey); direct DBF *writes* rejected as corruption risk |

**Pre-flight worth one phone call:** ask the Express dealer whether an official document-import
add-on exists for our version. If yes, it replaces the keyer (§4) and nothing else changes.

## 3. Architecture — two nodes, Mercury pattern

```
Minerva console / Diana admin ──"ออกบิล Express"──▶  BillJob queue (cloud, Pantheon api)
                                                        │  outbound HTTPS poll (no inbound port)
                                              Bridge worker on PROMINENTSERVER
                                                        │  AutoHotkey keys IV into Express UI
                                                        │  reads doc number back (read-only DBF peek)
                                                        │  prints bill → PDF → uploads
                                                        ▼
                       order stamped with IV number ◀── job done ──▶ PDF sent to customer in LINE
```

**BillJob** (cloud): `{ id, source: minerva|diana, orderRef, arCode, lines[{expressSku, qty,
unitPrice}], status: pending|keying|done|blocked|failed, expressDocNo?, pdfUrl?, error? }`.
Jobs are **strictly serialized** — one Express keying session, one job at a time.

**Bridge worker** (on-prem, Windows service or scheduled loop): polls the queue, claims a job
(`keying`), drives Express, reports back. No secrets in the cloud beyond its own auth token;
nothing on the LAN is reachable from outside.

## 4. Express-side method

- **Keying:** AutoHotkey script drives the ขายเชื่อ (IV) entry screen — Express is fully
  keyboard-navigable, so each bill is a deterministic key sequence: customer AR code → lines
  (product code, qty, price) → save. The dedicated Express session on the server is used by the
  bridge only; humans never type in that window.
- **Doc-number capture + idempotency:** every job's `orderRef` is keyed into the document's
  reference/หมายเหตุ field. After save, the worker reads the sales-transaction DBF **read-only**
  to fetch the Express doc number for that reference. Read-only DBF access is safe — only *writes*
  are the vendor-forbidden hazard — and it doubles as crash recovery: before keying, the worker
  checks whether the `orderRef` already exists in Express, so a job can never issue twice.
- **PDF:** worker prints the saved bill to *Microsoft Print to PDF*, names it by doc number,
  uploads it to the cloud with the job result.

## 5. Mapping — never guess a code

Two mapping tables in the Pantheon DB, both **fail-closed**:

- **Customer map:** LINE customer / Diana account → Express AR code (ลูกหนี้). Seeded once from
  an Express AR export; unmapped customer → job `blocked`, console shows "จับคู่รหัสลูกหนี้ก่อน"
  with a picker (search the AR list) — staff fixes the mapping once, job resumes. New AR
  customers get created *in Express by accounting first* (v1 does not create master data).
- **SKU map:** catalog SKU (dashed key per suite convention) → Express product code. Seeded from
  an Express stock export diffed against the 1187-SKU catalog; unmapped line blocks the job the
  same way.

Prices come from the order as staff confirmed them — the bridge keys what was sold, it does not
re-price.

## 6. Failure model

- **Fail-closed everywhere:** any keying error, screen mismatch, or timeout → job `failed`,
  Express session screenshot attached, push alert to the owner OA (AppDent Suggestion). No
  retry-blind loops on a half-keyed document.
- **Nightly recon:** diff the day's `done` jobs against an Express sales report export (the
  report-461 / doc-range trick) — alert on any bill in Express without a job or job without a
  bill.
- **LAN reality:** worker lives on the server precisely so the degraded 10 Mbps leg only carries
  the small HTTPS poll + PDF upload, never the keying.

## 7. Phases

**Phase 0 — owner pre-flights (blocking):**
1. Dealer call: official import add-on for our Express version — yes/no + price.
2. Confirm PROMINENTSERVER can (a) run a dedicated Express client session under its license
   seats, and (b) reach the internet outbound (the APIPA LAN quirk makes this a real check, not
   a formality).
3. Export AR list + stock list from Express to seed the two mapping tables.
4. Name the reference field convention with accounting (which field carries `orderRef`).

**Phase 1 — spike (de-risks everything, no cloud work):** AHK script on the server keys ONE
hardcoded IV, captures its doc number via read-only DBF peek, prints the PDF. Accounting
verifies the bill is indistinguishable from a hand-keyed one, then voids it.

**Phase 2 — the loop:** BillJob queue + worker polling + ออกบิล button in the Minerva console +
mapping tables with the blocked-job picker. Doc number stamped back on the order.

**Phase 3 — return leg + safety net:** PDF upload → send-to-customer in LINE from the console;
nightly recon report; owner-OA failure alerts.

**Phase 4 — Diana lane:** order capture on prominentdental.com (its own small plan — cart,
confirm, staff review), then reuse the identical queue. Also the natural point to add cash/RE
doc types if wanted.

## 8. Risks & open questions

- **Express UI drift:** a version update can shift a screen and break the keyer → the spike
  script doubles as the canary; fail-closed catches it on bill #1, not bill #50.
- **License seats:** the dedicated session consumes one concurrent user — Phase 0 confirms we
  have headroom.
- **VAT/pricing edge cases:** discounts, VAT-inclusive vs exclusive lines — spike bill must
  include a discounted line so accounting signs off on the arithmetic Express produces.
- **Who voids mistakes:** wrong bill after issue = void in Express by accounting (bridge never
  deletes); console shows the void so the order can be re-billed.
- **บิลมือ interplay:** Juno's MB lane (969xxxx) stays as-is for now; whether Express becomes
  the issuer for those is a separate later decision.
