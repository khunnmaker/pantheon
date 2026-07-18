import { Prisma, type Payment } from '@prisma/client';
import { paymentTimestamp } from '../bank/match.js';
import { getDiscrepancyForPayment, moneyToSatang, satangToBaht } from './discrepancy.js';

export type CreditErrorCode =
  | 'credit_customer_required'
  | 'credit_overpay_required'
  | 'credit_insufficient'
  | 'credit_wrong_transfer'
  | 'credit_wrong_transfer_source'
  | 'credit_amount_fixed'
  | 'credit_grant_spent'
  | 'credit_grant_locked'
  | 'credit_customer_locked';

const CREDIT_MESSAGES: Record<CreditErrorCode, string> = {
  credit_customer_required: 'กรุณากรอกรหัสลูกค้าหรือชื่อลูกค้าก่อนยืนยันเครดิต',
  credit_overpay_required: 'สร้างเครดิตได้เฉพาะรายการยอดเกินที่มากกว่า 0',
  credit_insufficient: 'เครดิตลูกค้าคงเหลือไม่พอ',
  credit_wrong_transfer: 'รายการโอนเงินผิดไม่สามารถใช้เครดิตลูกค้าได้',
  credit_wrong_transfer_source: 'รายการใช้เครดิตล้วนไม่ใช่การโอนเงิน จึงทำเป็นโอนเงินผิดไม่ได้',
  credit_amount_fixed: 'รายการใช้เครดิตล้วนต้องมียอดรับเงินเท่ากับ 0',
  credit_grant_spent: 'เครดิตจากรายการนี้ถูกใช้ไปแล้ว',
  credit_grant_locked: 'กรุณายกเลิกยืนยันเครดิตก่อนแก้ยอดตามเอกสาร',
  credit_customer_locked: 'กรุณาล้างการใช้เครดิตหรือยกเลิกยืนยันเครดิตก่อนแก้ข้อมูลลูกค้า',
};

export class CustomerCreditError extends Error {
  constructor(public code: CreditErrorCode, public detail?: Record<string, unknown>, message = CREDIT_MESSAGES[code]) {
    super(message);
  }
}

export const creditErrorMessage = (code: CreditErrorCode): string => CREDIT_MESSAGES[code];

export function customerCreditKey(payment: Pick<Payment, 'customerCode' | 'customerName'>): string | null {
  return payment.customerCode.trim() || payment.customerName.trim() || null;
}

export type CreditTx = Prisma.TransactionClient;

export type DiscrepancyConfirmGateError = 'disc_confirm_needs_bank' | 'disc_confirm_needs_receive';

// Cash never enters bank reconciliation; credit-only sales have no new money to reconcile.
// Keep this shared constant at every route/query boundary so amount=0 can never be the accidental
// reason a credit row stays out of the matcher.
export const BANK_RECON_EXCLUDED_SOURCES = ['cash', 'credit'] as const;

export function isBankReconEligibleSource(source: string): boolean {
  return !BANK_RECON_EXCLUDED_SOURCES.some((excluded) => excluded === source);
}

export function assertWrongTransferSource(source: string): void {
  if (source === 'credit') throw new CustomerCreditError('credit_wrong_transfer_source');
}

export function discrepancyConfirmGate(
  payment: Pick<Payment, 'source' | 'reconciled' | 'receivedAt'>,
  bankLinkCount: number,
): DiscrepancyConfirmGateError | null {
  // The incoming money was bank-grounded when the original customer credit was granted.
  if (payment.source === 'credit') return null;
  if (payment.source === 'cash' || payment.source === 'cheque') {
    return payment.receivedAt ? null : 'disc_confirm_needs_receive';
  }
  return payment.reconciled || bankLinkCount > 0 ? null : 'disc_confirm_needs_bank';
}

export async function lockPayment(tx: CreditTx, paymentId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
}

export async function lockCustomer(tx: CreditTx, customerKey: string): Promise<void> {
  // ::text cast — pg_advisory_xact_lock returns void, which Prisma's $queryRaw cannot deserialize.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${customerKey}, 0))::text`;
}

export async function customerBalanceSatang(tx: CreditTx, customerKey: string, lock = true): Promise<number> {
  if (lock) await lockCustomer(tx, customerKey);
  const aggregate = await tx.customerCreditEntry.aggregate({
    where: { customerKey },
    _sum: { amountSatang: true },
  });
  return aggregate._sum.amountSatang ?? 0;
}

export async function grantCredit(
  tx: CreditTx,
  payment: Pick<Payment, 'id' | 'customerCode' | 'customerName'>,
  amountSatang: number,
  actor: string,
) {
  const existing = await tx.customerCreditEntry.findUnique({
    where: { paymentId_kind: { paymentId: payment.id, kind: 'grant' } },
  });
  if (existing) {
    await lockCustomer(tx, existing.customerKey);
    return existing;
  }
  if (amountSatang <= 0) throw new CustomerCreditError('credit_overpay_required');
  const customerKey = customerCreditKey(payment);
  if (!customerKey) throw new CustomerCreditError('credit_customer_required');
  await lockCustomer(tx, customerKey);
  return tx.customerCreditEntry.create({
    data: {
      customerKey,
      customerCode: payment.customerCode.trim(),
      customerName: payment.customerName.trim(),
      kind: 'grant',
      amountSatang,
      paymentId: payment.id,
      createdBy: actor,
    },
  });
}

export async function removeGrant(tx: CreditTx, paymentId: string, message?: string): Promise<boolean> {
  const grant = await tx.customerCreditEntry.findUnique({
    where: { paymentId_kind: { paymentId, kind: 'grant' } },
  });
  if (!grant) return false;
  await lockCustomer(tx, grant.customerKey);
  const balance = await customerBalanceSatang(tx, grant.customerKey, false);
  if (balance - grant.amountSatang < 0) {
    throw new CustomerCreditError('credit_grant_spent', undefined, message);
  }
  await tx.customerCreditEntry.delete({ where: { id: grant.id } });
  return true;
}

export async function replaceSpend(
  tx: CreditTx,
  payment: Pick<Payment, 'id' | 'customerCode' | 'customerName' | 'wrongTransferAt'>,
  requestedSatang: number,
  actor: string,
) {
  const current = await tx.customerCreditEntry.findUnique({
    where: { paymentId_kind: { paymentId: payment.id, kind: 'spend' } },
  });
  if (requestedSatang <= 0) {
    if (current) {
      await lockCustomer(tx, current.customerKey);
      await tx.customerCreditEntry.delete({ where: { id: current.id } });
    }
    return { amountSatang: 0, availableSatang: 0 };
  }
  if (payment.wrongTransferAt) throw new CustomerCreditError('credit_wrong_transfer');
  const customerKey = customerCreditKey(payment);
  if (!customerKey) throw new CustomerCreditError('credit_customer_required');
  await lockCustomer(tx, customerKey);
  const balance = await customerBalanceSatang(tx, customerKey, false);
  const availableSatang = balance - (current?.amountSatang ?? 0);
  if (requestedSatang > availableSatang) {
    const available = satangToBaht(Math.max(0, availableSatang));
    throw new CustomerCreditError(
      'credit_insufficient',
      { available },
      `เครดิตลูกค้าคงเหลือไม่พอ (ใช้ได้ ฿${available.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
    );
  }
  const entry = await tx.customerCreditEntry.upsert({
    where: { paymentId_kind: { paymentId: payment.id, kind: 'spend' } },
    create: {
      customerKey,
      customerCode: payment.customerCode.trim(),
      customerName: payment.customerName.trim(),
      kind: 'spend',
      amountSatang: -requestedSatang,
      paymentId: payment.id,
      createdBy: actor,
    },
    update: { amountSatang: -requestedSatang, updatedAt: new Date(), createdBy: actor },
  });
  return { entry, amountSatang: requestedSatang, availableSatang };
}

export async function releaseSpend(tx: CreditTx, paymentId: string): Promise<boolean> {
  const spend = await tx.customerCreditEntry.findUnique({
    where: { paymentId_kind: { paymentId, kind: 'spend' } },
  });
  if (!spend) return false;
  await lockCustomer(tx, spend.customerKey);
  await tx.customerCreditEntry.delete({ where: { id: spend.id } });
  return true;
}

export async function paymentHasCreditEntries(tx: CreditTx, paymentId: string): Promise<boolean> {
  return (await tx.customerCreditEntry.count({ where: { paymentId } })) > 0;
}

export async function paymentHasGrant(tx: CreditTx, paymentId: string): Promise<boolean> {
  return !!(await tx.customerCreditEntry.findUnique({
    where: { paymentId_kind: { paymentId, kind: 'grant' } }, select: { id: true },
  }));
}

export function normalizedCreditUsed(value: string): string {
  return moneyToSatang(value) > 0 ? value.trim() : '';
}

function paymentOrderTime(payment: Pick<Payment, 'transferAt' | 'createdAt'>): number {
  return paymentTimestamp(payment.transferAt, payment.createdAt).getTime();
}

/**
 * Spend a newly available pooled balance against pending use-credit discrepancies.
 * The caller already holds the same customer's advisory lock (grantCredit acquires it),
 * but replaceSpend deliberately reuses the normal spend path and its non-overdraw check.
 */
export async function netPendingUseCredit(
  tx: CreditTx,
  customerKey: string,
  actor: string,
): Promise<{ fullyCovered: string[]; partiallyCovered: string[] }> {
  const pending = await tx.payment.findMany({
    where: {
      status: { not: 'void' },
      discResolution: 'use_credit',
      discConfirmedAt: null,
      wrongTransferAt: null,
    },
    include: { bankMatches: { select: { id: true }, take: 1 } },
  });
  const candidates = pending
    .filter((payment) => payment.discResolution === 'use_credit'
      && payment.discConfirmedAt === null
      && payment.status !== 'void'
      && payment.wrongTransferAt === null
      && customerCreditKey(payment) === customerKey
      && !discrepancyConfirmGate(payment, payment.bankMatches.length))
    .sort((left, right) => paymentOrderTime(left) - paymentOrderTime(right) || left.createdAt.getTime() - right.createdAt.getTime());
  const fullyCovered: string[] = [];
  const partiallyCovered: string[] = [];

  for (const payment of candidates) {
    const discrepancy = await getDiscrepancyForPayment(tx, payment.id);
    if (!discrepancy) continue;
    if (discrepancy.diffSatang === 0) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { discConfirmedAt: new Date(), discConfirmedBy: actor },
      });
      fullyCovered.push(payment.id);
      continue;
    }
    if (discrepancy.diffSatang > 0) continue;

    const balance = await customerBalanceSatang(tx, customerKey, false);
    if (balance <= 0) break;
    const increment = Math.min(balance, -discrepancy.diffSatang);
    const totalSpend = moneyToSatang(payment.creditUsed) + increment;
    await replaceSpend(tx, payment, totalSpend, actor);
    const covered = increment === -discrepancy.diffSatang;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        creditUsed: satangToBaht(totalSpend).toFixed(2),
        ...(covered ? { discConfirmedAt: new Date(), discConfirmedBy: actor } : {}),
      },
    });
    (covered ? fullyCovered : partiallyCovered).push(payment.id);
  }
  return { fullyCovered, partiallyCovered };
}
