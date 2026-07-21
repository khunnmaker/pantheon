import Fastify from 'fastify';
import iconv from 'iconv-lite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Task A/B (docs/JUNO_XS_AMOUNTS_PLAN.md): FIN-declared per-XS amount (confirmedAmount) + the
// XS tab. Mirrors the route-harness pattern from junoWrongTransfer.test.ts / junoBillIssuers.test.ts
// (mocked prisma + mocked auth middleware, real Fastify inject) but drives req.agent + a 401 gate
// from mutable fixtures so the same harness covers both the business logic and access control.

const mocks = vi.hoisted(() => {
  const role = { value: 'staff' };
  const email = { value: 'fin@example.test' };
  const authed = { value: true };
  const payment = {
    findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(),
  };
  const paymentBankMatch = { findMany: vi.fn(), count: vi.fn() };
  const bankTxn = { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() };
  const reReceipt = { findMany: vi.fn() };
  const manualBill = { findMany: vi.fn() };
  const xsDoc = { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() };
  const customerCreditEntry = {
    findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(),
    create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn(),
  };
  const syncPaymentToJupiter = vi.fn().mockResolvedValue(undefined);
  return {
    role, email, authed, payment, paymentBankMatch, bankTxn, reReceipt, manualBill, xsDoc,
    customerCreditEntry, syncPaymentToJupiter,
  };
});

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (
    req: { agent?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    if (!mocks.authed.value) return reply.code(401).send({ error: 'unauthorized' });
    req.agent = { id: 'agent-1', email: mocks.email.value, name: 'FIN', role: mocks.role.value, apps: ['juno'] };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock('../src/jupiter/sync.js', () => ({ syncPaymentToJupiter: mocks.syncPaymentToJupiter }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: (() => {
    const mocked = {
      payment: mocks.payment,
      paymentBankMatch: mocks.paymentBankMatch,
      bankTxn: mocks.bankTxn,
      reReceipt: mocks.reReceipt,
      manualBill: mocks.manualBill,
      xsDoc: mocks.xsDoc,
      customerCreditEntry: mocks.customerCreditEntry,
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(),
    };
    mocked.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(mocked));
    return mocked;
  })(),
}));

import { junoRoutes } from '../src/routes/juno.js';

async function server() {
  const app = Fastify();
  await app.register(junoRoutes);
  await app.ready();
  return app;
}

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1', customerId: null, customerCode: 'C1', customerName: 'Customer', senderName: 'Sender',
  amount: '500.00', ocrAmount: '500.00', whtRate: 0, whtAmount: '', creditUsed: '', bank: 'KBANK', transferAt: '', ref: '',
  slipMessageId: null, slipUrl: '', taxInvoice: '', taxInvoiceStatus: 'none', salesAgentId: null, salesName: '', note: '',
  status: 'received', flagged: false, reconciled: true, verifiedById: null, verifiedAt: null, createdAt: new Date('2026-07-21T00:00:00Z'),
  reNumber: '', reNumbers: [], billNos: [], receiptName: '', customerType: '', source: 'line', settleState: '', settledAt: null,
  receivedAt: null, receivedBy: null, chequeNo: '', chequeBank: '', chequeDueDate: '', discExpected: '', discResolution: '', discNote: '',
  discResolvedAt: null, discResolvedBy: '', discConfirmedAt: null, discConfirmedBy: '', wrongTransferAt: null, wrongTransferBy: '',
  bankMatches: [],
  ...overrides,
});

const baseXsDoc = (overrides: Record<string, unknown> = {}) => ({
  id: 'xsdoc-1', xsNo: 'XS6900342', docDate: '15/07/69', note: 'R022', amount: '', paymentConfirmedAt: null,
  paymentConfirmedBy: '', closeNote: '', confirmedAmount: '', confirmedAmountAt: null, confirmedAmountBy: '',
  importedAt: new Date('2026-07-19T00:00:00Z'), createdAt: new Date('2026-07-19T00:00:00Z'), updatedAt: new Date('2026-07-19T00:00:00Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.value = 'staff';
  mocks.email.value = 'fin@example.test';
  mocks.authed.value = true;
  mocks.paymentBankMatch.findMany.mockResolvedValue([]);
  mocks.paymentBankMatch.count.mockResolvedValue(0);
  mocks.reReceipt.findMany.mockResolvedValue([]);
  mocks.manualBill.findMany.mockResolvedValue([]);
  mocks.xsDoc.findMany.mockResolvedValue([]);
  mocks.xsDoc.findUnique.mockResolvedValue(null);
  mocks.xsDoc.upsert.mockImplementation(async ({ where, create, update }: { where: { xsNo: string }; create: Record<string, unknown>; update: Record<string, unknown> }) =>
    baseXsDoc({ xsNo: where.xsNo, ...create, ...update }));
  mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
  mocks.customerCreditEntry.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.count.mockResolvedValue(0);
  mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: null } });
  mocks.payment.count.mockResolvedValue(0);
  mocks.payment.findMany.mockResolvedValue([]);
  mocks.payment.updateMany.mockResolvedValue({ count: 0 });
  // Persistent default (NOT mockResolvedValueOnce): several tests below 400 before the route ever
  // reaches tx.payment.findUnique (the xs_amount_* pre-transaction checks) — a queued "once" value
  // left unconsumed by one test would otherwise leak into and desync a LATER test's queue.
  mocks.payment.findUnique.mockResolvedValue(basePayment());
  mocks.bankTxn.update.mockResolvedValue({});
  mocks.bankTxn.updateMany.mockResolvedValue({ count: 0 });
  mocks.payment.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => basePayment(data));
});

describe('POST /verify — XS amount gating (task A)', () => {
  it('requires an amount for a new XS chip with nothing on file', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce([]); // not on file
    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'xs_amount_required', xsNo: 'XS6900342' });
    expect(mocks.xsDoc.upsert).not.toHaveBeenCalled();
    expect(mocks.payment.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a request-provided amount, upserts a stub XsDoc, and stamps the actor', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'], xsAmounts: { XS6900342: '450.00' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.xsDoc.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { xsNo: 'XS6900342' },
      create: expect.objectContaining({
        xsNo: 'XS6900342', docDate: '', note: '', amount: '',
        confirmedAmount: '450.00', confirmedAmountBy: 'fin@example.test',
      }),
      update: expect.objectContaining({ confirmedAmount: '450.00', confirmedAmountBy: 'fin@example.test' }),
    }));
    const call = mocks.xsDoc.upsert.mock.calls[0][0];
    expect(call.create.confirmedAmountAt).toBeInstanceOf(Date);
    expect(mocks.payment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ billNos: ['XS6900342'] }),
    }));
    await app.close();
  });

  it('preserves an already-stored confirmedAmount when xsAmounts omits the chip (no upsert call)', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce([{ xsNo: 'XS6900342', confirmedAmount: '450.00' }]);
    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'] },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.xsDoc.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it('re-saving the same value is idempotent (still calls upsert, still 200)', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'], xsAmounts: { XS6900342: '450.00' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.xsDoc.upsert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each(['0', '0.00', '-5', 'abc'])('rejects an invalid xsAmounts entry (%s)', async (bad) => {
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'], xsAmounts: { XS6900342: bad } },
    });
    // 'abc' fails the zod moneyStringSchema shape entirely (400 invalid_body); numeric
    // non-positive values pass the shape but fail the route's own > 0 check.
    expect(res.statusCode).toBe(400);
    if (res.json().error !== 'invalid_body') {
      expect(res.json()).toMatchObject({ error: 'xs_amount_invalid', xsNo: 'XS6900342' });
    }
    await app.close();
  });

  it('rejects an xsAmounts key not among this request’s XS chips', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'], xsAmounts: { XS6900999: '100.00' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'xs_amount_unknown', xsNo: 'XS6900999' });
    await app.close();
  });

  it('never touches paymentConfirmedAt/closeNote (a separate, CEO-only concern)', async () => {
    const app = await server();
    await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'], xsAmounts: { XS6900342: '450.00' } },
    });
    const call = mocks.xsDoc.upsert.mock.calls[0][0];
    expect(call.create).not.toHaveProperty('paymentConfirmedAt');
    expect(call.update).not.toHaveProperty('paymentConfirmedAt');
    expect(call.update).not.toHaveProperty('closeNote');
    await app.close();
  });

  it('keepRecorded invariant stays intact: an XS amount edit on a recorded payment keeps status recorded', async () => {
    const app = await server();
    const verifiedAt = new Date('2026-07-17T03:04:05Z');
    const recorded = basePayment({
      status: 'recorded', verifiedById: 'original-agent', verifiedAt, billNos: ['XS6900342'],
    });
    mocks.payment.findUnique.mockResolvedValueOnce(recorded);
    mocks.payment.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({ ...recorded, ...data }));
    mocks.xsDoc.findMany.mockResolvedValueOnce([{ xsNo: 'XS6900342', confirmedAmount: '450.00' }]); // already on file

    const res = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['XS6900342'], receiptName: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    const update = mocks.payment.update.mock.calls.at(-1)?.[0];
    expect(update.data).toEqual(expect.objectContaining({ status: 'recorded' }));
    expect(update.data).not.toHaveProperty('verifiedById');
    expect(update.data).not.toHaveProperty('verifiedAt');
    expect(mocks.syncPaymentToJupiter).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /api/juno/xs/import — UPDATE branch never touches confirmedAmount/At/By', () => {
  const ESC = '\x1b';
  const FIXTURE = [
    'บริษัท พรอมมิเน้นท์ จำกัด                                หน้า   :        1',
    `${ESC}Wxรายงานจ่ายสินค้าภายใน${ESC}Wx `,
    'วันที่จาก  1 ม.ค. 2569     ถึง 19 ก.ค. 2569              วันที่ : 19/07/69',
    'เลขที่จาก  XS0000000       ถึง XS99999999      เลือกแผนก  *',
    '----------------------------------------------------------------------',
    'ลำดับ  รหัสสินค้า           รายละเอียด        คลังที่    จำนวน          ราคาต่อหน่วย      มูลค่ารวม',
    '----------------------------------------------------------------------',
    `${ESC}EXS6900342${ESC}F    15/07/69 ${ESC}E${ESC}F       R022`,
    '   1   07-01-03  GELMAX                       02           5.00 ถุง           90.00        450.00',
    `                                              รวม        ${ESC}E       450.00${ESC}F`,
    '                                                          --------------',
    `                     เอกสาร      1 ใบ     รวมทั้งสิ้น   ${ESC}E      450.00${ESC}F`,
    '                                                          ==============',
    '>>>>  จบรายงาน  <<<<',
    '',
  ].join('\r\n');

  it('re-import (UPDATE) refreshes docDate/note/amount only', async () => {
    const app = await server();
    const dataB64 = iconv.encode(FIXTURE, 'win874').toString('base64');
    const res = await app.inject({
      method: 'POST', url: '/api/juno/xs/import', payload: { dataB64, fileName: 'STTRNR6.TXT' },
    });
    expect(res.statusCode).toBe(200);
    const call = mocks.xsDoc.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ xsNo: 'XS6900342' });
    expect(call.update).toEqual({ docDate: '15/07/69', note: 'R022', amount: '450.00', importedAt: expect.any(Date) });
    expect(call.create).toEqual({ xsNo: 'XS6900342', docDate: '15/07/69', note: 'R022', amount: '450.00' });
    for (const key of ['confirmedAmount', 'confirmedAmountAt', 'confirmedAmountBy']) {
      expect(call.update).not.toHaveProperty(key);
      expect(call.create).not.toHaveProperty(key);
    }
    await app.close();
  });
});

describe('GET /api/juno/re — XS pricing uses confirmedAmount ONLY (no raw fallback, owner 2026-07-21)', () => {
  it('prices by confirmedAmount when declared, shows an unconfirmed doc at 0, and surfaces a zero-imported-but-confirmed doc', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce([
      // override: raw 100, FIN declared 250 — priced at 250; importedAmount shown (differs)
      baseXsDoc({ id: 'x1', xsNo: 'XS6900341', amount: '100.00', confirmedAmount: '250.00' }),
      // unconfirmed: raw 300 is meaningless — row still listed (raw > 0 = real sale) but priced
      // at 0, with the raw surfaced only as the importedAmount hint.
      baseXsDoc({ id: 'x2', xsNo: 'XS6900342', amount: '300.00', confirmedAmount: '' }),
      // zero-imported-but-confirmed: raw amount 0 would have been filtered out pre-task-A; now
      // appears because the confirmedAmount is > 0.
      baseXsDoc({ id: 'x3', xsNo: 'XS6900343', amount: '0.00', confirmedAmount: '150.00' }),
    ]);
    mocks.payment.findMany.mockResolvedValueOnce([
      {
        id: 'p1', reNumbers: [], billNos: ['XS6900341'], amount: '250.00', whtAmount: '', creditUsed: '',
        discExpected: '', customerName: 'Cust A', status: 'verified',
      },
      {
        id: 'p3', reNumbers: [], billNos: ['XS6900343'], amount: '150.00', whtAmount: '', creditUsed: '',
        discExpected: '', customerName: 'Cust C', status: 'verified',
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/juno/re?type=xs' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.reNumber).sort()).toEqual(['XS6900341', 'XS6900342', 'XS6900343']);

    const byNo = new Map(rows.map((r) => [r.reNumber, r]));
    expect(byNo.get('XS6900341')).toMatchObject({ amount: 250, status: 'matched', importedAmount: 100 });
    expect(byNo.get('XS6900342')).toMatchObject({ amount: 0, status: 'unpaid', importedAmount: 300 });
    expect(byNo.get('XS6900343')).toMatchObject({ amount: 150, status: 'matched', importedAmount: 0 });
    await app.close();
  });
});

describe('GET /api/juno/xs/lookup', () => {
  it('returns imported/confirmedAmount for known docs and imported:false for unimported ones', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce([
      { xsNo: 'XS6900342', amount: '450.00', confirmedAmount: '' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs/lookup?nums=XS6900342,XS6900999' });
    expect(res.statusCode).toBe(200);
    expect(res.json().docs).toEqual([
      { xsNo: 'XS6900342', imported: true, amount: '450.00', confirmedAmount: '' },
      { xsNo: 'XS6900999', imported: false, amount: '', confirmedAmount: '' },
    ]);
    await app.close();
  });
});

describe('GET /api/juno/xs — the XS tab', () => {
  const docs = () => [
    baseXsDoc({ id: 'd-closed', xsNo: 'XS6900340', paymentConfirmedAt: new Date('2026-07-20T00:00:00Z'), paymentConfirmedBy: 'ceo@x' }),
    baseXsDoc({ id: 'd-recorded', xsNo: 'XS6900341', note: 'recorded via payment' }),
    baseXsDoc({ id: 'd-paid', xsNo: 'XS6900342', note: 'paid, not recorded', amount: '300.00', confirmedAmount: '450.00' }),
    baseXsDoc({ id: 'd-unpaid', xsNo: 'XS6900343', note: 'nothing yet', amount: '300.00' }),
  ];
  const candidatePayments = () => [
    { billNos: ['XS6900341'], status: 'recorded' },
    { billNos: ['XS6900342'], status: 'verified' },
  ];

  it('closed > paid > unpaid precedence, and counts.unpaid over the full q-less set', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce(docs());
    mocks.payment.findMany.mockResolvedValueOnce(candidatePayments());
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byNo = new Map(body.docs.map((d: { xsNo: string }) => [d.xsNo, d]));
    expect(byNo.get('XS6900340')).toMatchObject({ status: 'closed', closed: true });
    expect(byNo.get('XS6900341')).toMatchObject({ status: 'closed', closed: true, paid: true }); // recorded payment wins over 'paid'
    expect(byNo.get('XS6900342')).toMatchObject({ status: 'paid', paid: true, closed: false, effectiveAmount: '450.00' });
    // no confirmedAmount → effectiveAmount '0', NEVER the raw imported figure (owner 2026-07-21)
    expect(byNo.get('XS6900343')).toMatchObject({ status: 'unpaid', paid: false, closed: false, effectiveAmount: '0' });
    expect(body.counts).toEqual({ unpaid: 1 });
    await app.close();
  });

  it('counts.unpaid ignores the q filter (matches the badge, not the visible rows)', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce(docs());
    mocks.payment.findMany.mockResolvedValueOnce(candidatePayments());
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs?q=XS6900340' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.docs).toHaveLength(1);
    expect(body.counts).toEqual({ unpaid: 1 });
    await app.close();
  });

  it('q searches xsNo and note', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce(docs());
    mocks.payment.findMany.mockResolvedValueOnce(candidatePayments());
    // 'via payment' is unique to d-recorded's note ('recorded via payment') — d-paid's note
    // ('paid, not recorded') deliberately also contains the substring "recorded" so a naive query
    // would false-match both; this pins that the search is a plain substring test, nothing fancier.
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs?q=via+payment' });
    expect(res.statusCode).toBe(200);
    expect(res.json().docs.map((d: { xsNo: string }) => d.xsNo)).toEqual(['XS6900341']);
    await app.close();
  });

  it('status filter narrows to the requested bucket', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce(docs());
    mocks.payment.findMany.mockResolvedValueOnce(candidatePayments());
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs?status=unpaid' });
    expect(res.statusCode).toBe(200);
    expect(res.json().docs.map((d: { xsNo: string }) => d.xsNo)).toEqual(['XS6900343']);
    await app.close();
  });

  it('queries only the sales-era set (xsNo >= XS_SALES_FROM)', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs' });
    expect(res.statusCode).toBe(200);
    expect(mocks.xsDoc.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { xsNo: { gte: 'XS6900340' } },
    }));
    await app.close();
  });

  it('FIN (staff) is allowed', async () => {
    const app = await server();
    mocks.xsDoc.findMany.mockResolvedValueOnce([]);
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('the bills-only lane (gm) is denied — not in GM_JUNO_ALLOWED_ROUTES', async () => {
    const app = await server();
    mocks.role.value = 'gm';
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('the bills-only lane (Mail, per-person BILL_ISSUER_EMAILS) is denied', async () => {
    const app = await server();
    mocks.role.value = 'central';
    mocks.email.value = 'mail@prominent.local';
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('an unauthenticated request is 401', async () => {
    const app = await server();
    mocks.authed.value = false;
    const res = await app.inject({ method: 'GET', url: '/api/juno/xs' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /api/juno/xs/:xsNo/amount', () => {
  it('happy path sets confirmedAmount/At/By on an existing doc', async () => {
    const app = await server();
    mocks.xsDoc.findUnique.mockResolvedValueOnce({ id: 'xsdoc-1' });
    const res = await app.inject({
      method: 'POST', url: '/api/juno/xs/XS6900342/amount', payload: { amount: '450.00' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.xsDoc.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { xsNo: 'XS6900342' },
      update: expect.objectContaining({ confirmedAmount: '450.00', confirmedAmountBy: 'fin@example.test' }),
    }));
    expect(res.json().doc).toMatchObject({ xsNo: 'XS6900342', confirmedAmount: '450.00', confirmedAmountBy: 'fin@example.test' });
    await app.close();
  });

  it('404s an xsNo Express has never imported', async () => {
    const app = await server();
    mocks.xsDoc.findUnique.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'POST', url: '/api/juno/xs/XS6900999/amount', payload: { amount: '100.00' },
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.xsDoc.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['0', '-1', 'not-a-number'])('rejects an invalid amount (%s)', async (bad) => {
    const app = await server();
    mocks.xsDoc.findUnique.mockResolvedValueOnce({ id: 'xsdoc-1' });
    const res = await app.inject({
      method: 'POST', url: '/api/juno/xs/XS6900342/amount', payload: { amount: bad },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('the bills-only lane (gm) is denied', async () => {
    const app = await server();
    mocks.role.value = 'gm';
    const res = await app.inject({
      method: 'POST', url: '/api/juno/xs/XS6900342/amount', payload: { amount: '100.00' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('an unauthenticated request is 401', async () => {
    const app = await server();
    mocks.authed.value = false;
    const res = await app.inject({
      method: 'POST', url: '/api/juno/xs/XS6900342/amount', payload: { amount: '100.00' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
