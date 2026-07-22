import type { Payment } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { paymentToTxn } from './sync.js';

describe('Juno credit-only accounting', () => {
  it('records zero income and never includes customer credit in accounting totals', () => {
    const payment = {
      id: 'credit-only',
      source: 'credit',
      status: 'recorded',
      amount: '0',
      whtAmount: '',
      creditUsed: '5000.00',
      reNumbers: ['6900010'],
      verifiedAt: new Date('2026-07-18T00:00:00Z'),
      createdAt: new Date('2026-07-17T00:00:00Z'),
      receiptName: 'Customer',
      customerName: 'Customer',
      senderName: '',
      note: '',
    } as Payment;

    const txn = paymentToTxn(payment);
    expect(txn.amount).toBe('0');
    expect(txn.amountNum?.toString()).toBe('0');
    expect(Number(txn.amount || 0) + Number(txn.whtAmount || 0)).toBe(0);
    expect(txn).not.toHaveProperty('creditUsed');
  });

  it('notes MB/XS billNos when a payment carries no RE (owner bug report 2026-07-22)', () => {
    const payment = {
      id: 'mb-only',
      source: 'manual',
      status: 'recorded',
      amount: '1000',
      whtAmount: '',
      creditUsed: '0',
      reNumbers: [] as string[],
      billNos: ['9690001', 'XS0000012'],
      verifiedAt: new Date('2026-07-22T00:00:00Z'),
      createdAt: new Date('2026-07-22T00:00:00Z'),
      receiptName: 'Customer',
      customerName: 'Customer',
      senderName: '',
      note: '',
    } as Payment;

    const txn = paymentToTxn(payment);
    expect(txn.note).toBe('MB 9690001/XS0000012');
  });
});
