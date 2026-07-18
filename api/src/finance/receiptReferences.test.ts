import { describe, expect, it } from 'vitest';
import {
  isManualBillReference,
  displayReceiptReference,
  normalizeBillReference,
  normalizeReceiptReference,
} from './receiptReferences.js';

describe('receipt reference normalization', () => {
  it('reserves only the exact all-zero sentinel for a wrong transfer', () => {
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
    [{ kind: 're', value: '6907674' } as const, 'RE 6907674'],
    [{ kind: 'bill', billKind: 'manual', value: '9690001' } as const, 'MB 9690001'],
    [{ kind: 'bill', billKind: 'external', value: 'MB690001' } as const, 'MB69-0001'],
    [{ kind: 'bill', billKind: 'external', value: 'XS000001' } as const, 'XS000001'],
  ])('formats stored references without guessing their kind', (reference, label) => {
    expect(displayReceiptReference(reference)).toBe(label);
  });
});
