import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '../../db/prisma.js';
import { moneyToString, parseMoney } from './money.js';
import type {
  DraftLineInput,
  DraftValidationResult,
  LedgerActor,
  LedgerPostingErrorCode,
} from './types.js';

export class LedgerPostingError extends Error {
  constructor(
    public readonly code: LedgerPostingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerPostingError';
  }
}

const ENTRY_INCLUDE = Prisma.validator<Prisma.JupiterJournalEntryInclude>()({
  company: true,
  journal: true,
  partner: true,
  reversedBy: true,
  lines: {
    orderBy: { lineNo: 'asc' },
    include: { account: true, partner: true, taxes: true },
  },
});

type LoadedEntry = Prisma.JupiterJournalEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;
type LedgerTx = Prisma.TransactionClient;

export function validateDraftLines(lines: readonly DraftLineInput[]): DraftValidationResult {
  const seenLineNumbers = new Set<number>();
  let nonzeroLines = 0;
  let debitTotal = new Prisma.Decimal('0.00');
  let creditTotal = new Prisma.Decimal('0.00');

  const normalized = lines.map((line) => {
    if (!Number.isInteger(line.lineNo) || line.lineNo <= 0 || seenLineNumbers.has(line.lineNo)) {
      throw new LedgerPostingError('invalid_line', 'Line numbers must be unique positive integers');
    }
    seenLineNumbers.add(line.lineNo);
    if (!line.accountId.trim()) {
      throw new LedgerPostingError('invalid_line', `Line ${line.lineNo} has no account`);
    }

    const debit = parseMoney(line.debit, { allowNegative: false });
    const credit = parseMoney(line.credit, { allowNegative: false });
    if (debit.greaterThan(0) && credit.greaterThan(0)) {
      throw new LedgerPostingError('invalid_line', `Line ${line.lineNo} cannot contain both debit and credit`);
    }
    if (!debit.isZero() || !credit.isZero()) nonzeroLines += 1;
    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);

    return { ...line, debit, credit };
  });

  if (nonzeroLines < 2) {
    throw new LedgerPostingError('invalid_line', 'A journal entry requires at least two nonzero lines');
  }
  if (!debitTotal.equals(creditTotal)) {
    throw new LedgerPostingError(
      'unbalanced_entry',
      `Debits ${moneyToString(debitTotal)} do not equal credits ${moneyToString(creditTotal)}`,
    );
  }

  return { lines: normalized, debitTotal, creditTotal };
}

export function parseAccountingDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LedgerPostingError('invalid_entry_date', 'Accounting date must use YYYY-MM-DD');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || accountingDateString(date) !== value) {
    throw new LedgerPostingError('invalid_entry_date', `Invalid accounting date: ${value}`);
  }
  return date;
}

export function accountingDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function assertAfterLedgerLock(entryDate: Date, ledgerLockDate: Date | null): void {
  if (ledgerLockDate && accountingDateString(entryDate) <= accountingDateString(ledgerLockDate)) {
    throw new LedgerPostingError(
      'lock_date_violation',
      `Accounting date must be after lock date ${accountingDateString(ledgerLockDate)}`,
    );
  }
}

async function lockEntry(tx: LedgerTx, entryId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "JupiterJournalEntry" WHERE "id" = ${entryId} FOR UPDATE`);
}

async function loadEntry(tx: LedgerTx, entryId: string): Promise<LoadedEntry> {
  const entry = await tx.jupiterJournalEntry.findUnique({ where: { id: entryId }, include: ENTRY_INCLUDE });
  if (!entry) throw new LedgerPostingError('entry_not_found', `Journal entry ${entryId} was not found`);
  return entry;
}

function validateLoadedDraft(entry: LoadedEntry): DraftValidationResult {
  if (entry.state !== 'draft') {
    throw new LedgerPostingError('entry_not_draft', 'Only a draft journal entry can be posted');
  }
  if (entry.company.ledgerMode === 'paper_only') {
    throw new LedgerPostingError('paper_only_company', `${entry.companyCode} is paper-only and cannot post entries`);
  }
  assertAfterLedgerLock(entry.entryDate, entry.company.ledgerLockDate);

  if (!entry.journal || entry.journal.companyCode !== entry.companyCode) {
    throw new LedgerPostingError('invalid_reference', 'Journal must exist and belong to the entry company');
  }
  if (entry.partnerId && !entry.partner) {
    throw new LedgerPostingError('invalid_reference', 'Entry partner does not exist');
  }
  for (const line of entry.lines) {
    if (!line.account || line.account.companyCode !== entry.companyCode) {
      throw new LedgerPostingError(
        'invalid_reference',
        `Account on line ${line.lineNo} must exist and belong to the entry company`,
      );
    }
    if (line.partnerId && !line.partner) {
      throw new LedgerPostingError('invalid_reference', `Partner on line ${line.lineNo} does not exist`);
    }
  }

  return validateDraftLines(entry.lines.map((line) => ({
    lineNo: line.lineNo,
    accountId: line.accountId,
    partnerId: line.partnerId,
    label: line.label,
    debit: moneyToString(line.debit),
    credit: moneyToString(line.credit),
  })));
}

function entrySnapshot(entry: LoadedEntry): Prisma.InputJsonValue {
  return {
    id: entry.id,
    companyCode: entry.companyCode,
    journalId: entry.journalId,
    entryNo: entry.entryNo,
    entryDate: accountingDateString(entry.entryDate),
    state: entry.state,
    version: entry.version,
    reversalOfId: entry.reversalOfId,
    lines: entry.lines.map((line) => ({
      id: line.id,
      lineNo: line.lineNo,
      accountId: line.accountId,
      partnerId: line.partnerId,
      debit: moneyToString(line.debit),
      credit: moneyToString(line.credit),
    })),
  } as Prisma.InputJsonValue;
}

function actorAuditFields(actor: LedgerActor): Pick<
  Prisma.JupiterLedgerAuditUncheckedCreateInput,
  'actorId' | 'actorName' | 'requestId'
> {
  return {
    actorId: actor.id ?? null,
    actorName: actor.name ?? '',
    requestId: actor.requestId ?? null,
  };
}

async function assignEntryNumber(tx: LedgerTx, entry: LoadedEntry): Promise<string> {
  if (entry.entryNo) return entry.entryNo;
  const fiscalYear = entry.entryDate.getUTCFullYear();
  const sequence = await tx.jupiterJournalSequence.upsert({
    where: {
      companyCode_journalId_fiscalYear: {
        companyCode: entry.companyCode,
        journalId: entry.journalId,
        fiscalYear,
      },
    },
    create: { companyCode: entry.companyCode, journalId: entry.journalId, fiscalYear, nextNo: 2 },
    update: { nextNo: { increment: 1 } },
    select: { nextNo: true },
  });
  const assigned = sequence.nextNo - 1;
  return `${entry.journal.code}/${fiscalYear}/${String(assigned).padStart(6, '0')}`;
}

async function postInTransaction(
  tx: LedgerTx,
  entryId: string,
  actor: LedgerActor,
  expectedVersion?: number,
): Promise<LoadedEntry> {
  await lockEntry(tx, entryId);
  const before = await loadEntry(tx, entryId);
  if (expectedVersion !== undefined && before.version !== expectedVersion) {
    throw new LedgerPostingError('stale_version', `Expected version ${expectedVersion}, found ${before.version}`);
  }
  validateLoadedDraft(before);
  const entryNo = await assignEntryNumber(tx, before);
  const postedAt = new Date();

  await tx.jupiterJournalEntry.update({
    where: { id: entryId },
    data: {
      state: 'posted',
      entryNo,
      postedById: actor.id ?? null,
      postedByName: actor.name ?? '',
      postedAt,
      version: { increment: 1 },
    },
  });
  const after = await loadEntry(tx, entryId);
  await tx.jupiterLedgerAudit.create({
    data: {
      companyCode: after.companyCode,
      entityType: 'entry',
      entityId: after.id,
      action: 'post',
      before: entrySnapshot(before),
      after: entrySnapshot(after),
      ...actorAuditFields(actor),
    },
  });
  return after;
}

export async function postJournalEntry(
  entryId: string,
  actor: LedgerActor,
  client: PrismaClient = prisma,
  expectedVersion?: number,
): Promise<LoadedEntry> {
  return client.$transaction(
    (tx) => postInTransaction(tx, entryId, actor, expectedVersion),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function reverseJournalEntry(
  entryId: string,
  reversalDate: string,
  reason: string,
  actor: LedgerActor,
  client: PrismaClient = prisma,
  expectedVersion?: number,
): Promise<LoadedEntry> {
  if (!reason.trim()) throw new LedgerPostingError('reason_required', 'A reversal reason is required');
  const parsedDate = parseAccountingDate(reversalDate);

  return client.$transaction(async (tx) => {
    await lockEntry(tx, entryId);
    const original = await loadEntry(tx, entryId);
    if (expectedVersion !== undefined && original.version !== expectedVersion) {
      throw new LedgerPostingError('stale_version', `Expected version ${expectedVersion}, found ${original.version}`);
    }
    if (original.state !== 'posted') {
      throw new LedgerPostingError('entry_not_posted', 'Only a posted journal entry can be reversed');
    }
    if (original.reversedBy) {
      throw new LedgerPostingError('entry_already_reversed', 'This journal entry already has a reversal');
    }
    if (original.company.ledgerMode === 'paper_only') {
      throw new LedgerPostingError('paper_only_company', `${original.companyCode} is paper-only`);
    }
    assertAfterLedgerLock(parsedDate, original.company.ledgerLockDate);

    const reversal = await tx.jupiterJournalEntry.create({
      data: {
        companyCode: original.companyCode,
        journalId: original.journalId,
        entryDate: parsedDate,
        entryType: 'reversal',
        ref: `Reversal of ${original.entryNo ?? original.id}`,
        memo: reason.trim(),
        partnerId: original.partnerId,
        documentNo: original.documentNo,
        documentDate: original.documentDate,
        dueDate: original.dueDate,
        paymentReference: original.paymentReference,
        currencyCode: original.currencyCode,
        reversalOfId: original.id,
        createdById: actor.id ?? null,
        createdByName: actor.name ?? '',
        lines: {
          create: original.lines.map((line) => ({
            lineNo: line.lineNo,
            accountId: line.accountId,
            partnerId: line.partnerId,
            label: line.label,
            debit: line.credit,
            credit: line.debit,
            amountCurrency: line.amountCurrency?.negated(),
            currencyCode: line.currencyCode,
            maturityDate: line.maturityDate,
            taxes: {
              create: line.taxes.map((tax) => ({
                taxId: tax.taxId,
                role: tax.role,
                baseAmount: tax.baseAmount?.negated(),
                taxAmount: tax.taxAmount?.negated(),
              })),
            },
          })),
        },
      },
      select: { id: true },
    });

    await tx.jupiterLedgerAudit.create({
      data: {
        companyCode: original.companyCode,
        entityType: 'entry',
        entityId: original.id,
        action: 'reverse',
        reason: reason.trim(),
        before: entrySnapshot(original),
        after: { reversalEntryId: reversal.id, reversalDate },
        ...actorAuditFields(actor),
      },
    });
    return postInTransaction(tx, reversal.id, actor);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function voidJournalEntry(
  entryId: string,
  reason: string,
  actor: LedgerActor,
  client: PrismaClient = prisma,
  expectedVersion?: number,
): Promise<LoadedEntry> {
  return client.$transaction(async (tx) => {
    await lockEntry(tx, entryId);
    const before = await loadEntry(tx, entryId);
    if (expectedVersion !== undefined && before.version !== expectedVersion) {
      throw new LedgerPostingError('stale_version', `Expected version ${expectedVersion}, found ${before.version}`);
    }
    if (before.state !== 'draft') {
      throw new LedgerPostingError('entry_not_draft', 'Only a draft journal entry can be voided');
    }
    assertAfterLedgerLock(before.entryDate, before.company.ledgerLockDate);
    const voidedAt = new Date();
    await tx.jupiterJournalEntry.update({
      where: { id: entryId },
      data: { state: 'void', voidedAt, version: { increment: 1 } },
    });
    const after = await loadEntry(tx, entryId);
    await tx.jupiterLedgerAudit.create({
      data: {
        companyCode: after.companyCode,
        entityType: 'entry',
        entityId: after.id,
        action: 'void',
        reason: reason.trim(),
        before: entrySnapshot(before),
        after: entrySnapshot(after),
        ...actorAuditFields(actor),
      },
    });
    return after;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function setLedgerLockDate(
  companyCode: string,
  lockDate: string | null,
  reason: string,
  actor: LedgerActor,
  client: PrismaClient = prisma,
): Promise<void> {
  const parsed = lockDate === null ? null : parseAccountingDate(lockDate);
  await client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "code" FROM "JupiterCompany" WHERE "code" = ${companyCode} FOR UPDATE`);
    const company = await tx.jupiterCompany.findUnique({ where: { code: companyCode } });
    if (!company) throw new LedgerPostingError('invalid_reference', `Company ${companyCode} was not found`);

    const oldDate = company.ledgerLockDate ? accountingDateString(company.ledgerLockDate) : null;
    const movingBackward = oldDate !== null && (lockDate === null || lockDate < oldDate);
    if (movingBackward && !reason.trim()) {
      throw new LedgerPostingError('reason_required', 'Moving the ledger lock backward requires a reason');
    }

    await tx.jupiterCompany.update({ where: { code: companyCode }, data: { ledgerLockDate: parsed } });
    await tx.jupiterLedgerAudit.create({
      data: {
        companyCode,
        entityType: 'company_lock',
        entityId: companyCode,
        action: 'lock_change',
        reason: reason.trim(),
        before: { ledgerLockDate: oldDate },
        after: { ledgerLockDate: lockDate },
        ...actorAuditFields(actor),
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
