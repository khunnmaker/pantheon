import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireAuth, requireRole } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { LedgerMoneyError, moneyToString, parseMoney } from '../jupiter/ledger/money.js';
import {
  LedgerPostingError, accountingDateString, assertAfterLedgerLock, parseAccountingDate,
  postJournalEntry, reverseJournalEntry, voidJournalEntry,
} from '../jupiter/ledger/posting.js';
import {
  generalLedger, generalLedgerCsv, partnerLedger, partnerLedgerCsv, trialBalance, trialBalanceCsv,
} from '../jupiter/ledger/reports.js';
import { JOURNAL_ENTRY_STATES, LEDGER_MODES, validateDraftLines } from '../jupiter/ledger/index.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must use YYYY-MM-DD');
const nullableDateString = dateString.nullable().optional();
const moneyString = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/, 'must be a two-decimal String');
const nonnegativeMoneyString = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/, 'must be a non-negative two-decimal String');
const idString = z.string().min(1).max(100);

const taxInputSchema = z.object({
  taxId: idString,
  role: z.enum(['applied', 'tax_line']).default('applied'),
  baseAmount: moneyString.nullable().optional(),
  taxAmount: moneyString.nullable().optional(),
}).strict();

const lineInputSchema = z.object({
  lineNo: z.number().int().positive(),
  accountId: idString,
  partnerId: idString.nullable().optional(),
  label: z.string().max(1000).default(''),
  debit: nonnegativeMoneyString,
  credit: nonnegativeMoneyString,
  taxes: z.array(taxInputSchema).default([]),
}).strict();

export const journalEntryBodySchema = z.object({
  companyCode: z.string().min(1).max(20),
  journalId: idString,
  entryDate: dateString,
  ref: z.string().max(500).default(''),
  memo: z.string().max(5000).default(''),
  partnerId: idString.nullable().optional(),
  documentNo: z.string().max(200).default(''),
  documentDate: nullableDateString,
  dueDate: nullableDateString,
  paymentReference: z.string().max(500).default(''),
  taxInvoiceNo: z.string().max(200).default(''),
  taxInvoiceDate: nullableDateString,
  whtCertificateNo: z.string().max(200).default(''),
  version: z.number().int().positive().optional(),
  lines: z.array(lineInputSchema).min(2).max(1000),
}).strict();

const entryInclude = Prisma.validator<Prisma.JupiterJournalEntryInclude>()({
  journal: true,
  partner: true,
  reversalOf: { select: { id: true, entryNo: true } },
  reversedBy: { select: { id: true, entryNo: true } },
  lines: { orderBy: { lineNo: 'asc' }, include: { account: true, partner: true, taxes: { include: { tax: true } } } },
});

type LoadedRouteEntry = Prisma.JupiterJournalEntryGetPayload<{ include: typeof entryInclude }>;

function serializeEntry(entry: LoadedRouteEntry) {
  return {
    ...entry,
    entryDate: accountingDateString(entry.entryDate),
    documentDate: entry.documentDate ? accountingDateString(entry.documentDate) : null,
    dueDate: entry.dueDate ? accountingDateString(entry.dueDate) : null,
    taxInvoiceDate: entry.taxInvoiceDate ? accountingDateString(entry.taxInvoiceDate) : null,
    lines: entry.lines.map((line) => ({
      ...line,
      debit: moneyToString(line.debit), credit: moneyToString(line.credit),
      amountCurrency: line.amountCurrency ? moneyToString(line.amountCurrency) : null,
      maturityDate: line.maturityDate ? accountingDateString(line.maturityDate) : null,
      taxes: line.taxes.map((tax) => ({
        ...tax,
        tax: 'tax' in tax && tax.tax ? { ...tax.tax, rate: tax.tax.rate.toFixed(6) } : undefined,
        baseAmount: tax.baseAmount ? moneyToString(tax.baseAmount) : null,
        taxAmount: tax.taxAmount ? moneyToString(tax.taxAmount) : null,
      })),
    })),
  };
}

function requestActor(req: FastifyRequest) {
  return { id: req.agent?.id, name: req.agent?.name, requestId: req.id };
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof LedgerMoneyError) {
    return reply.code(400).send({ error: error.code, message: error.message });
  }
  if (error instanceof LedgerPostingError) {
    if (error.code === 'entry_not_found') return reply.code(404).send({ error: error.code, message: error.message });
    const conflicts = new Set([
      'stale_version', 'entry_not_draft', 'entry_not_posted', 'entry_already_reversed',
      'lock_date_violation', 'posted_source_conflict',
    ]);
    return reply.code(conflicts.has(error.code) ? 409 : 400).send({ error: error.code, message: error.message });
  }
  throw error;
}

function parseDate(value: string | null | undefined) {
  return value ? parseAccountingDate(value) : null;
}

function snapshot(entry: LoadedRouteEntry): Prisma.InputJsonValue {
  return serializeEntry(entry) as unknown as Prisma.InputJsonValue;
}

async function validateReferences(
  tx: Prisma.TransactionClient,
  body: z.infer<typeof journalEntryBodySchema>,
) {
  const company = await tx.jupiterCompany.findUnique({ where: { code: body.companyCode } });
  if (!company) throw new LedgerPostingError('invalid_reference', `Company ${body.companyCode} was not found`);
  if (company.ledgerMode === 'paper_only') throw new LedgerPostingError('paper_only_company', `${body.companyCode} is paper-only`);
  const entryDate = parseAccountingDate(body.entryDate);
  assertAfterLedgerLock(entryDate, company.ledgerLockDate);
  const journal = await tx.jupiterLedgerJournal.findUnique({ where: { id: body.journalId } });
  if (!journal || journal.companyCode !== body.companyCode) {
    throw new LedgerPostingError('invalid_reference', 'Journal must belong to the entry company');
  }
  const accountIds = [...new Set(body.lines.map((line) => line.accountId))];
  const accounts = await tx.jupiterLedgerAccount.findMany({ where: { id: { in: accountIds }, companyCode: body.companyCode } });
  if (accounts.length !== accountIds.length) throw new LedgerPostingError('invalid_reference', 'Every account must belong to the entry company');
  const partnerIds = [...new Set([body.partnerId, ...body.lines.map((line) => line.partnerId)].filter((id): id is string => Boolean(id)))];
  if (partnerIds.length && await tx.jupiterLedgerPartner.count({ where: { id: { in: partnerIds } } }) !== partnerIds.length) {
    throw new LedgerPostingError('invalid_reference', 'One or more partners do not exist');
  }
  const taxIds = [...new Set(body.lines.flatMap((line) => line.taxes.map((tax) => tax.taxId)))];
  if (taxIds.length && await tx.jupiterLedgerTax.count({ where: { id: { in: taxIds }, companyCode: body.companyCode } }) !== taxIds.length) {
    throw new LedgerPostingError('invalid_reference', 'Every tax must belong to the entry company');
  }
  validateDraftLines(body.lines);
}

function lineCreates(lines: z.infer<typeof lineInputSchema>[]) {
  return lines.map((line) => ({
    lineNo: line.lineNo, accountId: line.accountId, partnerId: line.partnerId ?? null, label: line.label,
    debit: parseMoney(line.debit, { allowNegative: false }), credit: parseMoney(line.credit, { allowNegative: false }),
    taxes: { create: line.taxes.map((tax) => ({
      taxId: tax.taxId, role: tax.role,
      baseAmount: tax.baseAmount ? parseMoney(tax.baseAmount) : null,
      taxAmount: tax.taxAmount ? parseMoney(tax.taxAmount) : null,
    })) },
  }));
}

function headerData(body: z.infer<typeof journalEntryBodySchema>) {
  return {
    companyCode: body.companyCode, journalId: body.journalId, entryDate: parseAccountingDate(body.entryDate),
    ref: body.ref, memo: body.memo, partnerId: body.partnerId ?? null, documentNo: body.documentNo,
    documentDate: parseDate(body.documentDate), dueDate: parseDate(body.dueDate), paymentReference: body.paymentReference,
    taxInvoiceNo: body.taxInvoiceNo, taxInvoiceDate: parseDate(body.taxInvoiceDate), whtCertificateNo: body.whtCertificateNo,
  };
}

export async function jupiterLedgerRoutes(app: FastifyInstance) {
  const gate = { preHandler: [requireAuth, requireRole('supervisor')] };

  app.get('/api/jupiter/acct/accounts', gate, async (req, reply) => {
    const parsed = z.object({ company: z.string().min(1), active: z.enum(['true', 'false']).optional() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    return prisma.jupiterLedgerAccount.findMany({
      where: { companyCode: parsed.data.company, active: parsed.data.active === undefined ? undefined : parsed.data.active === 'true' },
      orderBy: { code: 'asc' },
    });
  });

  app.get('/api/jupiter/acct/journals', gate, async (req, reply) => {
    const parsed = z.object({ company: z.string().min(1), active: z.enum(['true', 'false']).optional() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    return prisma.jupiterLedgerJournal.findMany({
      where: { companyCode: parsed.data.company, active: parsed.data.active === undefined ? undefined : parsed.data.active === 'true' },
      orderBy: { code: 'asc' },
    });
  });

  app.get('/api/jupiter/acct/partners', gate, async (req, reply) => {
    const parsed = z.object({ search: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const search = parsed.data.search?.trim();
    return prisma.jupiterLedgerPartner.findMany({
      where: search ? { OR: [
        { displayName: { contains: search, mode: 'insensitive' } }, { legalName: { contains: search, mode: 'insensitive' } }, { taxId: { contains: search } },
      ] } : undefined,
      orderBy: { displayName: 'asc' }, take: parsed.data.limit,
    });
  });

  app.get('/api/jupiter/acct/taxes', gate, async (req, reply) => {
    const parsed = z.object({ company: z.string().min(1), active: z.enum(['true', 'false']).optional() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const rows = await prisma.jupiterLedgerTax.findMany({
      where: { companyCode: parsed.data.company, active: parsed.data.active === undefined ? undefined : parsed.data.active === 'true' },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({ ...row, rate: row.rate.toFixed(6) }));
  });

  app.get('/api/jupiter/acct/entries', gate, async (req, reply) => {
    const parsed = z.object({
      company: z.string().optional(), from: dateString.optional(), to: dateString.optional(),
      state: z.enum(JOURNAL_ENTRY_STATES).optional(), journal: z.string().optional(), account: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().optional(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const q = parsed.data;
      const rows = await prisma.jupiterJournalEntry.findMany({
        where: {
          companyCode: q.company, state: q.state,
          journal: q.journal ? { is: { OR: [{ id: q.journal }, { code: q.journal }] } } : undefined,
          entryDate: q.from || q.to ? { gte: q.from ? parseAccountingDate(q.from) : undefined, lte: q.to ? parseAccountingDate(q.to) : undefined } : undefined,
          lines: q.account ? { some: { account: { is: { OR: [{ id: q.account }, { code: q.account }] } } } } : undefined,
        },
        include: entryInclude, orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        take: q.limit + 1, cursor: q.cursor ? { id: q.cursor } : undefined, skip: q.cursor ? 1 : 0,
      });
      const hasMore = rows.length > q.limit;
      if (hasMore) rows.pop();
      return { items: rows.map(serializeEntry), nextCursor: hasMore ? rows.at(-1)?.id ?? null : null };
    } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/jupiter/acct/entries/:id', gate, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await prisma.jupiterJournalEntry.findUnique({ where: { id }, include: entryInclude });
    return entry ? serializeEntry(entry) : reply.code(404).send({ error: 'entry_not_found' });
  });

  app.post('/api/jupiter/acct/entries', gate, async (req, reply) => {
    const parsed = journalEntryBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const entry = await prisma.$transaction(async (tx) => {
        await validateReferences(tx, parsed.data);
        const created = await tx.jupiterJournalEntry.create({
          data: { ...headerData(parsed.data), createdById: req.agent?.id, createdByName: req.agent?.name ?? '', lines: { create: lineCreates(parsed.data.lines) } },
          include: entryInclude,
        });
        await tx.jupiterLedgerAudit.create({ data: {
          companyCode: created.companyCode, entityType: 'entry', entityId: created.id, action: 'create', after: snapshot(created),
          actorId: req.agent?.id, actorName: req.agent?.name ?? '', requestId: req.id,
        } });
        return created;
      });
      return reply.code(201).send(serializeEntry(entry));
    } catch (error) { return sendError(reply, error); }
  });

  app.patch('/api/jupiter/acct/entries/:id', gate, async (req, reply) => {
    const parsed = journalEntryBodySchema.extend({ version: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    try {
      const entry = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "JupiterJournalEntry" WHERE "id" = ${id} FOR UPDATE`);
        const before = await tx.jupiterJournalEntry.findUnique({ where: { id }, include: entryInclude });
        if (!before) throw new LedgerPostingError('entry_not_found', `Journal entry ${id} was not found`);
        if (before.state !== 'draft') throw new LedgerPostingError('entry_not_draft', 'Only drafts can be edited');
        if (before.version !== parsed.data.version) throw new LedgerPostingError('stale_version', `Expected version ${parsed.data.version}, found ${before.version}`);
        if (before.companyCode !== parsed.data.companyCode) throw new LedgerPostingError('invalid_reference', 'An entry cannot change company');
        await validateReferences(tx, parsed.data);
        await tx.jupiterJournalLineTax.deleteMany({ where: { line: { entryId: id } } });
        await tx.jupiterJournalLine.deleteMany({ where: { entryId: id } });
        const after = await tx.jupiterJournalEntry.update({
          where: { id }, data: { ...headerData(parsed.data), version: { increment: 1 }, lines: { create: lineCreates(parsed.data.lines) } }, include: entryInclude,
        });
        await tx.jupiterLedgerAudit.create({ data: {
          companyCode: after.companyCode, entityType: 'entry', entityId: id, action: 'edit_draft', before: snapshot(before), after: snapshot(after),
          actorId: req.agent?.id, actorName: req.agent?.name ?? '', requestId: req.id,
        } });
        return after;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return serializeEntry(entry);
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/jupiter/acct/entries/:id/post', gate, async (req, reply) => {
    const parsed = z.object({ version: z.number().int().positive() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const entry = await postJournalEntry((req.params as { id: string }).id, requestActor(req), prisma, parsed.data.version);
      return serializeEntry(entry as unknown as LoadedRouteEntry);
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/jupiter/acct/entries/:id/reverse', gate, async (req, reply) => {
    const parsed = z.object({ version: z.number().int().positive(), reversalDate: dateString, reason: z.string().min(1).max(2000) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const entry = await reverseJournalEntry(
        (req.params as { id: string }).id, parsed.data.reversalDate, parsed.data.reason, requestActor(req), prisma, parsed.data.version,
      );
      return serializeEntry(entry as unknown as LoadedRouteEntry);
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/jupiter/acct/entries/:id/void', gate, async (req, reply) => {
    const parsed = z.object({ version: z.number().int().positive(), reason: z.string().max(2000).default('') }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const entry = await voidJournalEntry((req.params as { id: string }).id, parsed.data.reason, requestActor(req), prisma, parsed.data.version);
      return serializeEntry(entry as unknown as LoadedRouteEntry);
    } catch (error) { return sendError(reply, error); }
  });

  app.patch('/api/jupiter/acct/companies/:code/ledger-settings', gate, async (req, reply) => {
    const parsed = z.object({
      mode: z.enum(LEDGER_MODES).optional(), cutoverDate: nullableDateString, lockDate: nullableDateString,
      reason: z.string().max(2000).default(''),
    }).strict().refine((body) => body.mode !== undefined || body.cutoverDate !== undefined || body.lockDate !== undefined, 'no settings supplied').safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const { code } = req.params as { code: string };
    try {
      const company = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "code" FROM "JupiterCompany" WHERE "code" = ${code} FOR UPDATE`);
        const before = await tx.jupiterCompany.findUnique({ where: { code } });
        if (!before) throw new LedgerPostingError('invalid_reference', `Company ${code} was not found`);
        const nextLock = parsed.data.lockDate === undefined ? before.ledgerLockDate : parseDate(parsed.data.lockDate);
        const oldLock = before.ledgerLockDate ? accountingDateString(before.ledgerLockDate) : null;
        const nextLockString = nextLock ? accountingDateString(nextLock) : null;
        if (parsed.data.lockDate !== undefined && oldLock !== null && (nextLockString === null || nextLockString < oldLock) && !parsed.data.reason.trim()) {
          throw new LedgerPostingError('reason_required', 'Moving the ledger lock backward requires a reason');
        }
        const after = await tx.jupiterCompany.update({ where: { code }, data: {
          ledgerMode: parsed.data.mode, ledgerCutoverDate: parsed.data.cutoverDate === undefined ? undefined : parseDate(parsed.data.cutoverDate),
          ledgerLockDate: parsed.data.lockDate === undefined ? undefined : nextLock,
        } });
        await tx.jupiterLedgerAudit.create({ data: {
          companyCode: code, entityType: 'company_lock', entityId: code, action: 'lock_change', reason: parsed.data.reason,
          before: { ledgerMode: before.ledgerMode, ledgerCutoverDate: before.ledgerCutoverDate?.toISOString().slice(0, 10) ?? null, ledgerLockDate: oldLock },
          after: { ledgerMode: after.ledgerMode, ledgerCutoverDate: after.ledgerCutoverDate?.toISOString().slice(0, 10) ?? null, ledgerLockDate: nextLockString },
          actorId: req.agent?.id, actorName: req.agent?.name ?? '', requestId: req.id,
        } });
        return after;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return {
        code: company.code, mode: company.ledgerMode,
        cutoverDate: company.ledgerCutoverDate ? accountingDateString(company.ledgerCutoverDate) : null,
        lockDate: company.ledgerLockDate ? accountingDateString(company.ledgerLockDate) : null,
      };
    } catch (error) { return sendError(reply, error); }
  });

  const reportQuery = z.object({
    company: z.string().min(1), from: dateString.optional(), to: dateString.optional(), format: z.enum(['json', 'csv']).default('json'),
  });
  app.get('/api/jupiter/acct/reports/gl', gate, async (req, reply) => {
    const parsed = reportQuery.extend({ state: z.enum(JOURNAL_ENTRY_STATES).default('posted') }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const rows = await generalLedger({ companyCode: parsed.data.company, from: parsed.data.from, to: parsed.data.to, state: parsed.data.state });
      if (parsed.data.format === 'csv') return reply.type('text/csv; charset=utf-8').send(generalLedgerCsv(rows));
      return { company: parsed.data.company, rows };
    } catch (error) { return sendError(reply, error); }
  });
  app.get('/api/jupiter/acct/reports/trial-balance', gate, async (req, reply) => {
    const parsed = reportQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const rows = await trialBalance({ companyCode: parsed.data.company, from: parsed.data.from, to: parsed.data.to });
      if (parsed.data.format === 'csv') return reply.type('text/csv; charset=utf-8').send(trialBalanceCsv(rows));
      return { company: parsed.data.company, rows };
    } catch (error) { return sendError(reply, error); }
  });
  app.get('/api/jupiter/acct/reports/partner-ledger', gate, async (req, reply) => {
    const parsed = reportQuery.extend({ partnerId: z.string().optional() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    try {
      const rows = await partnerLedger({ companyCode: parsed.data.company, from: parsed.data.from, to: parsed.data.to, partnerId: parsed.data.partnerId });
      if (parsed.data.format === 'csv') return reply.type('text/csv; charset=utf-8').send(partnerLedgerCsv(rows));
      return { company: parsed.data.company, rows };
    } catch (error) { return sendError(reply, error); }
  });
}
