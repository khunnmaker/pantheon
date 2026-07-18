import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const role = { value: 'employee' };
  const payment = {
    findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(),
  };
  const paymentBankMatch = { findMany: vi.fn(), count: vi.fn() };
  const bankTxn = { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() };
  const reReceipt = { findMany: vi.fn() };
  const syncPaymentToJupiter = vi.fn().mockResolvedValue(undefined);
  return { role, payment, paymentBankMatch, bankTxn, reReceipt, syncPaymentToJupiter };
});

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: 'agent-1', email: 'fin@example.test', name: 'FIN', role: mocks.role.value, apps: ['juno'] };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock('../src/jupiter/sync.js', () => ({ syncPaymentToJupiter: mocks.syncPaymentToJupiter }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    payment: mocks.payment,
    paymentBankMatch: mocks.paymentBankMatch,
    bankTxn: mocks.bankTxn,
    reReceipt: mocks.reReceipt,
    $transaction: vi.fn(async (arg: unknown) => Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)({})),
  },
}));

import { junoRoutes } from '../src/routes/juno.js';

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1', customerId: null, customerCode: 'C1', customerName: 'Customer', senderName: 'Sender',
  amount: '500.00', ocrAmount: '500.00', whtRate: 0, whtAmount: '', bank: 'KBANK', transferAt: '', ref: '',
  slipMessageId: null, slipUrl: '', taxInvoice: '', taxInvoiceStatus: 'none', salesAgentId: null, salesName: '', note: '',
  status: 'received', flagged: false, reconciled: false, verifiedById: null, verifiedAt: null, createdAt: new Date('2026-07-18T00:00:00Z'),
  reNumber: '', reNumbers: [], billNos: [], receiptName: '', customerType: '', source: 'line', settleState: '', settledAt: null,
  receivedAt: null, receivedBy: null, chequeNo: '', chequeBank: '', chequeDueDate: '', discExpected: '', discResolution: '', discNote: '',
  discResolvedAt: null, discResolvedBy: '', discConfirmedAt: null, discConfirmedBy: '', wrongTransferAt: null, wrongTransferBy: '',
  ...overrides,
});

async function server() {
  const app = Fastify();
  await app.register(junoRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.value = 'employee';
  mocks.paymentBankMatch.findMany.mockResolvedValue([]);
  mocks.paymentBankMatch.count.mockResolvedValue(0);
  mocks.reReceipt.findMany.mockResolvedValue([]);
  mocks.payment.count.mockResolvedValue(0);
  mocks.payment.findMany.mockResolvedValue([]);
  mocks.payment.updateMany.mockResolvedValue({ count: 0 });
  mocks.bankTxn.update.mockResolvedValue({});
  mocks.bankTxn.updateMany.mockResolvedValue({ count: 0 });
  mocks.payment.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => basePayment(data));
});

describe('Juno wrong-transfer routes', () => {
  it('marks the payment, rejects a mixed sentinel, and resets an unresolved classification', async () => {
    const app = await server();
    mocks.payment.findUnique.mockResolvedValueOnce(basePayment());
    const marked = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: [], wrongTransfer: true } });
    expect(marked.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'verified', discExpected: '0', reNumbers: [], billNos: [] }) }));

    const mixed = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: ['0000000', '6900001'] } });
    expect(mixed.statusCode).toBe(409);
    expect(mixed.json().error).toBe('wrong_transfer_mixed');

    mocks.payment.findUnique.mockResolvedValueOnce(basePayment({ status: 'verified', wrongTransferAt: new Date(), discExpected: '0' }));
    const reset = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: [], billNos: [], wrongTransfer: false } });
    expect(reset.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'received', wrongTransferAt: null, discExpected: '' }) }));
    await app.close();
  });

  it('requires explicit undo after refund activity and demotes recorded corrections with Jupiter cleanup', async () => {
    const app = await server();
    const resolved = basePayment({ status: 'verified', wrongTransferAt: new Date(), discExpected: '0', discResolution: 'refund' });
    mocks.payment.findUnique.mockResolvedValueOnce(resolved).mockResolvedValueOnce(resolved);
    expect((await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: [], wrongTransfer: false } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: [], wrongTransfer: false, undoConfirmed: true } })).statusCode).toBe(200);

    mocks.payment.findUnique.mockResolvedValueOnce(basePayment({ status: 'recorded', wrongTransferAt: new Date(), discExpected: '0' }));
    const corrected = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: ['6900001'], wrongTransfer: false } });
    expect(corrected.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'verified', wrongTransferAt: null }) }));
    await vi.waitFor(() => expect(mocks.syncPaymentToJupiter).toHaveBeenCalledWith('payment-1'));
    await app.close();
  });

  it('keeps a normal recorded payment and its verification stamps on document edits', async () => {
    const app = await server();
    const verifiedAt = new Date('2026-07-17T03:04:05Z');
    const original = basePayment({
      status: 'recorded', verifiedById: 'original-agent', verifiedAt,
    });
    mocks.payment.findUnique.mockResolvedValueOnce(original);
    mocks.payment.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({ ...original, ...data }));

    const edited = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: ['6900002'], receiptName: 'Updated document' },
    });

    expect(edited.statusCode).toBe(200);
    const update = mocks.payment.update.mock.calls.at(-1)?.[0];
    expect(update.data).toEqual(expect.objectContaining({ status: 'recorded', reNumbers: ['6900002'] }));
    expect(update.data).not.toHaveProperty('verifiedById');
    expect(update.data).not.toHaveProperty('verifiedAt');
    expect(edited.json().payment).toEqual(expect.objectContaining({
      status: 'recorded', verifiedById: 'original-agent', verifiedAt: verifiedAt.toISOString(),
    }));
    expect(mocks.syncPaymentToJupiter).not.toHaveBeenCalled();
    await app.close();
  });

  it('blocks generic status changes for a marked row but allows void, preserving stamps across void/restore', async () => {
    const app = await server();
    const marked = basePayment({ status: 'verified', wrongTransferAt: new Date() });
    mocks.payment.findUnique.mockResolvedValue(marked);
    for (const status of ['received', 'verified', 'recorded']) {
      const response = await app.inject({
        method: 'POST', url: '/api/juno/payments/payment-1/status', payload: { status },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('wrong_transfer');
    }

    // Soft-void stays available for a marked row (plan §4): marker + stamps survive the archive.
    mocks.payment.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({ ...marked, ...data }));
    const archived = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/status', payload: { status: 'void' },
    });
    expect(archived.statusCode).toBe(200);
    const voidUpdate = mocks.payment.update.mock.calls.at(-1)?.[0];
    expect(voidUpdate.data).toEqual({ status: 'void' });

    const verifiedAt = new Date('2026-07-16T01:02:03Z');
    const voided = basePayment({
      status: 'void', wrongTransferAt: new Date(), verifiedById: 'original-agent', verifiedAt,
    });
    mocks.payment.findUnique.mockResolvedValueOnce(voided);
    mocks.payment.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({ ...voided, ...data }));
    const restored = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/status', payload: { status: 'received' },
    });
    expect(restored.statusCode).toBe(200);
    const update = mocks.payment.update.mock.calls.at(-1)?.[0];
    expect(update.data).toEqual({ status: 'verified' });
    expect(restored.json().payment).toEqual(expect.objectContaining({
      status: 'verified', verifiedById: 'original-agent', verifiedAt: verifiedAt.toISOString(),
    }));
    await app.close();
  });

  it('keeps FIN refund resolution but CEO-only confirmation', async () => {
    const app = await server();
    mocks.payment.findUnique.mockResolvedValue(basePayment({ status: 'verified', wrongTransferAt: new Date(), discResolution: 'refund' }));
    const forbidden = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } });
    expect(forbidden.statusCode).toBe(403);
    mocks.role.value = 'supervisor';
    const confirmed = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } });
    expect(confirmed.statusCode).toBe(200);
    await app.close();
  });

  it('excludes wrong transfers from summaries/reports but retains them in the list and CSV', async () => {
    const app = await server();
    mocks.role.value = 'supervisor';
    await app.inject({ method: 'GET', url: '/api/juno/summary' });
    expect(mocks.payment.count.mock.calls.every(([arg]) => arg?.where?.wrongTransferAt === null)).toBe(true);

    const wrongTransfer = basePayment({ status: 'verified', wrongTransferAt: new Date(), wrongTransferBy: 'fin' });
    mocks.payment.findMany.mockResolvedValueOnce([wrongTransfer]);
    const list = await app.inject({ method: 'GET', url: '/api/juno/payments' });
    expect(list.json().payments).toEqual([expect.objectContaining({ id: 'payment-1', wrongTransfer: true })]);

    mocks.payment.findMany.mockResolvedValueOnce([]);
    await app.inject({ method: 'GET', url: '/api/juno/reports' });
    expect(mocks.payment.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ wrongTransferAt: null }) }));

    mocks.payment.findMany.mockResolvedValueOnce([wrongTransfer]);
    const csv = await app.inject({ method: 'GET', url: '/api/juno/export.csv' });
    expect(csv.body).toContain('wrongTransfer');
    expect(csv.body).toContain('yes');
    await app.close();
  });

  it('rejects wrong-only Express confirmation and advances only regular links on a mixed line', async () => {
    const app = await server();
    mocks.bankTxn.findUnique.mockResolvedValue({ id: 'txn-1', matchStatus: 'matched' });
    mocks.paymentBankMatch.findMany.mockResolvedValueOnce([{ paymentId: 'wrong', payment: { wrongTransferAt: new Date() } }]);
    const wrongOnly = await app.inject({ method: 'POST', url: '/api/juno/bank/txns/txn-1/confirm' });
    expect(wrongOnly.statusCode).toBe(409);
    expect(wrongOnly.json().error).toBe('wrong_transfer_only');

    mocks.paymentBankMatch.findMany.mockResolvedValueOnce([
      { paymentId: 'wrong', payment: { wrongTransferAt: new Date() } },
      { paymentId: 'regular', payment: { wrongTransferAt: null } },
    ]);
    const mixed = await app.inject({ method: 'POST', url: '/api/juno/bank/txns/txn-1/confirm' });
    expect(mixed.statusCode).toBe(200);
    expect(mocks.payment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['regular'] }, wrongTransferAt: null }) }));
    await app.close();
  });
});
