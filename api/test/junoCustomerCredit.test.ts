import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const role = { value: 'employee' };
  const payment = { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn(), updateMany: vi.fn() };
  const customerCreditEntry = {
    findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn(),
    create: vi.fn(), upsert: vi.fn(), delete: vi.fn(),
  };
  const paymentBankMatch = { findMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() };
  const bankTxn = { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() };
  const reReceipt = { findMany: vi.fn() };
  const transaction = vi.fn();
  return { role, payment, customerCreditEntry, paymentBankMatch, bankTxn, reReceipt, transaction };
});

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: 'agent-1', email: 'fin@example.test', name: 'FIN', role: mocks.role.value, apps: ['juno'] };
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
      $transaction: mocks.transaction,
    };
    mocks.transaction.mockImplementation(async (arg: unknown) => Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(db));
    return db;
  })(),
}));

import { junoRoutes } from '../src/routes/juno.js';

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1', customerId: null, customerCode: 'C1', customerName: 'Customer', senderName: 'Sender',
  amount: '200.00', ocrAmount: '200.00', whtRate: 0, whtAmount: '', creditUsed: '', bank: 'KBANK', transferAt: '', ref: '',
  slipMessageId: null, slipUrl: '', taxInvoice: '', taxInvoiceStatus: 'none', salesAgentId: null, salesName: '', note: '',
  status: 'verified', flagged: false, reconciled: false, verifiedById: null, verifiedAt: null, createdAt: new Date('2026-07-18T00:00:00Z'),
  reNumber: '6900001', reNumbers: ['6900001'], billNos: [], receiptName: '', customerType: '', source: 'line', settleState: '', settledAt: null,
  receivedAt: null, receivedBy: null, chequeNo: '', chequeBank: '', chequeDueDate: '', discExpected: '100.00', discResolution: 'credit', discNote: '',
  discResolvedAt: new Date(), discResolvedBy: 'fin', discConfirmedAt: null, discConfirmedBy: '', wrongTransferAt: null, wrongTransferBy: '',
  bankMatches: [], creditEntries: [],
  ...overrides,
});
const grant = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant-1', customerKey: 'C1', customerCode: 'C1', customerName: 'Customer', kind: 'grant', amountSatang: 10_000,
  paymentId: 'payment-1', createdAt: new Date('2026-07-18T00:00:00Z'), updatedAt: new Date('2026-07-18T00:00:00Z'), createdBy: 'boss',
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
  mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
  mocks.customerCreditEntry.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.count.mockResolvedValue(0);
  mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: null } });
  mocks.customerCreditEntry.create.mockImplementation(async ({ data }: any) => grant(data));
  mocks.customerCreditEntry.upsert.mockImplementation(async ({ create }: any) => ({ id: 'spend-1', ...create }));
  mocks.customerCreditEntry.delete.mockResolvedValue({});
  mocks.payment.findMany.mockResolvedValue([]);
  mocks.payment.count.mockResolvedValue(0);
  mocks.payment.updateMany.mockResolvedValue({ count: 0 });
  mocks.payment.update.mockImplementation(async ({ data }: any) => basePayment(data));
  mocks.payment.delete.mockResolvedValue({});
  mocks.paymentBankMatch.findMany.mockResolvedValue([]);
  mocks.paymentBankMatch.count.mockResolvedValue(0);
  mocks.paymentBankMatch.deleteMany.mockResolvedValue({ count: 0 });
  mocks.reReceipt.findMany.mockResolvedValue([]);
  mocks.bankTxn.update.mockResolvedValue({});
  mocks.bankTxn.updateMany.mockResolvedValue({ count: 0 });
});

describe('Juno customer-credit routes', () => {
  it('keeps supervisor authorization first and creates only one immutable grant on repeat confirmation', async () => {
    const app = await server();
    const forbidden = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } });
    expect(forbidden.statusCode).toBe(403);
    expect(mocks.payment.findUnique).not.toHaveBeenCalled();

    mocks.role.value = 'supervisor';
    const payment = basePayment();
    mocks.payment.findUnique.mockResolvedValue(payment);
    mocks.payment.findMany.mockResolvedValue([payment]);
    mocks.reReceipt.findMany.mockResolvedValue([{ reNumber: '6900001', amount: '100.00' }]);
    mocks.customerCreditEntry.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(grant());
    expect((await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } })).statusCode).toBe(200);
    expect(mocks.customerCreditEntry.create).toHaveBeenCalledTimes(1);
    expect(mocks.customerCreditEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountSatang: 10_000, kind: 'grant' }) }));
    await app.close();
  });

  it('returns customer/overpay errors and leaves non-credit confirmation behavior unchanged without a ledger row', async () => {
    const app = await server();
    mocks.role.value = 'supervisor';
    const keyless = basePayment({ customerCode: '', customerName: '' });
    mocks.payment.findUnique.mockResolvedValue(keyless);
    mocks.payment.findMany.mockResolvedValue([keyless]);
    mocks.reReceipt.findMany.mockResolvedValue([{ reNumber: '6900001', amount: '100.00' }]);
    const missing = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toEqual(expect.objectContaining({ error: 'credit_customer_required', message: 'กรุณากรอกรหัสลูกค้าหรือชื่อลูกค้าก่อนยืนยันเครดิต' }));

    const underpaid = basePayment({ amount: '80.00' });
    mocks.payment.findUnique.mockResolvedValue(underpaid);
    mocks.payment.findMany.mockResolvedValue([underpaid]);
    const overpayRequired = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } });
    expect(overpayRequired.statusCode).toBe(409);
    expect(overpayRequired.json()).toEqual(expect.objectContaining({ error: 'credit_overpay_required', message: 'สร้างเครดิตได้เฉพาะรายการยอดเกินที่มากกว่า 0' }));

    const nonCredit = basePayment({ discResolution: 'refund' });
    mocks.payment.findUnique.mockResolvedValue(nonCredit);
    const unchanged = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: true } });
    expect(unchanged.statusCode).toBe(200);
    expect(mocks.customerCreditEntry.create).toHaveBeenCalledTimes(0);
    await app.close();
  });

  it('reopens ordinary resolution edits exactly as before, but blocks removal only when a spent grant exists', async () => {
    const app = await server();
    const confirmed = basePayment({ discConfirmedAt: new Date(), discConfirmedBy: 'boss' });
    mocks.payment.findUnique.mockResolvedValue(confirmed);
    const ordinary = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-resolve', payload: { resolution: 'credit', note: 'edit' } });
    expect(ordinary.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ discConfirmedAt: null, discConfirmedBy: '' }) }));

    mocks.customerCreditEntry.findUnique.mockResolvedValue(grant());
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 2_000 } });
    const blocked = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-resolve', payload: { resolution: 'refund' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual(expect.objectContaining({ error: 'credit_grant_spent', message: 'เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงเปลี่ยนวิธีจัดการไม่ได้' }));
    await app.close();
  });

  it('preserves omitted credit and keepRecorded, replaces/clears spend, and rejects wrong-transfer credit', async () => {
    const app = await server();
    const recorded = basePayment({ status: 'recorded', creditUsed: '25.00', verifiedById: 'original', verifiedAt: new Date() });
    mocks.payment.findUnique.mockResolvedValue(recorded);
    mocks.payment.update.mockImplementationOnce(async ({ data }: any) => ({ ...recorded, ...data }));
    const omitted = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: ['6900001'] } });
    expect(omitted.statusCode).toBe(200);
    const omittedData = mocks.payment.update.mock.calls.at(-1)?.[0].data;
    expect(omittedData.status).toBe('recorded');
    expect(omittedData).not.toHaveProperty('creditUsed');
    expect(omittedData).not.toHaveProperty('verifiedAt');

    mocks.payment.findUnique.mockResolvedValue(basePayment());
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 10_000 } });
    const spend = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: ['6900001'], creditUsed: '60.00' } });
    expect(spend.statusCode).toBe(200);
    expect(mocks.customerCreditEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ amountSatang: -6_000 }) }));

    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 5_000 } });
    const insufficient = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: ['6900001'], creditUsed: '60.00' } });
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json()).toEqual(expect.objectContaining({ error: 'credit_insufficient', available: 50 }));
    expect(insufficient.json().message).toContain('ใช้ได้ ฿50.00');

    const wrong = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/verify', payload: { reNumbers: [], wrongTransfer: true, creditUsed: '1.00' } });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe('credit_wrong_transfer');
    await app.close();
  });

  it('locks identity/amount only for actual ledger owners and applies grant guards to void/delete', async () => {
    const app = await server();
    const payment = basePayment({ discConfirmedAt: new Date() });
    mocks.payment.findUnique.mockResolvedValue(payment);
    mocks.customerCreditEntry.count.mockResolvedValue(1);
    const identity = await app.inject({ method: 'PATCH', url: '/api/juno/payments/payment-1', payload: { customerCode: 'C2' } });
    expect(identity.statusCode).toBe(409);
    expect(identity.json().error).toBe('credit_customer_locked');

    mocks.customerCreditEntry.count.mockResolvedValue(0);
    mocks.customerCreditEntry.findUnique.mockResolvedValue(grant());
    const amountLocked = await app.inject({ method: 'PATCH', url: '/api/juno/payments/payment-1', payload: { amount: '201.00' } });
    expect(amountLocked.statusCode).toBe(409);
    expect(amountLocked.json()).toEqual(expect.objectContaining({ error: 'credit_grant_locked', message: 'กรุณายกเลิกยืนยันเครดิตก่อนแก้ยอดตามเอกสาร' }));

    mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
    expect((await app.inject({ method: 'PATCH', url: '/api/juno/payments/payment-1', payload: { customerCode: 'C2' } })).statusCode).toBe(200);

    mocks.customerCreditEntry.findUnique.mockResolvedValue(grant());
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 0 } });
    const voided = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/status', payload: { status: 'void' } });
    expect(voided.statusCode).toBe(409);
    expect(voided.json().error).toBe('credit_grant_spent');
    mocks.role.value = 'supervisor';
    const deleted = await app.inject({ method: 'DELETE', url: '/api/juno/payments/payment-1' });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual(expect.objectContaining({ message: 'เครดิตจากรายการนี้ถูกใช้ไปแล้ว จึงลบรายการไม่ได้' }));
    await app.close();
  });

  it('un-confirms/removes an available grant and releases spend atomically on void/delete', async () => {
    const app = await server();
    mocks.role.value = 'supervisor';
    const confirmed = basePayment({ discConfirmedAt: new Date(), discConfirmedBy: 'boss', creditUsed: '20.00' });
    mocks.payment.findUnique.mockResolvedValue(confirmed);
    mocks.customerCreditEntry.findUnique.mockImplementation(async ({ where }: any) => {
      const kind = where.paymentId_kind.kind;
      return kind === 'grant' ? grant() : null;
    });
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 10_000 } });
    const unconfirmed = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/disc-confirm', payload: { confirmed: false } });
    expect(unconfirmed.statusCode).toBe(200);
    expect(mocks.customerCreditEntry.delete).toHaveBeenCalledWith({ where: { id: 'grant-1' } });
    expect(mocks.payment.update).toHaveBeenCalledWith(expect.objectContaining({ data: { discConfirmedAt: null, discConfirmedBy: '' } }));

    const spend = grant({ id: 'spend-1', kind: 'spend', amountSatang: -2_000 });
    mocks.customerCreditEntry.findUnique.mockImplementation(async ({ where }: any) => where.paymentId_kind.kind === 'spend' ? spend : null);
    const voided = await app.inject({ method: 'POST', url: '/api/juno/payments/payment-1/status', payload: { status: 'void' } });
    expect(voided.statusCode).toBe(200);
    expect(mocks.payment.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'void', creditUsed: '' }) }));

    mocks.payment.findUnique.mockResolvedValue({ ...confirmed, bankMatches: [] });
    const deleted = await app.inject({ method: 'DELETE', url: '/api/juno/payments/payment-1' });
    expect(deleted.statusCode).toBe(200);
    expect(mocks.payment.delete).toHaveBeenCalledWith({ where: { id: 'payment-1' } });
    await app.close();
  });

  it('caps history at the latest 50 but computes balance over all rows, and exports creditUsed without changing amount', async () => {
    const app = await server();
    const entries = Array.from({ length: 51 }, (_, index) => ({
      ...grant({ id: `entry-${index}`, paymentId: `payment-${index}`, amountSatang: 100, createdAt: new Date(2026, 0, index + 1) }),
      payment: { id: `payment-${index}`, transferAt: '', createdAt: new Date(2026, 0, index + 1), reNumbers: [] },
    }));
    mocks.customerCreditEntry.findMany.mockResolvedValueOnce([{ customerKey: 'C1' }]).mockResolvedValueOnce(entries);
    mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: 5_100 } });
    const history = await app.inject({ method: 'GET', url: '/api/juno/customer-credits' });
    expect(history.statusCode).toBe(200);
    expect(history.json().customers[0].balance).toBe(51);
    expect(history.json().customers[0].history).toHaveLength(50);
    expect(history.json().customers[0].history[0].id).toBe('entry-1');

    mocks.role.value = 'supervisor';
    mocks.payment.findMany.mockResolvedValueOnce([basePayment({ amount: '200.00', creditUsed: '50.00' })]);
    const csv = await app.inject({ method: 'GET', url: '/api/juno/export.csv' });
    expect(csv.body).toContain('amount,creditUsed,ocrAmount');
    expect(csv.body).toContain('200.00,50.00,200.00');
    await app.close();
  });

  it('keeps WHT and income/report totals on raw cash despite credit use', async () => {
    const app = await server();
    mocks.payment.findMany.mockResolvedValueOnce([{ amount: '200.00', whtAmount: '10.00', creditUsed: '50.00' }]);
    const wht = await app.inject({ method: 'GET', url: '/api/juno/wht/summary' });
    expect(wht.json()).toEqual({ count: 1, net: 200, wht: 10, gross: 210 });

    mocks.role.value = 'supervisor';
    mocks.payment.findMany.mockResolvedValueOnce([{
      amount: '200.00', creditUsed: '50.00', salesName: 'FIN', bank: 'KBANK', customerName: 'Customer', customerCode: 'C1', createdAt: new Date(),
    }]);
    const report = await app.inject({ method: 'GET', url: '/api/juno/reports?groupBy=customer' });
    expect(report.json().grandTotal).toBe(200);
    await app.close();
  });
});
