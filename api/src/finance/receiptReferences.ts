export type BillReferenceKind = 'manual' | 'external' | 'other';

export type ReceiptReference =
  | { kind: 'wrong_transfer'; value: '0000000' }
  | { kind: 're'; value: string }
  | { kind: 'bill'; billKind: BillReferenceKind; value: string };

// Finance often adds visual separators while typing document numbers. Persist one canonical
// representation so ManualBill joins and later existence checks use the same value.
function compactReference(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

export function normalizeBillReference(raw: string): Extract<ReceiptReference, { kind: 'bill' }> | null {
  const compact = compactReference(raw);
  if (!compact || compact.length > 80 || /[/,]/.test(compact)) return null;

  const prefixedManual = /^MB(9\d{6})$/.exec(compact);
  const value = prefixedManual?.[1] ?? compact;
  const billKind: BillReferenceKind = /^9\d{6}$/.test(value)
    ? 'manual'
    : /^[A-Z]{1,4}\d{4,10}$/.test(value)
      ? 'external'
      : 'other';
  return { kind: 'bill', billKind, value };
}

export function normalizeReceiptReference(raw: string): ReceiptReference | null {
  const compact = compactReference(raw);
  if (compact === '0000000') return { kind: 'wrong_transfer', value: '0000000' };
  const reValue = compact.replace(/^RE/, '');
  if (/^\d{7}$/.test(reValue) && !reValue.startsWith('9')) {
    return { kind: 're', value: reValue };
  }
  return normalizeBillReference(raw);
}

/** Human label for a stored receipt/document reference. Never guesses that arbitrary alpha refs are MB. */
export function displayReceiptReference(reference: ReceiptReference): string {
  if (reference.kind === 'wrong_transfer') return 'โอนเงินผิด 0000000';
  if (reference.kind === 're') return `RE ${reference.value}`;
  if (/^MB\d{6}$/.test(reference.value)) return `${reference.value.slice(0, 4)}-${reference.value.slice(4)}`;
  return reference.billKind === 'manual' ? `MB ${reference.value}` : reference.value;
}

export function isManualBillReference(value: string): boolean {
  return /^9\d{6}$/.test(value);
}
