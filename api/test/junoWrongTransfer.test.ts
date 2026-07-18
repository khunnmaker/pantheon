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
  const manualBill = { findMany: vi.fn() };
  const customerCreditEntry = {
    findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(),
    create: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn(),
  };
  const syncPaymentToJupiter = vi.fn().mockResolvedValue(undefined);
  return { role, payment, paymentBankMatch, bankTxn, reReceipt, manualBill, customerCreditEntry, syncPaymentToJupiter };
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
  prisma: (() => {
    const mocked = {
    payment: mocks.payment,
    paymentBankMatch: mocks.paymentBankMatch,
    bankTxn: mocks.bankTxn,
    reReceipt: mocks.reReceipt,
    manualBill: mocks.manualBill,
    customerCreditEntry: mocks.customerCreditEntry,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    };
    mocked.$transaction.mockImplementation(async (arg: unknown) => Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(mocked));
    return mocked;
  })(),
}));

import { junoRoutes } from '../src/routes/juno.js';

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1', customerId: null, customerCode: 'C1', customerName: 'Customer', senderName: 'Sender',
  amount: '500.00', ocrAmount: '500.00', whtRate: 0, whtAmount: '', creditUsed: '', bank: 'KBANK', transferAt: '', ref: '',
  slipMessageId: null, slipUrl: '', taxInvoice: '', taxInvoiceStatus: 'none', salesAgentId: null, salesName: '', note: '',
  status: 'received', flagged: false, reconciled: true, verifiedById: null, verifiedAt: null, createdAt: new Date('2026-07-18T00:00:00Z'),
  reNumber: '', reNumbers: [], billNos: [], receiptName: '', customerType: '', source: 'line', settleState: '', settledAt: null,
  receivedAt: null, receivedBy: null, chequeNo: '', chequeBank: '', chequeDueDate: '', discExpected: '', discResolution: '', discNote: '',
  discResolvedAt: null, discResolvedBy: '', discConfirmedAt: null, discConfirmedBy: '', wrongTransferAt: null, wrongTransferBy: '',
  bankMatches: [],
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
  mocks.manualBill.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
  mocks.customerCreditEntry.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.count.mockResolvedValue(0);
  mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: null } });
  mocks.customerCreditEntry.create.mockImplementation(async ({ data }: any) => ({
    id: 'grant-1', createdAt: new Date(), updatedAt: new Date(), ...data,
  }));
  mocks.payment.count.mockResolvedValue(0);
  mocks.payment.findMany.mockResolvedValue([]);
  mocks.payment.updateMany.mockResolvedValue({ count: 0 });
  mocks.bankTxn.update.mockResolvedValue({});
  mocks.bankTxn.updateMany.mockResolvedValue({ count: 0 });
  mocks.payment.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => basePayment(data));
});

describe('Juno manual-bill payment status', () => {
  it('marks a bill paid when a non-void payment links it even if the gross amount differs', async () => {
    const app = await server();
    mocks.manualBill.findMany.mockResolvedValue([{
      id: 'bill-1', billNo: '9690001', status: 'active', amount: '100.00', customerCode: '', buyerName: 'Buyer',
      items: [], createdAt: new Date('2026-07-18T00:00:00Z'), updatedAt: new Date('2026-07-18T00:00:00Z'),
      voidedAt: null,
    }]);
    mocks.payment.findMany.mockResolvedValue([{
      id: 'payment-1', billNos: ['9690001'], amount: '250.00', whtAmount: '10.00', status: 'verified',
      source: 'line', createdAt: new Date('2026-07-18T01:00:00Z'), customerName: 'Buyer',
    }]);

    const response = await app.inject({ method: 'GET', url: '/api/juno/bills' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.bills).toMatchObject([
      { billStatus: 'paid', linkedPayments: [{ amount: '250.00', whtAmount: '10.00' }] },
    ]);
    expect(body.counts).toEqual({ unpaid: 0 });
    await app.close();
  });
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
    expect(mocks.customerCreditEntry.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts refund/credit/reset resolution but still rejects chase and writeoff', async () => {
    const app = await server();
    const wrong = basePayment({ status: 'verified', wrongTransferAt: new Date(), discExpected: '0' });
    mocks.payment.findUnique.mockResolvedValue(wrong);

    for (const resolution of ['credit', 'refund', ''] as const) {
      const response = await app.inject({
        method: 'POST', url: '/api/juno/payments/payment-1/disc-resolve', payload: { resolution },
      });
      expect(response.statusCode).toBe(200);
      expect(mocks.payment.update).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ discResolution: resolution }),
      }));
    }

    for (const resolution of ['chase', 'writeoff'] as const) {
      const response = await app.inject({
        method: 'POST', url: '/api/juno/payments/payment-1/disc-resolve', payload: { resolution },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('wrong_transfer_refund_only');
    }

    const expectedEdit = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/discrepancy', payload: { expected: '1.00' },
    });
    expect(expectedEdit.statusCode).toBe(409);
    expect(expectedEdit.json().error).toBe('wrong_transfer_expected_locked');
    await app.close();
  });

  it('grants the full wrong-transfer payment as credit, requires a customer, and blocks spent-grant un-confirm', async () => {
    const app = await server();
    mocks.role.value = 'supervisor';
    const wrong = basePayment({
      status: 'verified', wrongTransferAt: new Date(), discExpected: '0', discResolution: 'credit',
      amount: '500.00', whtRate: 0, whtAmount: '', creditUsed: '',
    });
    mocks.payment.findUnique.mockResolvedValue(wrong);
    mocks.payment.findMany.mockResolvedValue([wrong]);
    const confirmed = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(mocks.customerCreditEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ paymentId: 'payment-1', kind: 'grant', amountSatang: 50_000 }),
    }));
    expect(mocks.syncPaymentToJupiter).not.toHaveBeenCalled();

    const keyless = { ...wrong, customerCode: '', customerName: '' };
    mocks.payment.findUnique.mockResolvedValue(keyless);
    mocks.payment.findMany.mockResolvedValue([keyless]);
    mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
    const missingCustomer = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true },
    });
    expect(missingCustomer.statusCode).toBe(409);
    expect(missingCustomer.json().error).toBe('credit_customer_required');

    mocks.payment.findUnique.mockResolvedValue({ ...wrong, discConfirmedAt: new Date(), discConfirmedBy: 'boss' });
    mocks.customerCreditEntry.findUnique.mockResolvedValue({
      id: 'grant-1', customerKey: 'C1', customerCode: 'C1', customerName: 'Customer',
      kind: 'grant', amountSatang: 50_000, paymentId: 'payment-1', createdBy: 'boss',
      createdAt: new Date(), updatedAt: new Date(),
    });
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 40_000 } });
    const unconfirmed = await app.inject({
      method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: false },
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().error).toBe('credit_grant_spent');
    await app.close();
  });

  it('excludes wrong transfers from summaries/reports but retains them in the list and CSV', async () => {
    const app = await server();
    mocks.role.value = 'supervisor';
    await app.inject({ method: 'GET', url: '/api/juno/summary' });
    expect(mocks.payment.count.mock.calls.every(([arg]) => arg?.where?.wrongTransferAt === null)).toBe(true);

    const wrongTransfer = basePayment({
      status: 'verified', wrongTransferAt: new Date(), wrongTransferBy: 'fin', discExpected: '0',
      discResolution: 'credit', discResolvedAt: new Date(), discConfirmedAt: new Date(),
    });
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
