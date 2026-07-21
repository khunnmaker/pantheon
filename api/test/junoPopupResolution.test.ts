import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { payment: null as any };
  const payment = {
    findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(),
  };
  const customerCreditEntry = {
    findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(),
    create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn(),
  };
  const paymentBankMatch = { findMany: vi.fn(), count: vi.fn() };
  const bankTxn = { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() };
  const reReceipt = { findMany: vi.fn() };
  return { state, payment, customerCreditEntry, paymentBankMatch, bankTxn, reReceipt };
});

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: 'agent-1', email: 'fin@example.test', name: 'FIN', role: 'staff', apps: ['juno'] };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock('../src/jupiter/sync.js', () => ({ syncPaymentToJupiter: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: (() => {
    const db = {
      payment: mocks.payment,
      customerCreditEntry: mocks.customerCreditEntry,
      paymentBankMatch: mocks.paymentBankMatch,
      bankTxn: mocks.bankTxn,
      reReceipt: mocks.reReceipt,
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation(async (arg: unknown) => (
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(db)
    ));
    return db;
  })(),
}));

import { junoRoutes } from '../src/routes/juno.js';

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1', customerId: null, customerCode: 'C1', customerName: 'Customer', senderName: 'Sender',
  amount: '200.00', ocrAmount: '200.00', whtRate: 0, whtAmount: '', creditUsed: '', bank: 'KBANK', transferAt: '', ref: '',
  slipMessageId: null, slipUrl: '', taxInvoice: '', taxInvoiceStatus: 'none', salesAgentId: null, salesName: '', note: '',
  status: 'verified', flagged: false, reconciled: true, verifiedById: 'agent-1', verifiedAt: new Date(), createdAt: new Date('2026-07-18T00:00:00Z'),
  reNumber: '6900001', reNumbers: ['6900001'], billNos: [], receiptName: 'Customer', customerType: '', source: 'line', settleState: '', settledAt: null,
  receivedAt: null, receivedBy: null, chequeNo: '', chequeBank: '', chequeDueDate: '', discExpected: '100.00', discResolution: 'credit', discNote: 'keep',
  discResolvedAt: new Date('2026-07-18T01:00:00Z'), discResolvedBy: 'old-fin', discConfirmedAt: null, discConfirmedBy: '', wrongTransferAt: null, wrongTransferBy: '',
  bankMatches: [],
  ...overrides,
});

const grant = () => ({
  id: 'grant-1', customerKey: 'C1', customerCode: 'C1', customerName: 'Customer', kind: 'grant',
  amountSatang: 10_000, paymentId: 'payment-1', createdBy: 'boss', createdAt: new Date(), updatedAt: new Date(),
});

async function server() {
  const app = Fastify();
  await app.register(junoRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.payment = basePayment();
  mocks.payment.findUnique.mockImplementation(async () => mocks.state.payment);
  mocks.payment.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.state.payment = { ...mocks.state.payment, ...data };
    return mocks.state.payment;
  });
  mocks.payment.findMany.mockResolvedValue([]);
  mocks.payment.count.mockResolvedValue(0);
  mocks.payment.updateMany.mockResolvedValue({ count: 0 });
  mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
  mocks.customerCreditEntry.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.count.mockResolvedValue(0);
  mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: null } });
  mocks.customerCreditEntry.delete.mockResolvedValue({});
  mocks.paymentBankMatch.findMany.mockResolvedValue([]);
  mocks.paymentBankMatch.count.mockResolvedValue(0);
  mocks.bankTxn.update.mockResolvedValue({});
  mocks.bankTxn.updateMany.mockResolvedValue({ count: 0 });
  mocks.reReceipt.findMany.mockResolvedValue([]);
});

describe('Juno ตรวจแล้ว popup resolution', () => {
  it('records changed intent atomically, stamps FIN, and clears CEO confirmation', async () => {
    const app = await server();
    mocks.state.payment = basePayment({
      discResolution: 'refund', discConfirmedAt: new Date('2026-07-18T02:00:00Z'), discConfirmedBy: 'boss',
    });

    const response = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: ['6900001'], discResolution: 'credit' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.state.payment).toEqual(expect.objectContaining({
      discResolution: 'credit', discResolvedBy: 'fin@example.test', discConfirmedAt: null, discConfirmedBy: '',
    }));
    expect(mocks.state.payment.discResolvedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it('preserves CEO confirmation and resolution audit when verify receives the same intent', async () => {
    const app = await server();
    const confirmedAt = new Date('2026-07-18T02:00:00Z');
    const resolvedAt = new Date('2026-07-18T01:00:00Z');
    mocks.state.payment = basePayment({ discConfirmedAt: confirmedAt, discConfirmedBy: 'boss', discResolvedAt: resolvedAt });

    const response = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: ['6900001'], discResolution: 'credit' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenCalledTimes(1);
    expect(mocks.state.payment).toEqual(expect.objectContaining({
      discResolution: 'credit', discResolvedAt: resolvedAt, discResolvedBy: 'old-fin',
      discConfirmedAt: confirmedAt, discConfirmedBy: 'boss',
    }));
    await app.close();
  });

  it('preserves CEO confirmation when an existing wrong-transfer check is re-saved unchanged', async () => {
    const app = await server();
    const confirmedAt = new Date('2026-07-18T02:00:00Z');
    const resolvedAt = new Date('2026-07-18T01:00:00Z');
    const wrongTransferAt = new Date('2026-07-18T00:30:00Z');
    mocks.state.payment = basePayment({
      reNumber: '', reNumbers: [], discExpected: '0', wrongTransferAt, wrongTransferBy: 'fin',
      discConfirmedAt: confirmedAt, discConfirmedBy: 'boss', discResolvedAt: resolvedAt,
    });

    const response = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: ['0'], discResolution: 'credit' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenCalledTimes(1);
    expect(mocks.state.payment).toEqual(expect.objectContaining({
      discResolution: 'credit', discResolvedAt: resolvedAt, discResolvedBy: 'old-fin',
      discConfirmedAt: confirmedAt, discConfirmedBy: 'boss',
    }));
    await app.close();
  });

  it.each(['chase', 'writeoff'] as const)('rejects %s on a freshly marked wrong transfer', async (resolution) => {
    const app = await server();
    mocks.state.payment = basePayment({ status: 'received', reNumber: '', reNumbers: [], discExpected: '', discResolution: '' });

    const response = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: ['0'], discResolution: resolution },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('wrong_transfer_refund_only');
    await app.close();
  });

  it('surfaces the spent-grant lock when verify changes the resolution', async () => {
    const app = await server();
    mocks.customerCreditEntry.findUnique.mockImplementation(async ({ where }: any) => (
      where.paymentId_kind?.kind === 'grant' ? grant() : null
    ));
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 2_000 } });

    const response = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: ['6900001'], discResolution: 'refund' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(expect.objectContaining({
      error: 'credit_grant_spent',
      message: 'เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงเปลี่ยนวิธีจัดการไม่ได้',
    }));
    await app.close();
  });
});

describe('GET /api/juno/re-expected', () => {
  it('sums an all-imported, unshared RE set', async () => {
    const app = await server();
    mocks.reReceipt.findMany.mockResolvedValue([
      { reNumber: '6900001', amount: '100.25' },
      { reNumber: '6900002', amount: '200.75' },
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/juno/re-expected?nums=RE6900001,6900002' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cores: [
        { core: '6900001', amount: '100.25', shared: false },
        { core: '6900002', amount: '200.75', shared: false },
      ],
      derived: '301.00',
    });
    await app.close();
  });

  it('returns null when one RE has not been imported', async () => {
    const app = await server();
    mocks.reReceipt.findMany.mockResolvedValue([{ reNumber: '6900001', amount: '100.00' }]);

    const response = await app.inject({ method: 'GET', url: '/api/juno/re-expected?nums=6900001,6900002' });

    expect(response.json().derived).toBeNull();
    expect(response.json().cores[1]).toEqual({ core: '6900002', amount: null, shared: false });
    await app.close();
  });

  it('returns null when another non-void payment carries an RE', async () => {
    const app = await server();
    mocks.reReceipt.findMany.mockResolvedValue([{ reNumber: '6900001', amount: '100.00' }]);
    mocks.payment.findMany.mockResolvedValue([{ id: 'payment-2', reNumbers: ['6900001'] }]);

    const response = await app.inject({ method: 'GET', url: '/api/juno/re-expected?nums=6900001' });

    expect(response.json()).toEqual({
      cores: [{ core: '6900001', amount: '100.00', shared: true }], derived: null,
    });
    await app.close();
  });

  it('excludes the edited payment itself from the sharing check', async () => {
    const app = await server();
    mocks.reReceipt.findMany.mockResolvedValue([{ reNumber: '6900001', amount: '100.00' }]);
    mocks.payment.findMany.mockImplementation(async ({ where }: any) => (
      where.id?.not === 'payment-1' ? [] : [{ id: 'payment-1', reNumbers: ['6900001'] }]
    ));

    const response = await app.inject({
      method: 'GET', url: '/api/juno/re-expected?nums=6900001&exclude=payment-1',
    });

    expect(response.json().derived).toBe('100.00');
    expect(mocks.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { not: 'payment-1' } }),
    }));
    await app.close();
  });

  it.each(['MB9690001', 'XS000001'])('does not derive a mixed RE + %s document total', async (document) => {
    const app = await server();
    mocks.reReceipt.findMany.mockResolvedValue([{ reNumber: '6900001', amount: '100.00' }]);

    const response = await app.inject({
      method: 'GET', url: `/api/juno/re-expected?nums=${encodeURIComponent(`6900001,${document}`)}`,
    });

    expect(response.json().derived).toBeNull();
    await app.close();
  });
});
