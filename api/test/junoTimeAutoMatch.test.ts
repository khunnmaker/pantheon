import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  txns: [] as Array<Record<string, any>>,
  payments: [] as Array<Record<string, any>>,
  links: [] as Array<{ paymentId: string; bankTxnId: string; createdById: null }>,
  autoRecordCandidates: false,
}));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: 'agent-1', email: 'fin@example.test', name: 'FIN', role: 'staff', apps: ['juno'] };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    bankTxn: {
      findMany: vi.fn(async () => state.txns.filter((txn) => txn.direction === 'in' && txn.matchStatus === 'unmatched')),
      update: vi.fn(async ({ where, data }: any) => {
        const txn = state.txns.find((candidate) => candidate.id === where.id)!;
        Object.assign(txn, data);
        return txn;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    payment: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where.source === 'cheque') return [];
        // The auto stage-4 sweep (autoRecordEligible) queries { status, wrongTransferAt } only —
        // return no candidates unless the verify-route test explicitly exercises that sweep.
        if (where.status === 'verified' && where.wrongTransferAt === null && Object.keys(where).length === 2) {
          if (!state.autoRecordCandidates) return [];
          return state.payments
            .filter((payment) => payment.status === 'verified' && payment.wrongTransferAt === null)
            .map((payment) => ({
              ...payment,
              bankMatches: state.links.filter((link) => link.paymentId === payment.id).map((link) => ({ bankTxnId: link.bankTxnId })),
            }));
        }
        // autoConfirmOverpayCredits' own candidate query (juno-auto-disc) — same reasoning,
        // unrelated to these bank-matching tests.
        if (where.discConfirmedAt === null) return [];
        return state.payments.filter((payment) =>
          payment.status === 'verified' && !payment.reconciled && payment.source !== 'cheque' && payment.wrongTransferAt === null,
        );
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const payment = state.payments.find((candidate) => candidate.id === where.id)!;
        Object.assign(payment, data);
        return payment;
      }),
      findUnique: vi.fn(async ({ where }: any) => state.payments.find((candidate) => candidate.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const ids = new Set(where.id.in);
        let count = 0;
        for (const payment of state.payments) {
          if (ids.has(payment.id) && payment.status === where.status && payment.wrongTransferAt === null) {
            Object.assign(payment, data);
            count++;
          }
        }
        return { count };
      }),
    },
    paymentBankMatch: {
      create: vi.fn(async ({ data }: any) => {
        state.links.push(data);
        return data;
      }),
      count: vi.fn(async ({ where }: any) => state.links.filter((link) => {
        if (where.paymentId && link.paymentId !== where.paymentId) return false;
        if (where.bankTxnId && link.bankTxnId !== where.bankTxnId) return false;
        if (where.payment) {
          const payment = state.payments.find((candidate) => candidate.id === link.paymentId);
          return payment && payment.wrongTransferAt === null && !where.payment.status.notIn.includes(payment.status);
        }
        return true;
      }).length),
      findMany: vi.fn(async () => []),
    },
    reReceipt: { findMany: vi.fn(async () => []) },
    xsDoc: { findMany: vi.fn(async () => []) },
    customerCreditEntry: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (arg: Array<Promise<unknown>> | ((tx: unknown) => unknown)) =>
      Array.isArray(arg) ? Promise.all(arg) : arg((await import('../src/db/prisma.js')).prisma)),
  },
}));

vi.mock('../src/line/staffUploads.js', () => ({
  readStaffUploadFile: vi.fn(),
  readStaffUploadMeta: vi.fn(),
  UPLOAD_ID_RE: /^[a-z0-9-]+$/,
}));
vi.mock('../src/llm/readSlip.js', () => ({
  readChequeFromBuffer: vi.fn(),
  readSlipFromBuffer: vi.fn(),
}));
vi.mock('../src/jupiter/sync.js', () => ({ syncPaymentToJupiter: vi.fn().mockResolvedValue(undefined) }));

import { junoRoutes } from '../src/routes/juno.js';

function payment(id: string, transferAt: string, amount = '500.00', createdAt = new Date('2026-07-04T15:54:00+07:00')) {
  return {
    id,
    amount,
    transferAt,
    createdAt,
    senderName: 'Receipt Owner',
    customerName: 'Customer Owner',
    receiptName: 'Invoice Owner',
    status: 'verified',
    reconciled: false,
    source: 'line',
    wrongTransferAt: null,
  };
}

function txn(id: string, txnAt: string, amount = '500.00') {
  return {
    id,
    txnAt: new Date(txnAt),
    amount,
    direction: 'in',
    matchStatus: 'unmatched',
    description: 'Transfer Deposit',
    details: '',
    payerName: 'Third Party Payer',
  };
}

async function runAutoMatch() {
  const app = Fastify();
  await app.register(junoRoutes);
  await app.ready();
  const response = await app.inject({ method: 'POST', url: '/api/juno/bank/automatch' });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.txns.length = 0;
  state.payments.length = 0;
  state.links.length = 0;
  state.autoRecordCandidates = false;
});

describe('Juno auto-match pass B', () => {
  it('links exact amount + minute even when payer names conflict', async () => {
    state.payments.push(payment('payment-1', '04/07/2026 15:54'));
    state.txns.push(txn('txn-1', '2026-07-04T15:54:00+07:00'));

    const response = await runAutoMatch();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, autoMatched: 0, chequeMatched: 0, timeMatched: 1, autoRecorded: 0, discAutoConfirmed: 0 });
    expect(state.links).toEqual([{ paymentId: 'payment-1', bankTxnId: 'txn-1', createdById: null }]);
  });

  it('matches bank cash only and never adds customer credit to the bank amount', async () => {
    const credited = payment('payment-1', '04/07/2026 15:54') as ReturnType<typeof payment> & { creditUsed: string };
    credited.creditUsed = '100.00';
    state.payments.push({ ...credited, reconciled: false });
    state.txns.push(txn('txn-1', '2026-07-04T15:54:00+07:00', '500.00'));
    expect((await runAutoMatch()).json().timeMatched).toBe(1);

    state.txns.length = 0;
    state.payments.length = 0;
    state.links.length = 0;
    state.payments.push(credited);
    state.txns.push(txn('txn-2', '2026-07-04T15:54:00+07:00', '600.00'));
    expect((await runAutoMatch()).json().timeMatched).toBe(0);
  });

  it('leaves two same-amount payments in the same minute unmatched', async () => {
    const agreeingPayment = payment('payment-1', '04/07/2026 15:54');
    agreeingPayment.senderName = 'Third Party Payer';
    state.payments.push(agreeingPayment, payment('payment-2', '04/07/2026 15:54'));
    state.txns.push(txn('txn-1', '2026-07-04T15:54:00+07:00'));

    const response = await runAutoMatch();

    expect(response.json().timeMatched).toBe(0);
    expect(state.links).toHaveLength(0);
  });

  it('leaves two same-amount bank lines in the same minute unmatched for one payment', async () => {
    state.payments.push(payment('payment-1', '04/07/2026 15:54'));
    const agreeingTxn = txn('txn-1', '2026-07-04T15:54:00+07:00');
    agreeingTxn.payerName = 'Receipt Owner';
    state.txns.push(agreeingTxn, txn('txn-2', '2026-07-04T15:54:37+07:00'));

    const response = await runAutoMatch();

    expect(response.json().timeMatched).toBe(0);
    expect(state.links).toHaveLength(0);
  });

  it.each(['', '04/07/2026', 'not-a-timestamp'])(
    'does not use coincident createdAt when transferAt is %j',
    async (transferAt) => {
      state.payments.push(payment('payment-1', transferAt));
      state.txns.push(txn('txn-1', '2026-07-04T15:54:00+07:00'));

      const response = await runAutoMatch();

      expect(response.json().timeMatched).toBe(0);
      expect(state.links).toHaveLength(0);
    },
  );

  it('truncates txn seconds within the minute but rejects the next minute', async () => {
    state.payments.push(payment('payment-1', '04/07/2026 15:54'));
    state.txns.push(txn('txn-1', '2026-07-04T15:54:37+07:00'));
    const sameMinute = await runAutoMatch();
    expect(sameMinute.json().timeMatched).toBe(1);

    state.txns.length = 0;
    state.payments.length = 0;
    state.links.length = 0;
    state.payments.push(payment('payment-2', '04/07/2026 15:54'));
    state.txns.push(txn('txn-2', '2026-07-04T15:55:00+07:00'));
    const nextMinute = await runAutoMatch();
    expect(nextMinute.json().timeMatched).toBe(0);
    expect(state.links).toHaveLength(0);
  });

  it('preserves the generic-pass name-conflict veto outside the same minute', async () => {
    state.payments.push(payment('payment-1', '04/07/2026 15:55'));
    state.txns.push(txn('txn-1', '2026-07-04T15:54:00+07:00'));

    const response = await runAutoMatch();

    expect(response.json()).toEqual({ ok: true, autoMatched: 0, chequeMatched: 0, timeMatched: 0, autoRecorded: 0, discAutoConfirmed: 0 });
    expect(state.links).toHaveLength(0);
  });

  it('links a pre-existing exact-minute bank line immediately after verify and returns the recorded row', async () => {
    state.autoRecordCandidates = true;
    state.payments.push({
      ...payment('payment-1', '04/07/2026 15:54'),
      customerId: null, customerCode: 'C1', ocrAmount: '500.00', whtRate: 0, whtAmount: '', creditUsed: '', bank: 'KBANK', ref: '',
      slipMessageId: null, slipUrl: '', taxInvoice: '', taxInvoiceStatus: 'none', salesAgentId: null, salesName: '', note: '',
      status: 'received', flagged: false, verifiedById: null, verifiedAt: null, reNumber: '', reNumbers: [], billNos: [],
      settleState: '', settledAt: null, receivedAt: null, receivedBy: null, chequeNo: '', chequeBank: '', chequeDueDate: '',
      discExpected: '', discResolution: '', discNote: '', discResolvedAt: null, discResolvedBy: '', discConfirmedAt: null,
      discConfirmedBy: '', wrongTransferBy: '',
    });
    state.payments.push({
      ...state.payments[0], id: 'payment-2', amount: '700.00', transferAt: '04/07/2026 15:55', status: 'verified',
    });
    state.txns.push(
      txn('txn-1', '2026-07-04T15:54:37+07:00'),
      txn('txn-2', '2026-07-04T15:55:12+07:00', '700.00'),
    );

    const app = Fastify();
    await app.register(junoRoutes);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/juno/payments/payment-1/verify',
      payload: { reNumbers: [], billNos: ['9690001'] },
    });
    await app.close();

    expect(response.statusCode, response.body).toBe(200);
    expect(state.links).toEqual([{ paymentId: 'payment-1', bankTxnId: 'txn-1', createdById: null }]);
    expect(state.txns.find((candidate) => candidate.id === 'txn-2')?.matchStatus).toBe('unmatched');
    expect(response.json().payment).toMatchObject({ reconciled: true, status: 'recorded', billNos: ['9690001'] });
  });
});
