import { describe, expect, it } from 'vitest';

import {
  LedgerMoneyError,
  moneyToString,
  normalizeMoneyString,
  parseMoney,
} from '../src/jupiter/ledger/money.js';

describe('Jupiter ledger exact money', () => {
  it('normalizes decimal Strings without converting through JavaScript numbers', () => {
    expect(normalizeMoneyString(' 000123.4 ')).toBe('123.40');
    expect(normalizeMoneyString('0')).toBe('0.00');
    expect(normalizeMoneyString('-0.00')).toBe('0.00');
    expect(normalizeMoneyString('-12.34')).toBe('-12.34');
  });

  it('adds decimal fractions exactly', () => {
    const total = parseMoney('0.10').plus(parseMoney('0.20'));
    expect(moneyToString(total)).toBe('0.30');
  });

  it.each(['1e3', '1,000.00', '1.234', '.50', '', 'NaN'])('rejects malformed value %j', (value) => {
    expect(() => parseMoney(value)).toThrow(LedgerMoneyError);
  });

  it('rejects non-String runtime input, negatives when forbidden, and Decimal(18,2) overflow', () => {
    expect(() => parseMoney(10 as never)).toThrowError(expect.objectContaining({ code: 'money_not_string' }));
    expect(() => parseMoney('-0.01', { allowNegative: false })).toThrowError(
      expect.objectContaining({ code: 'money_negative' }),
    );
    expect(() => parseMoney('10000000000000000.00')).toThrowError(
      expect.objectContaining({ code: 'money_out_of_range' }),
    );
    expect(moneyToString(parseMoney('9999999999999999.99'))).toBe('9999999999999999.99');
  });
});
