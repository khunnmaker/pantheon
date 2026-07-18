import { describe, expect, it } from 'vitest';
import { maxNameSimilarity, paymentTimestamp } from '../src/bank/match.js';

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
