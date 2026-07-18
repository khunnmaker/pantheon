import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: 'supervisor-1', name: 'Synthetic Supervisor', role: 'supervisor' };
  },
  requireRole: () => async () => undefined,
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    jupiterLedgerAccount: { findMany: vi.fn() }, jupiterLedgerJournal: { findMany: vi.fn() },
    jupiterLedgerPartner: { findMany: vi.fn() }, jupiterLedgerTax: { findMany: vi.fn() },
    jupiterJournalEntry: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

import { jupiterLedgerRoutes } from '../src/routes/jupiterLedger.js';
import { rfc4180Csv } from '../src/jupiter/ledger/reports.js';

async function buildApp() {
  const app = Fastify();
  await jupiterLedgerRoutes(app);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('Jupiter ledger route validation', () => {
  it('emits Thai-safe RFC 4180 CSV with a UTF-8 BOM', () => {
    expect(rfc4180Csv(['name', 'memo'], [['คลินิก, กรุงเทพ', 'เขียนว่า "ชำระแล้ว"']]))
      .toBe('\uFEFFname,memo\r\n"คลินิก, กรุงเทพ","เขียนว่า ""ชำระแล้ว"""\r\n');
  });

  it('requires company on CPA reports before querying', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/jupiter/acct/reports/trial-balance?format=json' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects malformed money Strings before opening a transaction', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/jupiter/acct/entries', payload: {
      companyCode: 'TONR', journalId: 'journal-1', entryDate: '2026-07-18', lines: [
        { lineNo: 1, accountId: 'cash', debit: '1,000.00', credit: '0.00', taxes: [] },
        { lineNo: 2, accountId: 'equity', debit: '0.00', credit: '1000.00', taxes: [] },
      ],
    } });
    expect(response.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires optimistic version for edit, post, reverse, and void', async () => {
    const app = await buildApp();
    const requests = [
      app.inject({ method: 'PATCH', url: '/api/jupiter/acct/entries/entry-1', payload: {} }),
      app.inject({ method: 'POST', url: '/api/jupiter/acct/entries/entry-1/post', payload: {} }),
      app.inject({ method: 'POST', url: '/api/jupiter/acct/entries/entry-1/reverse', payload: { reversalDate: '2026-07-19', reason: 'synthetic' } }),
      app.inject({ method: 'POST', url: '/api/jupiter/acct/entries/entry-1/void', payload: {} }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    await app.close();
  });

  it('rejects invalid reference-data booleans', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/jupiter/acct/accounts?company=TONR&active=yes' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
