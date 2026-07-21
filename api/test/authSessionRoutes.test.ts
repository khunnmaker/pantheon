import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  verifyPassword: vi.fn(async () => true),
}));

vi.mock('../src/env.js', () => ({
  env: { JWT_SECRET: 'unit-test-jwt-secret', COOKIE_DOMAIN: '', NODE_ENV: 'test' },
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: { agent: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock('../src/auth/password.js', () => ({
  verifyPassword: mocks.verifyPassword,
  DUMMY_HASH: 'dummy',
}));
vi.mock('../src/auth/loginCards.js', () => ({ buildLoginCards: vi.fn(async () => []) }));

import { authedAgentFromToken } from '../src/auth/middleware.js';
import {
  OA_SYNC_SCOPE,
  SESSION_SCOPE,
  signOaSyncToken,
  signSessionToken,
  signToken,
  verifyToken,
} from '../src/auth/jwt.js';
import { authRoutes } from '../src/routes/auth.js';

const baseAgent = {
  id: 'agent-1',
  email: 'staff@example.test',
  name: 'Staff',
  passwordHash: 'hash',
  role: 'staff' as const,
  apps: ['apollo'],
  authVersion: 0,
};

function cookieToken(setCookie: string): string {
  return setCookie.split(';')[0]!.split('=')[1]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ ...baseAgent });
  mocks.update.mockResolvedValue({ ...baseAgent, authVersion: 1 });
});

describe('auth session routes', () => {
  it('gives supervisor and GM logins the 30d manager session tier', async () => {
    for (const role of ['supervisor', 'gm'] as const) {
      mocks.findUnique.mockResolvedValue({ ...baseAgent, role });
      const app = Fastify();
      await authRoutes(app);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: baseAgent.email, password: 'password' },
      });
      expect(login.headers['set-cookie']).toContain('Max-Age=2592000');
      expect(verifyToken(cookieToken(String(login.headers['set-cookie'])), { scope: SESSION_SCOPE }))
        .toMatchObject({ sessionTier: 'manager' });
      await app.close();
    }
  });

  it('rolls a staff cookie at the original 7d tier and reissues a 12h bearer', async () => {
    const app = Fastify();
    await authRoutes(app);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: baseAgent.email, password: 'password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('Max-Age=604800');
    const session = cookieToken(String(login.headers['set-cookie']));
    expect(verifyToken(session, { scope: SESSION_SCOPE })).toMatchObject({ sessionTier: 'staff' });

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `pantheon_session=${session}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers['set-cookie']).toContain('Max-Age=604800');
    const body = me.json() as { token: string };
    const bearer = jwt.decode(body.token) as jwt.JwtPayload;
    expect(Number(bearer.exp) - Number(bearer.iat)).toBe(12 * 60 * 60);

    await app.close();
  });

  it('invalidates old suite tokens while exempting the OA-sync scoped token', async () => {
    const oldBearer = signToken(baseAgent);
    const oldSession = signSessionToken(baseAgent, 'staff');
    const oaSync = signOaSyncToken(baseAgent);
    mocks.findUnique.mockResolvedValue({ ...baseAgent, authVersion: 1 });

    await expect(authedAgentFromToken(oldBearer)).resolves.toBeNull();
    await expect(authedAgentFromToken(oldSession, undefined, { scope: SESSION_SCOPE })).resolves.toBeNull();
    await expect(authedAgentFromToken(oaSync, undefined, { scope: OA_SYNC_SCOPE })).resolves.toMatchObject({ id: baseAgent.id });
  });

  it('logout bumps authVersion from a bearer and always clears the session cookie', async () => {
    let authVersion = 0;
    mocks.findUnique.mockImplementation(async () => ({ ...baseAgent, authVersion }));
    mocks.update.mockImplementation(async () => ({ ...baseAgent, authVersion: ++authVersion }));
    const token = signToken(baseAgent);
    const app = Fastify();
    await authRoutes(app);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: baseAgent.id },
      data: { authVersion: { increment: 1 } },
    });
    await expect(authedAgentFromToken(token)).resolves.toBeNull();

    await app.close();
  });

  it('logout can identify the agent from the cookie when no bearer is supplied', async () => {
    const session = signSessionToken(baseAgent, 'staff');
    const app = Fastify();
    await authRoutes(app);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `pantheon_session=${session}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    await app.close();
  });
});
