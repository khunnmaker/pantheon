import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'supervisor',
  getConfig: vi.fn(), setConfig: vi.fn(), cancelAll: vi.fn(),
}));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: 'staff-1', role: mocks.role, apps: ['minerva'] };
  },
  requireApp: () => async () => undefined,
  requireRole: (role: string) => async (req: { agent?: { role?: string } }, reply: { code: (n: number) => { send: (v: unknown) => unknown } }) => {
    if (req.agent?.role !== role) return reply.code(403).send({ error: 'forbidden', need: role });
  },
}));
vi.mock('../src/autosend/config.js', () => ({
  getAutosendConfig: mocks.getConfig,
  setAutosendConfig: mocks.setConfig,
}));
vi.mock('../src/autosend/scheduler.js', () => ({
  cancelAllAutosends: mocks.cancelAll,
  cancelAutosendForDraft: vi.fn(),
  cancelAutosendForCustomer: vi.fn(),
}));
vi.mock('../src/db/prisma.js', () => ({ prisma: { draft: {}, message: {} } }));

import { autosendRoutes } from '../src/routes/autosend.js';

describe('autosend config authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'supervisor';
    mocks.getConfig.mockResolvedValue({ enabled: false, delaySeconds: 60 });
    mocks.setConfig.mockResolvedValue({ enabled: true, delaySeconds: 15 });
  });

  it('allows a supervisor to read and update the config', async () => {
    const app = Fastify(); await autosendRoutes(app);
    expect((await app.inject({ method: 'GET', url: '/api/autosend/config' })).json()).toEqual({ enabled: false, delaySeconds: 60 });
    const post = await app.inject({ method: 'POST', url: '/api/autosend/config', payload: { enabled: true, delaySeconds: 1 } });
    expect(post.statusCode).toBe(200);
    expect(mocks.setConfig).toHaveBeenCalledWith({ enabled: true, delaySeconds: 1 });
    await app.close();
  });

  it('rejects an agent from both config endpoints', async () => {
    mocks.role = 'employee';
    const app = Fastify(); await autosendRoutes(app);
    expect((await app.inject({ method: 'GET', url: '/api/autosend/config' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/autosend/config', payload: { enabled: true, delaySeconds: 60 } })).statusCode).toBe(403);
    expect(mocks.setConfig).not.toHaveBeenCalled();
    await app.close();
  });
});
