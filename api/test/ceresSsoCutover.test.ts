import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({ authedAgentFromToken: vi.fn() }));

vi.mock('../src/env.js', () => ({ env: { CERES_LOCAL_LOGIN_ENABLED: 'true' } }));
vi.mock('../src/auth/middleware.js', () => ({
  authedAgentFromToken: authMocks.authedAgentFromToken,
}));

import { requireCeresAuth } from '../src/ceres/auth.js';
import { ceresLocalLoginEnabled, ceresLoginRoute } from '../src/routes/ceres/login.js';

const agent = (apps: string[]) => ({
  id: 'agent-1',
  email: 'staff@example.test',
  name: 'Staff',
  role: 'staff' as const,
  apps,
  authVersion: 0,
});

async function authProbe() {
  const app = Fastify();
  app.get('/probe', { preHandler: requireCeresAuth }, async () => ({ ok: true }));
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('Ceres authentication status contract', () => {
  it('returns 401 when no live account authenticates', async () => {
    authMocks.authedAgentFromToken.mockResolvedValue(null);
    const app = await authProbe();
    const response = await app.inject({ method: 'GET', url: '/probe' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });

  it('returns 403 when an authenticated staff member lacks the Ceres grant', async () => {
    authMocks.authedAgentFromToken.mockResolvedValue(agent([]));
    const app = await authProbe();
    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: 'Bearer signed-test-token' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden', need: 'ceres' });
    await app.close();
  });

  it('admits an authenticated staff member with the Ceres grant', async () => {
    authMocks.authedAgentFromToken.mockResolvedValue(agent(['ceres']));
    const app = await authProbe();
    const response = await app.inject({ method: 'GET', url: '/probe' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('Ceres compatibility login endpoint flag', () => {
  it('accepts only explicit true/1 flag values', () => {
    expect(ceresLocalLoginEnabled('true')).toBe(true);
    expect(ceresLocalLoginEnabled('1')).toBe(true);
    expect(ceresLocalLoginEnabled('false')).toBe(false);
    expect(ceresLocalLoginEnabled('0')).toBe(false);
    expect(ceresLocalLoginEnabled('')).toBe(false);
  });

  it('serves login cards while the deploy-time flag is enabled', async () => {
    const app = Fastify();
    const buildCards = vi.fn(async () => [{
      email: 'staff@example.test',
      name: 'Staff',
      kind: 'pin' as const,
      group: 'staff',
      gender: 'female' as const,
    }]);
    ceresLoginRoute(app, { enabled: () => true, buildCards });

    const response = await app.inject({ method: 'GET', url: '/api/ceres/logins' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(buildCards).toHaveBeenCalledWith('ceres');
    await app.close();
  });

  it('returns 404 without reading cards when the deploy-time flag is disabled', async () => {
    const app = Fastify();
    const buildCards = vi.fn(async () => []);
    ceresLoginRoute(app, { enabled: () => false, buildCards });

    const response = await app.inject({ method: 'GET', url: '/api/ceres/logins' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(buildCards).not.toHaveBeenCalled();
    await app.close();
  });
});
