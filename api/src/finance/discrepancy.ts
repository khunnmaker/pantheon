// Pure payment↔RE component logic for Juno's discrepancy ledger. Money comparisons are
// performed in integer satang; display values are converted back to baht only at API edges.

export interface DiscrepancyPaymentInput {
  id: string;
  reNumbers: string[];
  amount: string;
  whtAmount: string;
  creditUsed?: string;
  status?: string;
  discExpected?: string;
  wrongTransferAt?: Date | null;
}

export interface DiscrepancyReceiptInput {
  reNumber: string;
  amount: string;
}

export interface DiscrepancyComponent {
  payments: DiscrepancyPaymentInput[];
  reNumbers: string[];
  allImported: boolean;
  grossSatang: number;
  expectedSatang: number;
  diffSatang: number;
}

export type ExpectedSource = 'typed' | 're';

export interface ExpectedResult {
  expectedSatang: number;
  source: ExpectedSource;
}

export function moneyToSatang(value: string): number {
  const parsed = Number((value || '').replace(/,/g, '').trim() || '0');
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function satangToBaht(value: number): number {
  return Number((value / 100).toFixed(2));
}

export function grossSatang(payment: Pick<DiscrepancyPaymentInput, 'amount' | 'whtAmount'>): number {
  return moneyToSatang(payment.amount) + moneyToSatang(payment.whtAmount);
}

export function effectivePaidSatang(
  payment: Pick<DiscrepancyPaymentInput, 'amount' | 'whtAmount' | 'creditUsed'> & { wrongTransferAt?: Date | null },
): number {
  return grossSatang(payment) + (payment.wrongTransferAt ? 0 : moneyToSatang(payment.creditUsed ?? ''));
}

export function normalizeReCore(value: string): string | null {
  const core = value.trim().replace(/^re/i, '');
  return /^\d{7}$/.test(core) && core !== '0000000' ? core : null;
}

export function isMoneyString(value: string, allowEmpty = true): boolean {
  const trimmed = value.trim();
  if (!trimmed) return allowEmpty;
  // FIN types thousands separators ("1,200.50"); moneyToSatang strips them, so accept them here.
  const normalized = trimmed.replace(/,/g, '');
  return /^\d+(?:\.\d{1,2})?$/.test(normalized) && Number(normalized) >= 0;
}

/** Build connected components by shared normalized RE cores, excluding void payments. */
export function buildDiscrepancyComponents(
  payments: DiscrepancyPaymentInput[],
  receipts: DiscrepancyReceiptInput[],
): DiscrepancyComponent[] {
  const active = payments
    .filter((payment) => payment.status !== 'void')
    .map((payment) => ({
      ...payment,
      reNumbers: [...new Set(payment.reNumbers.map(normalizeReCore).filter((re): re is string => !!re))],
    }))
    .filter((payment) => payment.reNumbers.length > 0);

  const parent = active.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };

  const firstPaymentByRe = new Map<string, number>();
  active.forEach((payment, index) => {
    for (const re of payment.reNumbers) {
      const first = firstPaymentByRe.get(re);
      if (first === undefined) firstPaymentByRe.set(re, index);
      else union(first, index);
    }
  });

  const receiptAmountByRe = new Map<string, number>();
  for (const receipt of receipts) {
    const core = normalizeReCore(receipt.reNumber);
    if (core) receiptAmountByRe.set(core, moneyToSatang(receipt.amount));
  }

  const grouped = new Map<number, DiscrepancyPaymentInput[]>();
  active.forEach((payment, index) => {
    const root = find(index);
    const list = grouped.get(root);
    if (list) list.push(payment);
    else grouped.set(root, [payment]);
  });

  return [...grouped.values()].map((componentPayments) => {
    const reNumbers = [...new Set(componentPayments.flatMap((payment) => payment.reNumbers))];
    const allImported = reNumbers.length > 0 && reNumbers.every((re) => receiptAmountByRe.has(re));
    const gross = componentPayments.reduce((sum, payment) => sum + effectivePaidSatang(payment), 0);
    const expected = allImported
      ? reNumbers.reduce((sum, re) => sum + (receiptAmountByRe.get(re) ?? 0), 0)
      : 0;
    return {
      payments: componentPayments,
      reNumbers,
      allImported,
      grossSatang: gross,
      expectedSatang: expected,
      diffSatang: allImported ? gross - expected : 0,
    };
  });
}

export interface DiscrepancyDb {
  payment: { findMany(args: { orderBy: { createdAt: 'desc' } }): Promise<DiscrepancyPaymentInput[]> };
  reReceipt: { findMany(args: { select: { reNumber: true; amount: true } }): Promise<DiscrepancyReceiptInput[]> };
}

export async function getDiscrepancyForPayment(db: DiscrepancyDb, paymentId: string) {
  const [payments, receipts] = await Promise.all([
    db.payment.findMany({ orderBy: { createdAt: 'desc' } }),
    db.reReceipt.findMany({ select: { reNumber: true, amount: true } }),
  ]);
  const payment = payments.find((row) => row.id === paymentId);
  if (!payment) return null;
  const components = buildDiscrepancyComponents(payments, receipts);
  const expected = expectedForPayment(payment, componentByPaymentId(components).get(payment.id));
  if (!expected) return { payment, expected: null, diffSatang: 0 };
  return {
    payment,
    expected,
    diffSatang: effectivePaidSatang(payment) - expected.expectedSatang,
  };
}

export function componentByPaymentId(components: DiscrepancyComponent[]): Map<string, DiscrepancyComponent> {
  const result = new Map<string, DiscrepancyComponent>();
  for (const component of components) {
    for (const payment of component.payments) result.set(payment.id, component);
  }
  return result;
}

/** Typed expected always wins; RE-derived expected is only valid for a single-payment component. */
export function expectedForPayment(
  payment: DiscrepancyPaymentInput,
  component?: DiscrepancyComponent,
): ExpectedResult | undefined {
  if (payment.discExpected?.trim()) {
    return { expectedSatang: moneyToSatang(payment.discExpected), source: 'typed' };
  }
  if (component?.payments.length === 1 && component.allImported) {
    return { expectedSatang: component.expectedSatang, source: 're' };
  }
  return undefined;
}

export function mismatchedMultiPaymentComponentCount(components: DiscrepancyComponent[]): number {
  return components.filter(
    (component) => component.payments.length > 1 && component.allImported && component.diffSatang !== 0,
  ).length;
}
