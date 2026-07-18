import { Prisma } from '@prisma/client';

export class LedgerMoneyError extends Error {
  constructor(
    public readonly code: 'money_not_string' | 'money_invalid' | 'money_negative' | 'money_out_of_range',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerMoneyError';
  }
}

const DECIMAL_STRING = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const MAX_INTEGER_DIGITS = 16; // Decimal(18,2)

export function normalizeMoneyString(value: string, options: { allowNegative?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new LedgerMoneyError('money_not_string', 'Money must be supplied as a decimal String');
  }

  const input = value.trim();
  const match = DECIMAL_STRING.exec(input);
  if (!match) {
    throw new LedgerMoneyError('money_invalid', `Invalid money value: ${value}`);
  }

  const negative = match[1] === '-';
  if (negative && options.allowNegative === false) {
    throw new LedgerMoneyError('money_negative', 'Money value cannot be negative');
  }

  const integer = match[2]!.replace(/^0+(?=\d)/, '');
  if (integer.length > MAX_INTEGER_DIGITS) {
    throw new LedgerMoneyError('money_out_of_range', 'Money value exceeds Decimal(18,2)');
  }

  const fraction = (match[3] ?? '').padEnd(2, '0');
  const isZero = /^0+$/.test(integer) && fraction === '00';
  return `${negative && !isZero ? '-' : ''}${integer}.${fraction}`;
}

export function parseMoney(value: string, options: { allowNegative?: boolean } = {}): Prisma.Decimal {
  return new Prisma.Decimal(normalizeMoneyString(value, options));
}

export function moneyToString(value: Prisma.Decimal): string {
  return value.toFixed(2);
}
