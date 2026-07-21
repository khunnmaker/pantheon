import { describe, expect, it } from 'vitest';
import {
  isManualBillReference,
  displayReceiptReference,
  normalizeBillReference,
  normalizeReceiptReference,
} from './receiptReferences.js';

describe('receipt reference normalization', () => {
  it('canonicalizes both exact wrong-transfer sentinels', () => {
    expect(normalizeReceiptReference('0')).toEqual({ kind: 'wrong_transfer', value: '0000000' });
    expect(normalizeReceiptReference('0000000')).toEqual({ kind: 'wrong_transfer', value: '0000000' });
    expect(normalizeReceiptReference('0000001')).toEqual({ kind: 're', value: '0000001' });
    expect(normalizeReceiptReference('RE 0000000')).toEqual({ kind: 're', value: '0000000' });
  });

  it.each(['9690001', 'MB9690001', 'MB 9690001', 'mb-9690001'])(
    'canonicalizes manual bill %s to its bare number',
    (raw) => {
      expect(normalizeReceiptReference(raw)).toEqual({
        kind: 'bill', billKind: 'manual', value: '9690001',
      });
    },
  );

  it('keeps RE classification disjoint from manual bills', () => {
    expect(normalizeReceiptReference('RE 6900025')).toEqual({ kind: 're', value: '6900025' });
    expect(normalizeReceiptReference('9690001')?.kind).toBe('bill');
  });

  it.each([
    ['XS000001', 'XS000001'],
    ['xs 000001', 'XS000001'],
    ['AB-1234', 'AB1234'],
  ])('accepts and canonicalizes external document %s', (raw, value) => {
    expect(normalizeReceiptReference(raw)).toEqual({ kind: 'bill', billKind: 'external', value });
  });

  it.each(['XS6900342', 'xs 6900342', 'xs-6900342'])(
    'classifies a real 7-digit XS doc number %s as xs (checked before the generic external regex)',
    (raw) => {
      expect(normalizeReceiptReference(raw)).toEqual({ kind: 'bill', billKind: 'xs', value: 'XS6900342' });
    },
  );

  it('keeps XS classification disjoint from external and manual', () => {
    // Old (pre-sales-era, 6-digit) XS-shaped refs stay 'external' — only the exact 7-digit shape
    // used by the real doc numbers (XS6900340+) is reclassified; an 8-digit near-miss still falls
    // through to 'external' (the generic alpha+digits shape), not 'xs'.
    expect(normalizeBillReference('XS000001')?.billKind).toBe('external');
    expect(normalizeBillReference('XS69003421')?.billKind).toBe('external');
    expect(normalizeBillReference('9690001')?.billKind).toBe('manual');
  });

  it('bounds the recognized external-document shape', () => {
    expect(normalizeBillReference('X123')?.billKind).toBe('other');
    expect(normalizeBillReference('ABCDE1234')?.billKind).toBe('other');
    expect(normalizeBillReference('AB12345678901')?.billKind).toBe('other');
  });

  it('marks only canonical manual-bill numbers for registry lookup', () => {
    expect(isManualBillReference('9699999')).toBe(true);
    expect(isManualBillReference('XS000001')).toBe(false);
    expect(isManualBillReference('6900025')).toBe(false);
  });

  it.each([
    [{ kind: 'wrong_transfer', value: '0000000' } as const, 'โอนเงินผิด 0000000'],
    [{ kind: 're', value: '6907674' } as const, 'RE 6907674'],
    [{ kind: 'bill', billKind: 'manual', value: '9690001' } as const, 'MB 9690001'],
    [{ kind: 'bill', billKind: 'external', value: 'MB690001' } as const, 'MB69-0001'],
    [{ kind: 'bill', billKind: 'external', value: 'XS000001' } as const, 'XS000001'],
    [{ kind: 'bill', billKind: 'xs', value: 'XS6900342' } as const, 'XS6900342'],
  ])('formats stored references without guessing their kind', (reference, label) => {
    expect(displayReceiptReference(reference)).toBe(label);
  });
});
