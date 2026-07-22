import { describe, expect, it } from 'vitest';
import {
  bangkokMinuteKey,
  maxNameSimilarity,
  paymentTimestamp,
  strictPaymentTimestamp,
} from '../src/bank/match.js';
import { billSearchReference } from '../src/finance/rePaymentSearch.js';

describe('paymentTimestamp', () => {
  const createdAt = new Date('2026-07-09T10:00:00+07:00');

  it('normalizes a four-digit Buddhist year', () => {
    expect(paymentTimestamp('04/07/2569 15:54', createdAt).toISOString()).toBe(
      new Date('2026-07-04T15:54:00+07:00').toISOString(),
    );
  });

  it('normalizes a two-digit Buddhist year', () => {
    expect(paymentTimestamp('04/07/69 15:54', createdAt).toISOString()).toBe(
      new Date('2026-07-04T15:54:00+07:00').toISOString(),
    );
  });

  it('leaves a four-digit Gregorian year unchanged', () => {
    expect(paymentTimestamp('04/07/2026 15:54', createdAt).toISOString()).toBe(
      new Date('2026-07-04T15:54:00+07:00').toISOString(),
    );
  });

  it('falls back to createdAt for unparseable input', () => {
    expect(paymentTimestamp('garbage', createdAt)).toBe(createdAt);
  });
});

describe('strictPaymentTimestamp and Bangkok minute keys', () => {
  it('normalizes Buddhist, two-digit Buddhist, and Gregorian years to the same minute', () => {
    const values = [
      strictPaymentTimestamp('04/07/2569 15:54'),
      strictPaymentTimestamp('04/07/69 15:54'),
      strictPaymentTimestamp('04/07/2026 15:54'),
    ];

    expect(values.every((value) => value !== null)).toBe(true);
    expect(values.map((value) => bangkokMinuteKey(value!))).toEqual([
      '2026-07-04 15:54',
      '2026-07-04 15:54',
      '2026-07-04 15:54',
    ]);
  });

  it('rejects missing, date-only, unparseable, and impossible timestamps without fallback', () => {
    expect(strictPaymentTimestamp('')).toBeNull();
    expect(strictPaymentTimestamp('04/07/2026')).toBeNull();
    expect(strictPaymentTimestamp('garbage')).toBeNull();
    expect(strictPaymentTimestamp('31/02/2026 15:54')).toBeNull();
  });

  it('truncates bank seconds when producing a Bangkok calendar-minute key', () => {
    expect(bangkokMinuteKey(new Date('2026-07-04T15:54:37+07:00'))).toBe('2026-07-04 15:54');
    expect(bangkokMinuteKey(new Date('2026-07-04T15:55:00+07:00'))).toBe('2026-07-04 15:55');
  });
});

describe('suggestion name scoring', () => {
  it('lets customerName contribute when a different senderName is present', () => {
    const score = maxNameSimilarity('Acme Dental Clinic', [
      'Different Sender',
      'Acme Dental Clinic',
      '',
    ]);

    expect(score).toBe(1);
  });
});

describe('bank-first bill search normalization', () => {
  it.each([
    ['MB 9690001', '9690001'],
    ['9690001', '9690001'],
    ['XS6900342', 'XS6900342'],
    ['xs 6900342', 'XS6900342'],
  ])('resolves %s to the stored billNos value', (input, expected) => {
    expect(billSearchReference(input)).toBe(expected);
  });
});
