import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindUnique: vi.fn(), goalFindMany: vi.fn(), checkInFindMany: vi.fn(), journalFindMany: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-jwt-secret' } }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    agent: { findUnique: mocks.agentFindUnique },
    hestiaGoal: { findMany: mocks.goalFindMany },
    hestiaCheckIn: { findMany: mocks.checkInFindMany },
    hestiaJournalEntry: { findMany: mocks.journalFindMany },
  },
}));

import { signToken, type Role } from '../src/auth/jwt.js';
import { hestiaRoutes } from '../src/routes/hestia.js';

const liveAgent = (role: Role, apps: string[] = []) => ({
  id: 'agent-1', email: 'agent@example.test', name: 'Agent', role, apps, authVersion: 0,
});
const tokenFor = (role: Role = 'supervisor') => signToken(liveAgent(role));

async function request(token?: string) {
  const app = Fastify();
  await app.register(hestiaRoutes);
  const response = await app.inject({
    method: 'GET', url: '/api/hestia/overview?date=2026-07-17&year=2026',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.goalFindMany.mockResolvedValue([]);
  mocks.checkInFindMany.mockResolvedValue([]);
  mocks.journalFindMany.mockResolvedValue([]);
});

describe('Hestia whole-plugin access gate', () => {
  it('returns 401 with no bearer token', async () => {
    expect((await request()).statusCode).toBe(401);
  });

  it.each(['gm', 'agm', 'employee'] as const)('returns 403 to a live %s', async (role) => {
    mocks.agentFindUnique.mockResolvedValue(liveAgent(role));
    expect((await request(tokenFor(role))).statusCode).toBe(403);
  });

  it('does not let an olympus app grant widen employee access', async () => {
    mocks.agentFindUnique.mockResolvedValue(liveAgent('employee', ['olympus']));
    expect((await request(tokenFor('employee'))).statusCode).toBe(403);
  });

  it('lets the live supervisor reach the handler', async () => {
    mocks.agentFindUnique.mockResolvedValue(liveAgent('supervisor'));
    const response = await request(tokenFor());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ totals: { completed: 0, total: 0 } });
  });

  it('denies a supervisor token after the live row is demoted', async () => {
    mocks.agentFindUnique.mockResolvedValue(liveAgent('employee'));
    expect((await request(tokenFor('supervisor'))).statusCode).toBe(403);
  });
});
