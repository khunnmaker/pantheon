import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { requireCeresRole } from '../../ceres/auth.js';
import { parseKbiz } from '../../bank/parseKbiz.js';
import { BankParseError, type ParsedBankRow } from '../../bank/types.js';
import { makeUniqueDedupeKeys } from '../../bank/dedupe.js';
import { saveStatementFile } from '../../ceres/statementStore.js';
import { num, thaiDayKey, thaiDayRange } from './common.js';

// P5 — bank statement import + reconciliation. Nee uploads the KBIZ CSV export from
// Ceres's SEPARATE expense bank account (same file format Juno uses for the income
// account) every day; Ceres auto-matches statement lines against recorded P2/P3
// payments (CeresPaymentRequest) and P4 top-ups (CashMovement), flagging unmatched
// lines both ways. See docs/CERES_BRIEF.md §2 P5 / §6.

interface StagedRow extends ParsedBankRow {
  dedupeKey: string;
  isNew: boolean;
}
interface StagedImport {
  fileName: string;
  fileSha256: string;
  buf: Buffer;
  rows: StagedRow[];
  periodFrom: string;
  periodTo: string;
  counts: { parsed: number; excluded: number };
  at: number;
}

// In-memory preview-token stash — mirrors routes/stock.ts's pattern exactly (TTL +
// cap, evict oldest over cap, crypto-random token). Lost on restart (harmless:
// re-upload). Small + short-lived; never holds more than PREVIEW_CAP entries.
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CAP = 5;
const previews = new Map<string, StagedImport>();
function stash(s: StagedImport): string {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.at > PREVIEW_TTL_MS) previews.delete(k);
  while (previews.size >= PREVIEW_CAP) previews.delete(previews.keys().next().value as string);
  const token = randomUUID();
  previews.set(token, s);
  return token;
}

// Dedupe keys come from the SHARED bank module (api/src/bank/dedupe.ts) so Ceres and
// Juno hash statement lines identically — sha256("kbiz|txnAt ISO|amount|details") with
// a "|n" suffix on within-file collisions.
function makeDedupeKeys(rows: ParsedBankRow[]): string[] {
  return makeUniqueDedupeKeys(rows.map((r) => ({ source: 'kbiz' as const, txnAt: r.txnAt, amount: r.amount, details: r.details })));
}

const DAY_MS = 24 * 3600 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

type TransferEvent = Awaited<ReturnType<typeof prisma.ceresRequestMoneyEvent.findMany>>[number];

function transferEventDirection(event: TransferEvent, byId: ReadonlyMap<string, TransferEvent>): 'in' | 'out' | null {
  if (event.kind === 'payment' || event.kind === 'purchase') return 'out';
  if (event.kind === 'refund') return 'in';
  if (event.kind !== 'reversal' || !event.reversesEventId) return null;
  const reversed = byId.get(event.reversesEventId);
  if (!reversed) return null;
  const original = transferEventDirection(reversed, byId);
  return original === 'out' ? 'in' : original === 'in' ? 'out' : null;
}

async function autoMatchTransferEvents(lineIds?: string[]): Promise<number> {
  const allLines = await prisma.ceresStatementLine.findMany({
    where: { matchStatus: 'unmatched', refText: '', direction: { in: ['in', 'out'] } },
  });
  if (allLines.length === 0) return 0;
  const scope = lineIds ? new Set(lineIds) : null;
  const scopedLines = scope ? allLines.filter((line) => scope.has(line.id)) : allLines;
  if (scopedLines.length === 0) return 0;

  const events = await prisma.ceresRequestMoneyEvent.findMany({
    where: { lane: 'transfer' },
    orderBy: { createdAt: 'asc' },
  });
  const eventMap = new Map(events.map((event) => [event.id, event]));
  const alreadyLinked = await prisma.ceresStatementLine.findMany({
    where: { matchedType: 'requestMoneyEvent', matchedId: { not: '' } },
    select: { matchedId: true },
  });
  const unavailable = new Set(alreadyLinked.map((line) => line.matchedId));
  const [legacyRequests, cashTargets, linkedLegacyRequests, linkedCashTargets] = await Promise.all([
    prisma.ceresPaymentRequest.findMany({ where: { workflowVersion: 1, status: 'paid' } }),
    prisma.cashMovement.findMany({ where: { type: { in: ['topup', 'deposit'] } } }),
    prisma.ceresStatementLine.findMany({
      where: { matchedType: 'paymentRequest', matchedId: { not: '' } },
      select: { matchedId: true },
    }),
    prisma.ceresStatementLine.findMany({
      where: { matchedType: 'cashMovement', matchedId: { not: '' } },
      select: { matchedId: true },
    }),
  ]);
  const linkedLegacyIds = new Set(linkedLegacyRequests.map((line) => line.matchedId));
  const linkedCashIds = new Set(linkedCashTargets.map((line) => line.matchedId));
  let linked = 0;

  for (const line of scopedLines) {
    const hasLegacyCandidate = line.direction === 'out'
      ? legacyRequests.some((request) =>
          !linkedLegacyIds.has(request.id) && request.paidAt && num(request.amount) === num(line.amount) &&
          Math.abs(line.txnAt.getTime() - request.paidAt.getTime()) <= 3 * DAY_MS,
        )
      : cashTargets.some((movement) =>
          !linkedCashIds.has(movement.id) && num(movement.amount) === num(line.amount) &&
          Math.abs(line.txnAt.getTime() - movement.createdAt.getTime()) <= 3 * DAY_MS,
        );
    if (hasLegacyCandidate) continue;
    const candidates = events.filter((event) =>
      !unavailable.has(event.id) &&
      transferEventDirection(event, eventMap) === line.direction &&
      num(event.amount) === num(line.amount) &&
      Math.abs(line.txnAt.getTime() - event.createdAt.getTime()) <= 3 * DAY_MS,
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const reverseCandidates = allLines.filter((other) =>
      other.direction === line.direction &&
      num(other.amount) === num(candidate.amount) &&
      Math.abs(other.txnAt.getTime() - candidate.createdAt.getTime()) <= 3 * DAY_MS,
    );
    if (reverseCandidates.length !== 1 || reverseCandidates[0].id !== line.id) continue;

    let updated;
    try {
      updated = await prisma.ceresStatementLine.updateMany({
        where: { id: line.id, matchStatus: 'unmatched', matchedId: '' },
        data: {
          matchedType: 'requestMoneyEvent',
          matchedId: candidate.id,
          matchStatus: 'matched',
          reconciledById: null,
          reconciledAt: new Date(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    if (updated.count === 1) {
      unavailable.add(candidate.id);
      linked++;
    }
  }
  return linked;
}

// Shared internal auto-matcher — used by both POST /apply (over just-inserted lines)
// and POST /automatch (over every currently-unmatched line). See CERES_BRIEF §2 P5.
async function autoMatchLines(lineIds?: string[]): Promise<number> {
  let linked = await autoMatchTransferEvents(lineIds);

  // ── 'out' lines <-> CeresPaymentRequest (status='paid'), unambiguous both ways ──
  {
    // The reverse-direction uniqueness test must see EVERY unmatched line, not just the
    // scope we're linking (an older unmatched line matching the same request makes the
    // pairing ambiguous even when it isn't part of this import). So: load all, link scoped.
    const allOutLines = await prisma.ceresStatementLine.findMany({
      where: { direction: 'out', matchStatus: 'unmatched', refText: '' },
    });
    const scope = lineIds ? new Set(lineIds) : null;
    const outLines = scope ? allOutLines.filter((l) => scope.has(l.id)) : allOutLines;
    if (outLines.length) {
      const paidRequests = await prisma.ceresPaymentRequest.findMany({ where: { status: 'paid' } });
      // Requests already linked by ANY OTHER line (matchedType='paymentRequest') are
      // excluded — a payment request can only be linked once.
      const alreadyLinked = await prisma.ceresStatementLine.findMany({
        where: { matchedType: 'paymentRequest', matchedId: { not: '' } },
        select: { matchedId: true },
      });
      const linkedRequestIds = new Set(alreadyLinked.map((l) => l.matchedId));
      const availableRequests = paidRequests.filter((r) => !linkedRequestIds.has(r.id) && r.paidAt);
      const transferEvents = await prisma.ceresRequestMoneyEvent.findMany({ where: { lane: 'transfer' } });
      const transferMap = new Map(transferEvents.map((event) => [event.id, event]));
      const linkedTransferIds = new Set((await prisma.ceresStatementLine.findMany({
        where: { matchedType: 'requestMoneyEvent', matchedId: { not: '' } },
        select: { matchedId: true },
      })).map((linkedLine) => linkedLine.matchedId));

      for (const line of outLines) {
        if (transferEvents.some((event) =>
          !linkedTransferIds.has(event.id) && transferEventDirection(event, transferMap) === 'out' &&
          num(event.amount) === num(line.amount) && Math.abs(line.txnAt.getTime() - event.createdAt.getTime()) <= 3 * DAY_MS,
        )) continue;
        const lineCandidates = availableRequests.filter(
          (r) => num(r.amount) === num(line.amount) && r.paidAt && Math.abs(line.txnAt.getTime() - r.paidAt.getTime()) <= 3 * DAY_MS,
        );
        if (lineCandidates.length !== 1) continue;
        const candidate = lineCandidates[0];
        // Check the OTHER direction: is this line the only UNMATCHED line anywhere that
        // would match that request? (checked against allOutLines, not just the scope)
        const reverseCandidates = allOutLines.filter(
          (l) =>
            num(l.amount) === num(candidate.amount) &&
            candidate.paidAt &&
            Math.abs(l.txnAt.getTime() - candidate.paidAt.getTime()) <= 3 * DAY_MS,
        );
        if (reverseCandidates.length !== 1 || reverseCandidates[0].id !== line.id) continue;

        await prisma.ceresStatementLine.update({
          where: { id: line.id },
          data: {
            matchedType: 'paymentRequest',
            matchedId: candidate.id,
            matchStatus: 'matched',
            reconciledById: null,
            reconciledAt: new Date(),
          },
        });
        linked++;
      }
    }
  }

  // ── 'in' lines <-> CashMovement (type in topup|deposit), unambiguous both ways ──
  {
    // Same load-all / link-scoped split as the 'out' block above.
    const allInLines = await prisma.ceresStatementLine.findMany({
      where: { direction: 'in', matchStatus: 'unmatched', refText: '' },
    });
    const scope = lineIds ? new Set(lineIds) : null;
    const inLines = scope ? allInLines.filter((l) => scope.has(l.id)) : allInLines;
    if (inLines.length) {
      const movements = await prisma.cashMovement.findMany({ where: { type: { in: ['topup', 'deposit'] } } });
      const alreadyLinked = await prisma.ceresStatementLine.findMany({
        where: { matchedType: 'cashMovement', matchedId: { not: '' } },
        select: { matchedId: true },
      });
      const linkedMovementIds = new Set(alreadyLinked.map((l) => l.matchedId));
      const availableMovements = movements.filter((m) => !linkedMovementIds.has(m.id));
      const transferEvents = await prisma.ceresRequestMoneyEvent.findMany({ where: { lane: 'transfer' } });
      const transferMap = new Map(transferEvents.map((event) => [event.id, event]));
      const linkedTransferIds = new Set((await prisma.ceresStatementLine.findMany({
        where: { matchedType: 'requestMoneyEvent', matchedId: { not: '' } },
        select: { matchedId: true },
      })).map((linkedLine) => linkedLine.matchedId));

      for (const line of inLines) {
        if (transferEvents.some((event) =>
          !linkedTransferIds.has(event.id) && transferEventDirection(event, transferMap) === 'in' &&
          num(event.amount) === num(line.amount) && Math.abs(line.txnAt.getTime() - event.createdAt.getTime()) <= 3 * DAY_MS,
        )) continue;
        const lineCandidates = availableMovements.filter(
          (m) => num(m.amount) === num(line.amount) && Math.abs(line.txnAt.getTime() - m.createdAt.getTime()) <= 3 * DAY_MS,
        );
        if (lineCandidates.length !== 1) continue;
        const candidate = lineCandidates[0];
        const reverseCandidates = allInLines.filter(
          (l) => num(l.amount) === num(candidate.amount) && Math.abs(l.txnAt.getTime() - candidate.createdAt.getTime()) <= 3 * DAY_MS,
        );
        if (reverseCandidates.length !== 1 || reverseCandidates[0].id !== line.id) continue;

        await prisma.ceresStatementLine.update({
          where: { id: line.id },
          data: {
            matchedType: 'cashMovement',
            matchedId: candidate.id,
            matchStatus: 'matched',
            reconciledById: null,
            reconciledAt: new Date(),
          },
        });
        linked++;
      }
    }
  }

  return linked;
}

export function statementsRoutes(app: FastifyInstance) {
  // POST /api/ceres/statements/preview { dataB64, fileName } — parse + dedupe-check,
  // no writes. Returns a token to apply this EXACT parsed set (server-authoritative).
  const previewBody = z.object({ dataB64: z.string().min(1), fileName: z.string().min(1).max(300) });
  app.post(
    '/api/ceres/statements/preview',
    { preHandler: requireCeresRole('gm', 'ceo'), bodyLimit: 15 * 1024 * 1024 },
    async (req, reply) => {
      const parsed = previewBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { dataB64, fileName } = parsed.data;

      const buf = Buffer.from(dataB64, 'base64');
      if (!buf.length) return reply.code(400).send({ error: 'empty' });

      let result;
      try {
        result = parseKbiz(buf);
      } catch (err) {
        if (err instanceof BankParseError) {
          return reply.code(400).send({ error: 'not_kbiz' });
        }
        req.log.error({ err }, 'ceres statement parse failed');
        return reply.code(400).send({ error: 'not_kbiz' });
      }

      const dedupeKeys = makeDedupeKeys(result.rows);
      const existing = dedupeKeys.length
        ? await prisma.ceresStatementLine.findMany({ where: { dedupeKey: { in: dedupeKeys } }, select: { dedupeKey: true } })
        : [];
      const existingSet = new Set(existing.map((e) => e.dedupeKey));

      const staged: StagedRow[] = result.rows.map((r, i) => ({
        ...r,
        dedupeKey: dedupeKeys[i],
        isNew: !existingSet.has(dedupeKeys[i]),
      }));

      const fileSha256 = createHash('sha256').update(buf).digest('hex');
      // Shared-parser periods are Dates (or null on an empty file); Ceres stores/returns
      // Thai-day strings.
      const periodFrom = result.periodFrom ? thaiDayKey(result.periodFrom) : '';
      const periodTo = result.periodTo ? thaiDayKey(result.periodTo) : '';
      const token = stash({
        fileName,
        fileSha256,
        buf,
        rows: staged,
        periodFrom,
        periodTo,
        counts: { parsed: result.parsed, excluded: result.excluded },
        at: Date.now(),
      });

      const newCount = staged.filter((r) => r.isNew).length;
      const dupCount = staged.length - newCount;

      return {
        token,
        fileName,
        periodFrom,
        periodTo,
        counts: { parsed: result.parsed, new: newCount, dup: dupCount, excluded: result.excluded },
        rows: staged.slice(0, 100).map((r) => ({
          txnAt: r.txnAt.toISOString(),
          amount: r.amount,
          direction: r.direction,
          channel: r.channel,
          payerName: r.payerName,
          details: r.details,
          isNew: r.isNew,
        })),
      };
    },
  );

  // POST /api/ceres/statements/apply { token } — insert the previewed NEW lines,
  // archive the original file, and run the auto-matcher over just the new lines.
  const applyBody = z.object({ token: z.string().min(1) });
  app.post('/api/ceres/statements/apply', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = applyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const staged = previews.get(parsed.data.token);
    if (!staged || Date.now() - staged.at > PREVIEW_TTL_MS) {
      if (parsed.data.token) previews.delete(parsed.data.token);
      return reply.code(410).send({ error: 'preview_expired' });
    }
    previews.delete(parsed.data.token);

    const newRows = staged.rows.filter((r) => r.isNew);
    const dupCount = staged.rows.length - newRows.length;

    const imp = await prisma.ceresStatementImport.create({
      data: {
        fileName: staged.fileName,
        sha256: staged.fileSha256,
        periodFrom: staged.periodFrom,
        periodTo: staged.periodTo,
        rowsParsed: staged.counts.parsed,
        linesNew: newRows.length,
        linesDup: dupCount,
        excluded: staged.counts.excluded,
        importedById: req.agent!.id,
      },
    });

    await saveStatementFile(imp.id, staged.buf);

    let inserted = 0;
    if (newRows.length) {
      const created = await prisma.ceresStatementLine.createMany({
        data: newRows.map((r) => ({
          importId: imp.id,
          txnAt: r.txnAt,
          amount: r.amount,
          direction: r.direction,
          channel: r.channel,
          description: r.description,
          details: r.details,
          payerName: r.payerName,
          payerBank: r.payerBank,
          dedupeKey: r.dedupeKey,
        })),
        skipDuplicates: true,
      });
      inserted = created.count;
    }

    const insertedLines = inserted
      ? await prisma.ceresStatementLine.findMany({ where: { importId: imp.id }, select: { id: true } })
      : [];
    const autoMatched = insertedLines.length ? await autoMatchLines(insertedLines.map((l) => l.id)) : 0;

    return { importId: imp.id, inserted, dup: dupCount, excluded: staged.counts.excluded, autoMatched };
  });

  // POST /api/ceres/statements/automatch — re-run the matcher over ALL unmatched lines.
  app.post('/api/ceres/statements/automatch', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
    const autoMatched = await autoMatchLines();
    return { autoMatched };
  });

  // GET /api/ceres/statements — recent import audit rows, newest first.
  app.get('/api/ceres/statements', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
    const imports = await prisma.ceresStatementImport.findMany({ orderBy: { importedAt: 'desc' }, take: 50 });
    return { imports };
  });

  // GET /api/ceres/statements/lines?status=&dir=&from=&to=&q=&limit=
  const linesQuery = z.object({
    status: z.enum(['unmatched', 'matched']).optional(),
    dir: z.enum(['in', 'out']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  app.get('/api/ceres/statements/lines', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = linesQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;

    const where: Record<string, unknown> = {};
    if (q.status) where.matchStatus = q.status;
    if (q.dir) where.direction = q.dir;
    const range = thaiDayRange(q.from, q.to);
    if (range) where.txnAt = range;
    if (q.q) {
      const needle = q.q;
      where.OR = [
        { details: { contains: needle, mode: 'insensitive' } },
        { payerName: { contains: needle, mode: 'insensitive' } },
        { description: { contains: needle, mode: 'insensitive' } },
        { refText: { contains: needle, mode: 'insensitive' } },
        { amount: { contains: needle } },
      ];
    }

    const lines = await prisma.ceresStatementLine.findMany({
      where,
      orderBy: { txnAt: 'desc' },
      take: q.limit ?? 200,
    });

    const requestIds = [...new Set(lines.filter((l) => l.matchedType === 'paymentRequest' && l.matchedId).map((l) => l.matchedId))];
    const movementIds = [...new Set(lines.filter((l) => l.matchedType === 'cashMovement' && l.matchedId).map((l) => l.matchedId))];
    const moneyEventIds = [...new Set(lines.filter((l) => l.matchedType === 'requestMoneyEvent' && l.matchedId).map((l) => l.matchedId))];
    const [requests, movements, moneyEvents] = await Promise.all([
      requestIds.length ? prisma.ceresPaymentRequest.findMany({ where: { id: { in: requestIds } } }) : Promise.resolve([]),
      movementIds.length ? prisma.cashMovement.findMany({ where: { id: { in: movementIds } } }) : Promise.resolve([]),
      moneyEventIds.length ? prisma.ceresRequestMoneyEvent.findMany({ where: { id: { in: moneyEventIds } } }) : Promise.resolve([]),
    ]);
    const requestMap = new Map(requests.map((r) => [r.id, r]));
    const movementMap = new Map(movements.map((m) => [m.id, m]));
    const moneyEventMap = new Map(moneyEvents.map((event) => [event.id, event]));

    return {
      lines: lines.map((l) => {
        let matched: { type: string; summary: string } | null = null;
        if (l.matchedType === 'paymentRequest' && l.matchedId) {
          const r = requestMap.get(l.matchedId);
          if (r) matched = { type: 'paymentRequest', summary: `${r.payee} ฿${r.amount} (${r.status})` };
        } else if (l.matchedType === 'cashMovement' && l.matchedId) {
          const m = movementMap.get(l.matchedId);
          if (m) matched = { type: 'cashMovement', summary: `${m.type} ฿${m.amount} ${m.partyName || ''}`.trim() };
        } else if (l.matchedType === 'requestMoneyEvent' && l.matchedId) {
          const event = moneyEventMap.get(l.matchedId);
          if (event) matched = { type: 'requestMoneyEvent', summary: `${event.kind} ${event.amount} (${event.lane})` };
        }
        return {
          id: l.id,
          importId: l.importId,
          txnAt: l.txnAt.toISOString(),
          amount: l.amount,
          amountNum: num(l.amount),
          direction: l.direction,
          channel: l.channel,
          description: l.description,
          details: l.details,
          payerName: l.payerName,
          payerBank: l.payerBank,
          matchStatus: l.matchStatus,
          matchedType: l.matchedType,
          matchedId: l.matchedId,
          refText: l.refText,
          reconciledById: l.reconciledById,
          reconciledAt: l.reconciledAt ? l.reconciledAt.toISOString() : null,
          matched,
        };
      }),
    };
  });

  // POST /api/ceres/statements/lines/:id/match { type, id } — manual link.
  const matchBody = z.object({ type: z.enum(['paymentRequest', 'cashMovement', 'requestMoneyEvent']), id: z.string().min(1) });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/statements/lines/:id/match',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = matchBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const line = await prisma.ceresStatementLine.findUnique({ where: { id: req.params.id } });
      if (!line) return reply.code(404).send({ error: 'not_found' });

      const target = parsed.data.type === 'paymentRequest'
        ? await prisma.ceresPaymentRequest.findUnique({ where: { id: parsed.data.id } })
        : parsed.data.type === 'cashMovement'
          ? await prisma.cashMovement.findUnique({ where: { id: parsed.data.id } })
          : await prisma.ceresRequestMoneyEvent.findUnique({ where: { id: parsed.data.id } });
      if (!target) return reply.code(404).send({ error: 'not_found' });

      if (line.matchedId) return reply.code(409).send({ error: 'already_matched' });
      const targetLinked = await prisma.ceresStatementLine.findFirst({
        where: { matchedType: parsed.data.type, matchedId: parsed.data.id },
        select: { id: true },
      });
      if (targetLinked) return reply.code(409).send({ error: 'target_already_matched' });
      if (parsed.data.type === 'requestMoneyEvent') {
        const event = target as TransferEvent;
        if (event.lane !== 'transfer') return reply.code(400).send({ error: 'invalid_target' });
        const related = event.reversesEventId
          ? await prisma.ceresRequestMoneyEvent.findUnique({ where: { id: event.reversesEventId } })
          : null;
        const eventMap = new Map<string, TransferEvent>([[event.id, event]]);
        if (related) eventMap.set(related.id, related);
        if (transferEventDirection(event, eventMap) !== line.direction || num(event.amount) !== num(line.amount)) {
          return reply.code(400).send({ error: 'target_mismatch' });
        }
      }

      let result;
      try {
        result = await prisma.ceresStatementLine.updateMany({
          where: { id: line.id, matchStatus: 'unmatched', matchedId: '' },
          data: {
            matchedType: parsed.data.type,
            matchedId: parsed.data.id,
            matchStatus: 'matched',
            reconciledById: req.agent!.id,
            reconciledAt: new Date(),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ error: 'target_already_matched' });
        throw error;
      }
      if (result.count !== 1) return reply.code(409).send({ error: 'already_matched' });
      const updated = await prisma.ceresStatementLine.findUniqueOrThrow({ where: { id: line.id } });
      return { ok: true, line: updated };
    },
  );

  // POST /api/ceres/statements/lines/:id/unmatch — clear the link.
  app.post<{ Params: { id: string } }>(
    '/api/ceres/statements/lines/:id/unmatch',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const line = await prisma.ceresStatementLine.findUnique({ where: { id: req.params.id } });
      if (!line) return reply.code(404).send({ error: 'not_found' });

      const newStatus = line.refText.trim() ? 'matched' : 'unmatched';
      const updated = await prisma.ceresStatementLine.update({
        where: { id: line.id },
        data: {
          matchedType: '',
          matchedId: '',
          matchStatus: newStatus,
          reconciledById: null,
          reconciledAt: null,
        },
      });
      return { ok: true, line: updated };
    },
  );

  // POST /api/ceres/statements/lines/:id/ref { refText } — manual reference text.
  const refBody = z.object({ refText: z.string().max(300) });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/statements/lines/:id/ref',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = refBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const line = await prisma.ceresStatementLine.findUnique({ where: { id: req.params.id } });
      if (!line) return reply.code(404).send({ error: 'not_found' });

      const refText = parsed.data.refText;
      const nonEmpty = refText.trim().length > 0;
      const newStatus = nonEmpty || !!line.matchedId ? 'matched' : 'unmatched';

      const updated = await prisma.ceresStatementLine.update({
        where: { id: line.id },
        data: {
          refText,
          matchStatus: newStatus,
          ...(nonEmpty ? { reconciledById: req.agent!.id, reconciledAt: new Date() } : {}),
        },
      });
      return { ok: true, line: updated };
    },
  );

  // GET /api/ceres/statements/summary — reconciliation dashboard cards.
  app.get('/api/ceres/statements/summary', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
    const [unmatchedOutLines, unmatchedInLines, lastImport] = await Promise.all([
      prisma.ceresStatementLine.findMany({ where: { direction: 'out', matchStatus: 'unmatched' } }),
      prisma.ceresStatementLine.findMany({ where: { direction: 'in', matchStatus: 'unmatched' } }),
      prisma.ceresStatementImport.findFirst({ orderBy: { importedAt: 'desc' } }),
    ]);

    const linkedRequestIds = new Set(
      (
        await prisma.ceresStatementLine.findMany({
          where: { matchedType: 'paymentRequest', matchedId: { not: '' } },
          select: { matchedId: true },
        })
      ).map((l) => l.matchedId),
    );
    const paidRequests = await prisma.ceresPaymentRequest.findMany({ where: { status: 'paid' } });
    const unreconciledPaid = paidRequests.filter((r) => !linkedRequestIds.has(r.id));
    const transferEvents = await prisma.ceresRequestMoneyEvent.findMany({ where: { lane: 'transfer' } });
    const linkedMoneyEventIds = new Set(
      (
        await prisma.ceresStatementLine.findMany({
          where: { matchedType: 'requestMoneyEvent', matchedId: { not: '' } },
          select: { matchedId: true },
        })
      ).map((line) => line.matchedId),
    );
    const unreconciledTransferEvents = transferEvents.filter((event) => !linkedMoneyEventIds.has(event.id));
    const reversalExceptions = unreconciledTransferEvents.filter((event) => event.kind === 'reversal');

    const oldestDays =
      unreconciledPaid.length > 0
        ? Math.floor(
            (Date.now() -
              Math.min(...unreconciledPaid.map((r) => (r.paidAt ? r.paidAt.getTime() : r.createdAt.getTime())))) /
              DAY_MS,
          )
        : 0;

    return {
      unmatchedOut: { count: unmatchedOutLines.length, sum: unmatchedOutLines.reduce((s, l) => s + num(l.amount), 0) },
      unmatchedIn: { count: unmatchedInLines.length, sum: unmatchedInLines.reduce((s, l) => s + num(l.amount), 0) },
      paidRequestsUnreconciled: {
        count: unreconciledPaid.length,
        sum: unreconciledPaid.reduce((s, r) => s + num(r.amount), 0),
        oldestDays,
      },
      transferEventsUnreconciled: {
        count: unreconciledTransferEvents.length,
        sum: unreconciledTransferEvents.reduce((sum, event) => sum + num(event.amount), 0),
      },
      transferReversalExceptions: {
        count: reversalExceptions.length,
        sum: reversalExceptions.reduce((sum, event) => sum + num(event.amount), 0),
      },
      lastImport: lastImport ? { importedAt: lastImport.importedAt.toISOString(), fileName: lastImport.fileName } : null,
    };
  });

  // Dedicated outgoing/incoming transfer workspace. Reversal rows remain visible as
  // exceptions until their real compensating bank line is linked.
  app.get('/api/ceres/transfers/reconciliation', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
    const [events, matchedLines, unmatchedBankLines] = await Promise.all([
      prisma.ceresRequestMoneyEvent.findMany({ where: { lane: 'transfer' }, orderBy: { createdAt: 'desc' } }),
      prisma.ceresStatementLine.findMany({
        where: { matchedType: 'requestMoneyEvent', matchedId: { not: '' } },
        orderBy: { txnAt: 'desc' },
      }),
      prisma.ceresStatementLine.findMany({
        where: { matchStatus: 'unmatched', direction: { in: ['in', 'out'] } },
        orderBy: { txnAt: 'desc' },
        take: 500,
      }),
    ]);
    const requestIds = [...new Set(events.map((event) => event.requestId))];
    const requests = requestIds.length > 0
      ? await prisma.ceresPaymentRequest.findMany({ where: { id: { in: requestIds } } })
      : [];
    const requestMap = new Map(requests.map((request) => [request.id, request]));
    const eventMap = new Map(events.map((event) => [event.id, event]));
    const matchedLineMap = new Map(matchedLines.map((line) => [line.matchedId, line]));
    const reversedBy = new Map<string, string>();
    for (const event of events) if (event.kind === 'reversal' && event.reversesEventId) reversedBy.set(event.reversesEventId, event.id);

    return {
      transferEvents: events.map((event) => {
        const request = requestMap.get(event.requestId);
        const line = matchedLineMap.get(event.id);
        const direction = transferEventDirection(event, eventMap);
        return {
          id: event.id,
          requestId: event.requestId,
          requestType: request?.requestType ?? '',
          requester: request?.requestedByName ?? '',
          entity: request?.entity ?? '',
          kind: event.kind,
          direction,
          amount: event.amount,
          createdAt: event.createdAt.toISOString(),
          slipRequired: event.kind !== 'reversal',
          slipPresent: !!event.transferSlipUploadId,
          purchaseReceiptPresent: !!event.purchaseReceiptUploadId,
          reversesEventId: event.reversesEventId,
          reversedByEventId: reversedBy.get(event.id) ?? null,
          reconciliationState: line ? 'matched' : 'unmatched',
          reversalException: event.kind === 'reversal' && !line,
          bankLine: line ? {
            id: line.id,
            txnAt: line.txnAt.toISOString(),
            direction: line.direction,
            amount: line.amount,
            details: line.details,
            reconciledById: line.reconciledById,
            reconciledAt: line.reconciledAt?.toISOString() ?? null,
          } : null,
        };
      }),
      unmatchedBankLines: unmatchedBankLines.map((line) => ({
        id: line.id,
        txnAt: line.txnAt.toISOString(),
        direction: line.direction,
        amount: line.amount,
        channel: line.channel,
        description: line.description,
        details: line.details,
        payerName: line.payerName,
      })),
    };
  });
}
