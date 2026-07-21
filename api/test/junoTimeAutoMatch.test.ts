import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  txns: [] as Array<Record<string, any>>,
  payments: [] as Array<Record<string, any>>,
  links: [] as Array<{ paymentId: string; bankTxnId: string; createdById: null }>,
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
    },
    payment: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where.source === 'cheque') return [];
        // The auto stage-4 sweep (autoRecordEligible) queries { status, wrongTransferAt } only —
        // return no candidates so these tests stay focused on the matching passes.
        if (where.status === 'verified' && where.wrongTransferAt === null && Object.keys(where).length === 2) return [];
        return state.payments.filter((payment) =>
          payment.status === 'verified' && !payment.reconciled && payment.source !== 'cheque' && payment.wrongTransferAt === null,
        );
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const payment = state.payments.find((candidate) => candidate.id === where.id)!;
        Object.assign(payment, data);
        return payment;
      }),
    },
    paymentBankMatch: {
      create: vi.fn(async ({ data }: any) => {
        state.links.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
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
vi.mock('../src/jupiter/sync.js', () => ({ syncPaymentToJupiter: vi.fn() }));

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
});

describe('Juno auto-match pass B', () => {
  it('links exact amount + minute even when payer names conflict', async () => {
    state.payments.push(payment('payment-1', '04/07/2026 15:54'));
    state.txns.push(txn('txn-1', '2026-07-04T15:54:00+07:00'));

    const response = await runAutoMatch();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, autoMatched: 0, chequeMatched: 0, timeMatched: 1, autoRecorded: 0 });
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

    expect(response.json()).toEqual({ ok: true, autoMatched: 0, chequeMatched: 0, timeMatched: 0, autoRecorded: 0 });
    expect(state.links).toHaveLength(0);
  });
});
