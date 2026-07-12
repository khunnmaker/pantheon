import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { callClaude, llmAvailable } from '../llm/anthropic.js';
import { syncAllJunoToJupiter } from '../jupiter/sync.js';
import { runBackfill } from '../scripts/backfillParties.js';

// Module-level guard so the ~15k-upsert APPLY backfill can never run twice at once (a second
// APPLY returns {started:false, busy:true}). runBackfill itself keeps NO module state — each
// call is self-contained — so this single flag is the only serialisation the routes need.
let partyBackfillRunning = false;

// Jupiter accounting — the GROUP-WIDE consolidated cockpit + monthly close pack (Phase 1).
// A thin income/expense ledger over JupiterTxn across the 5 group companies (JupiterCompany),
// NOT yet a double-entry ledger (that is Phase 2). Every route is SUPERVISOR-ONLY (owner's
// cockpit): preHandler [requireAuth, requireRole('supervisor')]. Prefix /api/jupiter/acct.
//
// Money is stored as String baht (matching Payment/CeresExpense/JupiterTxn's convention):
// `amount` is the NET; vat/wht are tracked separately. Sums parse on read via baht().

// Same money-string convention as venus.ts / Ceres / Juno: strip commas/spaces, parseFloat,
// NaN → 0. "" (the schema default for "none") → 0.
function baht(s: string | null | undefined): number {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[,\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

// String baht → exact Decimal for the P2 shadow columns; "" (none) → null (not 0), so an
// absent vat/wht stays absent rather than a false zero. amount is regex-validated numeric.
function decOf(s: string | null | undefined): Prisma.Decimal | null {
  if (!s) return null;
  return new Prisma.Decimal(baht(s));
}

// A YYYY-MM month string → [start, end) DateTime window (local server time, inclusive start /
// exclusive next-month start). Invalid/absent → the current calendar month.
function monthRange(month?: string): { start: Date; end: Date; ym: string } {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-based
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [yy, mm] = month.split('-').map(Number);
    if (mm >= 1 && mm <= 12) {
      y = yy;
      m = mm - 1;
    }
  }
  // Anchor month boundaries to Thai time (UTC+7) — Railway runs UTC, so naive local-time
  // Dates would shift every period total by 7h at the boundary. Mirrors the suite's
  // bank/date convention (api/src/bank/*, ceres thaiDayKey).
  const sm = m + 1; // 1-based start month
  const ny = sm === 12 ? y + 1 : y;
  const nm = sm === 12 ? 1 : sm + 1; // 1-based next month
  const start = new Date(`${y}-${String(sm).padStart(2, '0')}-01T00:00:00+07:00`);
  const end = new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+07:00`);
  const ym = `${y}-${String(sm).padStart(2, '0')}`;
  return { start, end, ym };
}

const DIRECTIONS = ['income', 'expense'] as const;

export async function jupiterAccountingRoutes(app: FastifyInstance) {
  const gate = { preHandler: [requireAuth, requireRole('supervisor')] };

  // 1) GET /companies — active companies in display order (for the switcher chips).
  app.get('/api/jupiter/acct/companies', gate, async () => {
    const rows = await prisma.jupiterCompany.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { code: true, name: true, nameTh: true, kind: true, color: true },
    });
    return rows;
  });

  // 2) GET /summary?month=YYYY-MM — per-company {revenue, expense, profit} + a consolidated
  //    total. revenue = Σ baht(amount) income in the month (by `date`); expense = Σ expense.
  app.get('/api/jupiter/acct/summary', gate, async (req) => {
    const q = z.object({ month: z.string().optional() }).safeParse(req.query ?? {});
    const { start, end, ym } = monthRange(q.success ? q.data.month : undefined);

    const [companies, txns] = await Promise.all([
      prisma.jupiterCompany.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { code: true, name: true, nameTh: true, color: true },
      }),
      prisma.jupiterTxn.findMany({
        where: { date: { gte: start, lt: end } },
        select: { companyCode: true, direction: true, amount: true },
      }),
    ]);

    const acc = new Map<string, { revenue: number; expense: number }>();
    for (const c of companies) acc.set(c.code, { revenue: 0, expense: 0 });
    for (const t of txns) {
      const a = acc.get(t.companyCode);
      if (!a) continue; // txn for an inactive/unknown company — omit from the cockpit
      if (t.direction === 'income') a.revenue += baht(t.amount);
      else a.expense += baht(t.amount);
    }

    const perCompany = companies.map((c) => {
      const a = acc.get(c.code)!;
      return {
        code: c.code,
        name: c.name,
        nameTh: c.nameTh,
        color: c.color,
        revenue: a.revenue,
        expense: a.expense,
        profit: a.revenue - a.expense,
      };
    });
    const total = perCompany.reduce(
      (s, c) => {
        s.revenue += c.revenue;
        s.expense += c.expense;
        s.profit += c.profit;
        return s;
      },
      { revenue: 0, expense: 0, profit: 0 },
    );

    return { month: ym, companies: perCompany, total };
  });

  // 3) GET /txns?company=&month=&direction=&limit=200 — filtered ledger, newest first.
  app.get('/api/jupiter/acct/txns', gate, async (req) => {
    const q = z
      .object({
        company: z.string().optional(),
        month: z.string().optional(),
        direction: z.enum(DIRECTIONS).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
      })
      .safeParse(req.query ?? {});
    const { company, month, direction, limit } = q.success ? q.data : {};

    const where: Record<string, unknown> = {};
    if (company) where.companyCode = company;
    if (direction) where.direction = direction;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const { start, end } = monthRange(month);
      where.date = { gte: start, lt: end };
    }

    const rows = await prisma.jupiterTxn.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: limit ?? 200,
    });
    return rows;
  });

  // Shared field validation for create/edit. amount required non-empty on create (a txn with
  // no money is meaningless); vat/wht/note/party/category optional (default "").
  // Money must be numeric (digits, optional commas + one decimal) so a typo can't silently
  // become NaN→0 in a statutory tax total. MONEY_OPT also permits "" (the "none" default).
  const MONEY = /^\d[\d,]*(\.\d+)?$/;
  const MONEY_OPT = /^(\d[\d,]*(\.\d+)?)?$/;
  const txnBase = {
    direction: z.enum(DIRECTIONS),
    date: z.string().datetime().optional(),
    party: z.string().max(300).optional(),
    category: z.string().max(200).optional(),
    amount: z.string().min(1).max(40).regex(MONEY, 'amount ต้องเป็นตัวเลข'),
    vatAmount: z.string().max(40).regex(MONEY_OPT, 'VAT ต้องเป็นตัวเลข').optional(),
    whtAmount: z.string().max(40).regex(MONEY_OPT, 'หัก ณ ที่จ่าย ต้องเป็นตัวเลข').optional(),
    note: z.string().max(2000).optional(),
  };

  // 4) POST /txns — create one manual entry.
  app.post('/api/jupiter/acct/txns', gate, async (req, reply) => {
    const parsed = z
      .object({ companyCode: z.string().min(1).max(20), ...txnBase })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const b = parsed.data;

    const company = await prisma.jupiterCompany.findUnique({ where: { code: b.companyCode } });
    if (!company) return reply.code(400).send({ error: 'unknown_company', code: b.companyCode });

    const agent = req.agent!;
    const row = await prisma.jupiterTxn.create({
      data: {
        companyCode: b.companyCode,
        direction: b.direction,
        date: b.date ? new Date(b.date) : new Date(),
        party: b.party ?? '',
        category: b.category ?? '',
        amount: b.amount,
        vatAmount: b.vatAmount ?? '',
        whtAmount: b.whtAmount ?? '',
        amountNum: decOf(b.amount),
        vatNum: decOf(b.vatAmount),
        whtNum: decOf(b.whtAmount),
        note: b.note ?? '',
        source: 'manual',
        createdById: agent.id,
        createdByName: agent.name,
      },
    });
    return row;
  });

  // 5a) PATCH /txns/:id — edit the same fields (all optional; companyCode may be changed too).
  app.patch('/api/jupiter/acct/txns/:id', gate, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        companyCode: z.string().min(1).max(20).optional(),
        direction: z.enum(DIRECTIONS).optional(),
        date: z.string().datetime().optional(),
        party: z.string().max(300).optional(),
        category: z.string().max(200).optional(),
        amount: z.string().min(1).max(40).regex(MONEY, 'amount ต้องเป็นตัวเลข').optional(),
        vatAmount: z.string().max(40).regex(MONEY_OPT, 'VAT ต้องเป็นตัวเลข').optional(),
        whtAmount: z.string().max(40).regex(MONEY_OPT, 'หัก ณ ที่จ่าย ต้องเป็นตัวเลข').optional(),
        note: z.string().max(2000).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const b = parsed.data;

    const existing = await prisma.jupiterTxn.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    if (b.companyCode && b.companyCode !== existing.companyCode) {
      const company = await prisma.jupiterCompany.findUnique({ where: { code: b.companyCode } });
      if (!company) return reply.code(400).send({ error: 'unknown_company', code: b.companyCode });
    }

    const data: Record<string, unknown> = {};
    if (b.companyCode !== undefined) data.companyCode = b.companyCode;
    if (b.direction !== undefined) data.direction = b.direction;
    if (b.date !== undefined) data.date = new Date(b.date);
    if (b.party !== undefined) data.party = b.party;
    if (b.category !== undefined) data.category = b.category;
    if (b.amount !== undefined) { data.amount = b.amount; data.amountNum = decOf(b.amount); }
    if (b.vatAmount !== undefined) { data.vatAmount = b.vatAmount; data.vatNum = decOf(b.vatAmount); }
    if (b.whtAmount !== undefined) { data.whtAmount = b.whtAmount; data.whtNum = decOf(b.whtAmount); }
    if (b.note !== undefined) data.note = b.note;

    const row = await prisma.jupiterTxn.update({ where: { id }, data });
    return row;
  });

  // 5b) DELETE /txns/:id. (Manual rows only in practice; synced rows are reconciled by /sync.)
  app.delete('/api/jupiter/acct/txns/:id', gate, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.jupiterTxn.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await prisma.jupiterTxn.delete({ where: { id } });
    return { ok: true };
  });

  // 8) POST /sync/juno — batch pull: mirror every 'recorded' Juno payment into JupiterTxn as
  //    PROM income (idempotent by source+sourceRef; also removes synced rows whose payment was
  //    voided/undone since). This is the "batch import" half of the deity feed; the live per-slip
  //    half is a fire-and-forget hook in juno.ts. Supervisor-only.
  app.post('/api/jupiter/acct/sync/juno', gate, async () => {
    const res = await syncAllJunoToJupiter();
    return { ok: true, ...res };
  });

  // 6) GET /registers?month= — per-company tax-register rollup for the close pack.
  //    sales/purchases = Σ amount (income/expense); output/input VAT = Σ vatAmount; wht = Σ all
  //    whtAmount; vatNet = outputVat − inputVat.
  app.get('/api/jupiter/acct/registers', gate, async (req) => {
    const q = z.object({ month: z.string().optional() }).safeParse(req.query ?? {});
    const { start, end, ym } = monthRange(q.success ? q.data.month : undefined);

    const [companies, txns] = await Promise.all([
      prisma.jupiterCompany.findMany({
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { code: true, name: true, nameTh: true, color: true },
      }),
      prisma.jupiterTxn.findMany({
        where: { date: { gte: start, lt: end } },
        select: { companyCode: true, direction: true, amount: true, vatAmount: true, whtAmount: true },
      }),
    ]);

    type Reg = { sales: number; outputVat: number; purchases: number; inputVat: number; wht: number };
    const acc = new Map<string, Reg>();
    for (const c of companies) acc.set(c.code, { sales: 0, outputVat: 0, purchases: 0, inputVat: 0, wht: 0 });
    for (const t of txns) {
      const r = acc.get(t.companyCode);
      if (!r) continue;
      r.wht += baht(t.whtAmount);
      if (t.direction === 'income') {
        r.sales += baht(t.amount);
        r.outputVat += baht(t.vatAmount);
      } else {
        r.purchases += baht(t.amount);
        r.inputVat += baht(t.vatAmount);
      }
    }

    const rows = companies.map((c) => {
      const r = acc.get(c.code)!;
      return {
        code: c.code,
        name: c.name,
        nameTh: c.nameTh,
        color: c.color,
        sales: r.sales,
        outputVat: r.outputVat,
        purchases: r.purchases,
        inputVat: r.inputVat,
        wht: r.wht,
        vatNet: r.outputVat - r.inputVat,
      };
    });
    return { month: ym, companies: rows };
  });

  // 7) POST /parse — AI natural-language entry (best-effort, FAIL-SOFT: never throws).
  //    Turns "จ่ายค่าเช่าออฟฟิศ 30,000 TONR" into a proposed txn. Returns {ok:true, proposed,
  //    via:'ai'|'heuristic'} or {ok:false}. Uses the shared Anthropic client (callClaude) when a
  //    key is configured; otherwise (or on any AI error) falls back to a regex/keyword heuristic.
  app.post('/api/jupiter/acct/parse', gate, async (req, reply) => {
    const parsed = z.object({ text: z.string().min(1).max(500) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const text = parsed.data.text.trim();

    // Valid company codes to constrain the parse — never invent a code outside the group.
    const companies = await prisma.jupiterCompany.findMany({
      where: { active: true },
      select: { code: true, nameTh: true, name: true },
      orderBy: [{ sortOrder: 'asc' }],
    });
    const codes = companies.map((c) => c.code);

    // --- Heuristic fallback (also the AI's safety net) ---
    const heuristic = () => {
      const upper = text.toUpperCase();
      // company: first group code appearing in the text (whole-ish token); default PROM.
      let companyCode = codes.find((c) => upper.includes(c)) ?? (codes.includes('PROM') ? 'PROM' : codes[0] ?? '');
      if (!companyCode) companyCode = 'PROM';
      // amount: first number-with-optional-commas in the text.
      const m = text.match(/([\d][\d,]*(?:\.\d+)?)/);
      const amount = m ? m[1].replace(/,/g, '') : '';
      // income if it mentions selling/receiving/rent-in and NOT paying-out.
      const isIncome = /ขาย|รับ|เก็บ|ได้รับ|เช่ารับ/.test(text) && !/จ่าย/.test(text);
      return {
        direction: isIncome ? 'income' : 'expense',
        companyCode,
        category: isIncome ? 'รายรับ' : 'รายจ่าย',
        party: '',
        amount,
        vatAmount: '',
        whtAmount: '',
        note: text,
      };
    };

    // --- AI parse (preferred) ---
    if (llmAvailable()) {
      try {
        const system =
          'คุณเป็นผู้ช่วยลงบัญชีของกลุ่มบริษัท แปลงข้อความภาษาไทยเป็นรายการบัญชีหนึ่งรายการ ' +
          'ตอบเป็น JSON เท่านั้น (ไม่มีคำอธิบายอื่น) รูปแบบ: ' +
          '{"direction":"income|expense","companyCode":"<code>","category":"<หมวดสั้นๆ>",' +
          '"party":"<คู่ค้า/ลูกค้า ถ้ามี>","amount":"<ตัวเลขสุทธิ ไม่มีคอมมา>",' +
          '"vatAmount":"<ภาษีมูลค่าเพิ่ม ถ้าระบุ ไม่งั้นว่าง>","whtAmount":"<หัก ณ ที่จ่าย ถ้าระบุ ไม่งั้นว่าง>",' +
          '"note":"<ข้อความเดิม>"}. ' +
          `companyCode ต้องเป็นหนึ่งใน: ${codes.join(', ')} (ถ้าไม่ระบุชัด ใช้ PROM). ` +
          'direction=income เมื่อเป็นการขาย/รับเงิน, expense เมื่อเป็นการจ่าย. ' +
          'amount คือยอดสุทธิที่รับ/จ่ายจริง เป็นตัวเลขล้วน ไม่มีสัญลักษณ์หรือคอมมา.';
        const raw = await callClaude(text, system, 400);
        // Extract the first JSON object even if the model wrapped it in prose/fences.
        const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
        const obj = JSON.parse(jsonStr) as Record<string, unknown>;
        const dir = obj.direction === 'income' ? 'income' : 'expense';
        let cc = String(obj.companyCode ?? '').toUpperCase();
        if (!codes.includes(cc)) cc = codes.includes('PROM') ? 'PROM' : codes[0] ?? '';
        const proposed = {
          direction: dir,
          companyCode: cc,
          category: String(obj.category ?? (dir === 'income' ? 'รายรับ' : 'รายจ่าย')),
          party: String(obj.party ?? ''),
          amount: String(obj.amount ?? '').replace(/[,\s฿]/g, ''),
          vatAmount: String(obj.vatAmount ?? '').replace(/[,\s฿]/g, ''),
          whtAmount: String(obj.whtAmount ?? '').replace(/[,\s฿]/g, ''),
          note: String(obj.note ?? text),
        };
        if (proposed.amount) return { ok: true as const, via: 'ai' as const, proposed };
        // AI gave no usable amount — fall through to heuristic.
      } catch {
        // Any AI/parse error → heuristic. Never throw.
      }
    }

    const proposed = heuristic();
    return { ok: true as const, via: 'heuristic' as const, proposed };
  });

  // 9) Party identity backfill (Punch #9) — make the run-once Party/PartyIdentity backfill
  //    runnable from the cockpit (no CLI / no DB string). Supervisor-only, like everything here.

  // 9a) POST /parties/backfill/dry — synchronous DRY-RUN: compute the full plan, write NOTHING,
  //     return the Summary. A read-only pass over ~15k rows fits comfortably in one request.
  app.post('/api/jupiter/acct/parties/backfill/dry', gate, async () => {
    return runBackfill({ apply: false });
  });

  // 9b) POST /parties/backfill/apply — kick off the real write (~15k idempotent upserts) in the
  //     BACKGROUND and return immediately; too slow for a sync response. Concurrency-guarded:
  //     a second apply while one is running returns {started:false, busy:true}. Poll /status.
  app.post('/api/jupiter/acct/parties/backfill/apply', gate, async () => {
    if (partyBackfillRunning) return { started: false, busy: true };
    partyBackfillRunning = true;
    void runBackfill({ apply: true })
      .then((s) => app.log.info({ backfill: s }, 'party backfill applied'))
      .catch((e) => app.log.error({ err: e }, 'party backfill failed'))
      .finally(() => {
        partyBackfillRunning = false;
      });
    return { started: true };
  });

  // 9c) GET /parties/status — live spine counts + whether an apply is in flight (drives the
  //     cockpit's "กำลังรวมข้อมูล…" spinner + final counts). Cheap: two COUNT(*)s.
  app.get('/api/jupiter/acct/parties/status', gate, async () => {
    const [parties, identities] = await Promise.all([
      prisma.party.count(),
      prisma.partyIdentity.count(),
    ]);
    return { parties, identities, running: partyBackfillRunning };
  });
}
