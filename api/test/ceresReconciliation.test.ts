import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  lines: [] as Array<Record<string, any>>,
  events: [] as Array<Record<string, any>>,
  requests: [] as Array<Record<string, any>>,
}));

vi.mock('../src/env.js', () => ({ env: { CERES_FLOOR: 3000, CERES_CEO_THRESHOLD: 5000 } }));

vi.mock('../src/db/prisma.js', () => {
  const lineMatches = (line: Record<string, any>, where: Record<string, any>): boolean => {
    if (where.id && line.id !== where.id) return false;
    if (where.direction && typeof where.direction === 'string' && line.direction !== where.direction) return false;
    if (where.direction?.in && !where.direction.in.includes(line.direction)) return false;
    if (where.matchStatus && line.matchStatus !== where.matchStatus) return false;
    if (where.refText !== undefined && line.refText !== where.refText) return false;
    if (where.matchedType && line.matchedType !== where.matchedType) return false;
    if (where.matchedId?.not !== undefined && line.matchedId === where.matchedId.not) return false;
    if (typeof where.matchedId === 'string' && line.matchedId !== where.matchedId) return false;
    return true;
  };
  return { prisma: {
    ceresStatementLine: {
      findMany: vi.fn(async ({ where = {} }: any) => state.lines.filter((line) => lineMatches(line, where))),
      findUnique: vi.fn(async ({ where }: any) => state.lines.find((line) => line.id === where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => state.lines.find((line) => line.id === where.id)!),
      findFirst: vi.fn(async ({ where }: any) => state.lines.find((line) => lineMatches(line, where)) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const line = state.lines.find((candidate) => lineMatches(candidate, where));
        if (!line) return { count: 0 };
        Object.assign(line, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const line = state.lines.find((candidate) => candidate.id === where.id)!;
        Object.assign(line, data);
        return line;
      }),
    },
    ceresRequestMoneyEvent: {
      findMany: vi.fn(async ({ where }: any) => state.events.filter((event) =>
        (!where?.lane || event.lane === where.lane) &&
        (!where?.id?.in || where.id.in.includes(event.id)),
      )),
      findUnique: vi.fn(async ({ where }: any) => state.events.find((event) => event.id === where.id) ?? null),
    },
    ceresPaymentRequest: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where?.status === 'paid') return state.requests.filter((request) => request.status === 'paid');
        return state.requests.filter((request) => !where?.id?.in || where.id.in.includes(request.id));
      }),
      findUnique: vi.fn(async ({ where }: any) => state.requests.find((request) => request.id === where.id) ?? null),
    },
    cashMovement: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    ceresStatementImport: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  } };
});
vi.mock('../src/ceres/statementStore.js', () => ({ saveStatementFile: vi.fn() }));

import { statementsRoutes } from '../src/routes/ceres/statements.js';

const at = new Date('2026-07-17T03:00:00Z');

function makeLine(id: string, amount: string, direction: 'in' | 'out', offsetHours = 0) {
  return {
    id, importId: 'import-1', txnAt: new Date(at.getTime() + offsetHours * 3600_000), amount, direction,
    channel: 'KBIZ', description: '', details: id, payerName: '', payerBank: '', dedupeKey: id,
    matchStatus: 'unmatched', matchedType: '', matchedId: '', refText: '', reconciledById: null, reconciledAt: null,
  };
}

function makeEvent(id: string, kind: string, amount: string, reversesEventId: string | null = null) {
  return {
    id, requestId: 'request-1', kind, lane: 'transfer', amount, transferSlipUploadId: kind === 'reversal' ? null : 'slip-1',
    purchaseReceiptUploadId: null, cashMovementId: null, reversesEventId, createdById: 'gm-1', createdByName: 'GM',
    note: '', createdAt: at, idempotencyKey: null,
  };
}

async function app() {
  const server = Fastify();
  server.addHook('preHandler', async (req) => {
    req.agent = { id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm', apps: [], authVersion: 0 };
  });
  statementsRoutes(server);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.lines.length = 0;
  state.events.length = 0;
  state.requests.length = 0;
  state.requests.push({
    id: 'request-1', requestType: 'advance', requestedByName: 'Staff', entity: 'PROM', amount: '100.00',
  });
});

describe('Ceres Phase 3 transfer reconciliation', () => {
  it('never automatches ambiguous equal-amount bank lines', async () => {
    state.events.push(makeEvent('event-1', 'payment', '100.00'));
    state.lines.push(makeLine('line-1', '100.00', 'out'), makeLine('line-2', '100.00', 'out', 1));
    const server = await app();
    const response = await server.inject({ method: 'POST', url: '/api/ceres/statements/automatch' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ autoMatched: 0 });
    expect(state.lines.every((line) => line.matchStatus === 'unmatched')).toBe(true);
    await server.close();
  });

  it('does not guess when one bank line fits both a legacy payment and a transfer event', async () => {
    state.events.push(makeEvent('event-1', 'payment', '100.00'));
    state.requests.push({
      id: 'legacy-1', workflowVersion: 1, status: 'paid', amount: '100.00', paidAt: at, createdAt: at,
    });
    state.lines.push(makeLine('line-1', '100.00', 'out'));
    const server = await app();
    const response = await server.inject({ method: 'POST', url: '/api/ceres/statements/automatch' });
    expect(response.json()).toEqual({ autoMatched: 0 });
    expect(state.lines[0].matchStatus).toBe('unmatched');
    await server.close();
  });

  it('automatches only unique pairs in both outgoing and incoming directions', async () => {
    state.events.push(makeEvent('event-out', 'payment', '100.00'), makeEvent('event-in', 'refund', '40.00'));
    state.lines.push(makeLine('line-out', '100.00', 'out'), makeLine('line-in', '40.00', 'in'));
    const server = await app();
    const response = await server.inject({ method: 'POST', url: '/api/ceres/statements/automatch' });
    expect(response.json()).toEqual({ autoMatched: 2 });
    expect(state.lines.map((line) => [line.id, line.matchedType, line.matchedId])).toEqual([
      ['line-out', 'requestMoneyEvent', 'event-out'],
      ['line-in', 'requestMoneyEvent', 'event-in'],
    ]);
    await server.close();
  });

  it('enforces one statement line per target during manual matching', async () => {
    state.events.push(makeEvent('event-1', 'payment', '100.00'));
    state.lines.push(
      { ...makeLine('line-1', '100.00', 'out'), matchStatus: 'matched', matchedType: 'requestMoneyEvent', matchedId: 'event-1' },
      makeLine('line-2', '100.00', 'out'),
    );
    const server = await app();
    const response = await server.inject({
      method: 'POST', url: '/api/ceres/statements/lines/line-2/match',
      payload: { type: 'requestMoneyEvent', id: 'event-1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'target_already_matched' });
    await server.close();
  });

  it('keeps an unmatched transfer reversal visible as a reconciliation exception', async () => {
    const original = makeEvent('event-original', 'payment', '100.00');
    const reversal = makeEvent('event-reversal', 'reversal', '100.00', original.id);
    state.events.push(original, reversal);
    state.lines.push({
      ...makeLine('line-original', '100.00', 'out'), matchStatus: 'matched', matchedType: 'requestMoneyEvent', matchedId: original.id,
    });
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/api/ceres/transfers/reconciliation' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.transferEvents.find((event: any) => event.id === reversal.id)).toMatchObject({
      direction: 'in', reconciliationState: 'unmatched', reversalException: true,
    });
    expect(body.transferEvents.find((event: any) => event.id === original.id)).toMatchObject({
      reconciliationState: 'matched', reversedByEventId: reversal.id,
    });
    await server.close();
  });
});
