import { describe, expect, it } from 'vitest';
import {
  bankTxnSearchTier,
  chequeSearchDigits,
  nearAmountTolerance,
  reSearchCore,
  searchedAmount,
} from './rePaymentSearch.js';

describe('bank-first RE/payment search normalization', () => {
  it('normalizes RE prefixes and dashes to the stored core', () => {
    expect(reSearchCore('RE-6907674')).toBe('6907674');
    expect(reSearchCore('690-7674')).toBe('6907674');
  });

  it('recognizes FIN-style amount searches', () => {
    expect(searchedAmount('1810')).toBe(1810);
    expect(searchedAmount('฿1,810.00')).toBe(1810);
    expect(searchedAmount('11333.80')).toBe(11333.8);
    expect(nearAmountTolerance(1810)).toBe(36.2);
  });

  it('normalizes cheque numbers to significant digits', () => {
    expect(chequeSearchDigits('Cheque No. 000-1234')).toBe('1234');
    expect(chequeSearchDigits('ไม่มีเลขเช็ค')).toBeNull();
  });

  it('ranks bank-line matches in the required order', () => {
    expect(bankTxnSearchTier({ exactAmount: true, cheque: true, text: true, nearAmount: true })).toBe(4);
    expect(bankTxnSearchTier({ exactAmount: false, cheque: true, text: true, nearAmount: true })).toBe(3);
    expect(bankTxnSearchTier({ exactAmount: false, cheque: false, text: true, nearAmount: true })).toBe(2);
    expect(bankTxnSearchTier({ exactAmount: false, cheque: false, text: false, nearAmount: true })).toBe(1);
  });
});
