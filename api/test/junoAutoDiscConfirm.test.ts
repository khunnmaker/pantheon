import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner ruling 2026-07-21: for overpays, the CEO's re-upload of a clean Express RE file IS his
// acceptance — auto-resolve (default 'credit') + auto-confirm, granting the customer credit, with
// no human click, as long as the payment is money-grounded and every RE it carries is imported
// and clean. Mirrors autoRecord.test.ts's directness: mock only '../src/db/prisma.js' and let the
// real customerCredit.ts / discrepancy.ts logic run against a small mutable in-memory row store
// (the same pattern junoTimeAutoMatch.test.ts uses for its bank/payment state).

const mocks = vi.hoisted(() => {
  const payment = { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() };
  const reReceipt = { findMany: vi.fn() };
  const customerCreditEntry = {
    findUnique: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(),
    create: vi.fn(), upsert: vi.fn(), delete: vi.fn(),
  };
  return { payment, reReceipt, customerCreditEntry };
});

vi.mock('../src/db/prisma.js', () => ({
  prisma: (() => {
    const db = {
      payment: mocks.payment,
      reReceipt: mocks.reReceipt,
      customerCreditEntry: mocks.customerCreditEntry,
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn((fn: any) => fn(db)),
    };
    return db;
  })(),
}));

import { CustomerCreditError } from '../src/finance/customerCredit.js';
import {
  AUTO_DISC_CONFIRM_ACTOR, autoConfirmOverpayCredits, isAutoDiscConfirmEligible,
  type AutoDiscConfirmCandidate,
} from '../src/finance/autoDiscConfirm.js';

// ─── in-memory row store, mirrors real Payment columns the sweep + its helpers touch ──────────
let rows: Record<string, any>[] = [];

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', customerCode: 'C1', customerName: 'Customer', amount: '600.00', whtAmount: '', creditUsed: '',
  status: 'verified', wrongTransferAt: null, discConfirmedAt: null, discConfirmedBy: '',
  discResolution: '', discExpected: '500.00', discNote: 'original note', discResolvedAt: null, discResolvedBy: '',
  reNumbers: [] as string[], billNos: ['XS6900001'], source: 'line', receivedAt: null, reconciled: true,
  bankMatches: [] as { bankTxnId: string }[], createdAt: new Date('2026-07-20T00:00:00Z'),
  ...overrides,
});

function seed(...payments: Record<string, unknown>[]) {
  rows = payments;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];

  mocks.reReceipt.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.findUnique.mockResolvedValue(null);
  mocks.customerCreditEntry.findMany.mockResolvedValue([]);
  mocks.customerCreditEntry.aggregate.mockResolvedValue({ _sum: { amountSatang: null } });
  mocks.customerCreditEntry.create.mockImplementation(async ({ data }: any) => ({ id: `grant-${data.paymentId}`, ...data }));
  mocks.customerCreditEntry.upsert.mockImplementation(async ({ create }: any) => ({ id: 'spend-1', ...create }));
  mocks.customerCreditEntry.delete.mockResolvedValue({});

  mocks.payment.findUnique.mockImplementation(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null);
  mocks.payment.update.mockImplementation(async ({ where, data }: any) => {
    const row = rows.find((r) => r.id === where.id);
    if (!row) throw new Error(`no such row ${where.id}`);
    Object.assign(row, data);
    return { ...row };
  });
  mocks.payment.findMany.mockImplementation(async (args: any = {}) => {
    // getDiscrepancyForPayment's full-scan (no where key at all).
    if (args.orderBy) return rows;
    // the sweep's own candidate query — real DB would apply this where clause; replicate it here
    // so unrelated rows (wrong status/resolution) never even reach isAutoDiscConfirmEligible.
    if (args.where?.discResolution?.in) {
      const statuses: string[] = args.where.status.in;
      const resolutions: string[] = args.where.discResolution.in;
      return rows.filter((r) =>
        statuses.includes(r.status) && r.wrongTransferAt === null && r.discConfirmedAt === null
        && resolutions.includes(r.discResolution));
    }
    // netPendingUseCredit's own query — no pending use_credit rows in these fixtures.
    if (args.where?.discResolution === 'use_credit') return [];
    return [];
  });
});

describe('isAutoDiscConfirmEligible (pure)', () => {
  const base: AutoDiscConfirmCandidate = {
    reNumbers: [], billNos: ['XS6900001'], discResolution: '', discExpected: '500.00',
    source: 'line', receivedAt: null, reconciled: true, bankMatchCount: 0,
    customerCode: 'C1', customerName: '',
  };
  const clean = (cores: Record<string, boolean>) => new Map(Object.entries(cores));

  it('grounded + documented + declared → eligible', () => {
    expect(isAutoDiscConfirmEligible(base, clean({}))).toBe(true);
  });

  it.each(['refund', 'chase', 'writeoff', 'use_credit'])('resolution %s never auto-confirms', (resolution) => {
    expect(isAutoDiscConfirmEligible({ ...base, discResolution: resolution }, clean({}))).toBe(false);
  });

  it('no documents at all → never eligible', () => {
    expect(isAutoDiscConfirmEligible({ ...base, billNos: [] }, clean({}))).toBe(false);
  });

  it('blank resolution with no typed discExpected → not FIN-declared, skip', () => {
    expect(isAutoDiscConfirmEligible({ ...base, discExpected: '' }, clean({}))).toBe(false);
  });

  it('RE not imported, or imported but ***, → waits; clean → eligible', () => {
    const p = { ...base, reNumbers: ['6900001'] };
    expect(isAutoDiscConfirmEligible(p, clean({}))).toBe(false);
    expect(isAutoDiscConfirmEligible(p, clean({ '6900001': false }))).toBe(false);
    expect(isAutoDiscConfirmEligible(p, clean({ '6900001': true }))).toBe(true);
  });

  it('transfer without a bank link or reconciled flag → waits', () => {
    expect(isAutoDiscConfirmEligible({ ...base, reconciled: false, bankMatchCount: 0 }, clean({}))).toBe(false);
    expect(isAutoDiscConfirmEligible({ ...base, reconciled: false, bankMatchCount: 1 }, clean({}))).toBe(true);
  });

  it('cash/cheque require the CEO ได้รับแล้ว stamp', () => {
    const cash = { ...base, source: 'cash', reconciled: false };
    expect(isAutoDiscConfirmEligible(cash, clean({}))).toBe(false);
    expect(isAutoDiscConfirmEligible({ ...cash, receivedAt: new Date() }, clean({}))).toBe(true);
  });

  it('no customer key → never eligible (nobody to credit)', () => {
    expect(isAutoDiscConfirmEligible({ ...base, customerCode: '', customerName: '' }, clean({}))).toBe(false);
  });
});

describe('autoConfirmOverpayCredits (sweep)', () => {
  it('1. blank resolution + typed discExpected + grounded + documented → resolves to credit, grants, nets, confirms', async () => {
    seed(basePayment());
    const result = await autoConfirmOverpayCredits();
    expect(result).toEqual({ confirmed: 1, paymentIds: ['p1'] });

    const row = rows[0];
    expect(row.discResolution).toBe('credit');
    expect(row.discResolvedBy).toBe(AUTO_DISC_CONFIRM_ACTOR);
    expect(row.discNote).toBe('original note'); // untouched
    expect(row.discConfirmedAt).toBeInstanceOf(Date);
    expect(row.discConfirmedBy).toBe(AUTO_DISC_CONFIRM_ACTOR);

    expect(mocks.customerCreditEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'grant', amountSatang: 10_000, paymentId: 'p1', createdBy: AUTO_DISC_CONFIRM_ACTOR }),
    }));
    // netPendingUseCredit ran (its distinctive query fired).
    expect(mocks.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ discResolution: 'use_credit' }),
    }));

    // idempotent — a second pass finds nothing (discConfirmedAt now set).
    const again = await autoConfirmOverpayCredits();
    expect(again).toEqual({ confirmed: 0, paymentIds: [] });
  });

  it.each(['refund', 'chase', 'writeoff'])('2. resolution %s is never touched', async (resolution) => {
    seed(basePayment({ discResolution: resolution, discResolvedAt: new Date(), discResolvedBy: 'fin' }));
    const result = await autoConfirmOverpayCredits();
    expect(result).toEqual({ confirmed: 0, paymentIds: [] });
    expect(rows[0].discConfirmedAt).toBeNull();
    expect(mocks.customerCreditEntry.create).not.toHaveBeenCalled();
  });

  it('3. RE carried but not imported → skip; imported but *** → skip; clean → confirmed', async () => {
    seed(basePayment({ reNumbers: ['6900001'], billNos: [] }));
    mocks.reReceipt.findMany.mockResolvedValueOnce([]); // not imported
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });

    mocks.reReceipt.findMany.mockResolvedValueOnce([{ reNumber: '6900001', notPosted: true }]); // ***
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });

    mocks.reReceipt.findMany.mockResolvedValueOnce([{ reNumber: '6900001', notPosted: false }]); // clean
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 1, paymentIds: ['p1'] });
  });

  it('4. transfer with zero bank links skips; cash with receivedAt confirms; cash without skips', async () => {
    seed(basePayment({ reconciled: false, bankMatches: [] }));
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });

    seed(basePayment({ source: 'cash', reconciled: false, receivedAt: new Date() }));
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 1, paymentIds: ['p1'] });

    seed(basePayment({ source: 'cash', reconciled: false, receivedAt: null }));
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });
  });

  it('5. underpay and balanced rows skip (strict overpay only)', async () => {
    seed(basePayment({ amount: '400.00', discExpected: '500.00' })); // underpay
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });

    seed(basePayment({ amount: '500.00', discExpected: '500.00' })); // balanced
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });
  });

  it('6. no customer key → skip', async () => {
    seed(basePayment({ customerCode: '', customerName: '' }));
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });
    expect(mocks.customerCreditEntry.create).not.toHaveBeenCalled();
  });

  it('7. blank resolution with empty discExpected → skip (system never invents a case)', async () => {
    seed(basePayment({ discExpected: '' }));
    expect(await autoConfirmOverpayCredits()).toEqual({ confirmed: 0, paymentIds: [] });
  });

  it('8. MB/XS-only payment (no reNumbers), grounded → confirmed', async () => {
    seed(basePayment({ reNumbers: [], billNos: ['XS6900001'], reconciled: true }));
    const result = await autoConfirmOverpayCredits();
    expect(result).toEqual({ confirmed: 1, paymentIds: ['p1'] });
  });

  it('9. grantCredit throwing CustomerCreditError logs and continues; other rows still process', async () => {
    seed(
      basePayment({ id: 'p-bad', customerCode: 'BAD' }),
      basePayment({ id: 'p-good', customerCode: 'GOOD' }),
    );
    mocks.customerCreditEntry.create.mockImplementation(async ({ data }: any) => {
      if (data.paymentId === 'p-bad') throw new CustomerCreditError('credit_grant_locked');
      return { id: `grant-${data.paymentId}`, ...data };
    });
    const log = { error: vi.fn() };
    const result = await autoConfirmOverpayCredits(log);

    expect(result.confirmed).toBe(1);
    expect(result.paymentIds).toEqual(['p-good']);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'p-bad', err: expect.any(CustomerCreditError) }),
      expect.any(String),
    );
    const bad = rows.find((r) => r.id === 'p-bad')!;
    expect(bad.discConfirmedAt).toBeNull(); // rolled back / never stamped
    const good = rows.find((r) => r.id === 'p-good')!;
    expect(good.discConfirmedAt).toBeInstanceOf(Date);
  });
});
