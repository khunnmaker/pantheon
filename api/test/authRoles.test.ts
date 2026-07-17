import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-jwt-secret' } }));

let auth: typeof import('../src/auth/jwt.js');

beforeAll(async () => {
  auth = await import('../src/auth/jwt.js');
});

const agent = (role: 'supervisor' | 'gm' | 'agm' | 'employee', apps: string[] = []) => ({
  id: `${role}-1`, email: `${role}@example.test`, name: role, role, apps, authVersion: 0,
});

describe('unified auth roles', () => {
  it('accepts a legacy md claim at token verification during rollout', () => {
    const token = jwt.sign(
      { email: 'legacy@example.test', name: 'Legacy GM', role: 'md' },
      'unit-test-jwt-secret',
      { subject: 'legacy-1', algorithm: 'HS256', expiresIn: '1h' },
    );
    expect(auth.verifyToken(token)).toMatchObject({ id: 'legacy-1', role: 'md', authVersion: 0 });
  });

  it('gives gm the implicit GM_APPS set', () => {
    for (const app of auth.GM_APPS) expect(auth.hasAppAccess(agent('gm'), app)).toBe(true);
    expect(auth.hasAppAccess(agent('gm'), 'venus')).toBe(false);
    expect(auth.GM_APPS).toEqual(['ceres', 'minerva', 'juno', 'apollo']);
    expect(auth.GM_APPS).not.toContain('olympus');
    expect(auth.APP_NAMES).toContain('olympus');
  });

  it('gives agm access only through Agent.apps', () => {
    expect(auth.hasAppAccess(agent('agm'), 'apollo')).toBe(false);
    expect(auth.hasAppAccess(agent('agm', ['apollo']), 'apollo')).toBe(true);
    expect(auth.hasAppAccess(agent('agm', ['apollo']), 'juno')).toBe(false);
  });

  it('keeps bearer, session, and OA-sync scopes separate', () => {
    const bearer = auth.signToken(agent('supervisor'));
    const session = auth.signSessionToken(agent('supervisor'), 'manager');
    const oaSync = auth.signOaSyncToken(agent('supervisor'));

    expect(auth.verifyToken(bearer)).toMatchObject({ id: 'supervisor-1', authVersion: 0 });
    expect(auth.verifyToken(session)).toBeNull();
    expect(auth.verifyToken(session, { scope: auth.SESSION_SCOPE })).toMatchObject({ scope: 'session' });
    expect(auth.verifyToken(oaSync)).toBeNull();
    expect(auth.verifyToken(oaSync, { scope: auth.OA_SYNC_SCOPE })).toMatchObject({ scope: 'oa-sync' });
  });

  it('issues 12h bearers and role-tiered session expiries', () => {
    const seconds = (token: string) => {
      const claims = jwt.decode(token) as jwt.JwtPayload;
      return Number(claims.exp) - Number(claims.iat);
    };
    expect(seconds(auth.signToken(agent('employee')))).toBe(12 * 60 * 60);
    expect(seconds(auth.signSessionToken(agent('employee'), 'employee'))).toBe(7 * 24 * 60 * 60);
    expect(seconds(auth.signSessionToken(agent('gm'), 'manager'))).toBe(30 * 24 * 60 * 60);
  });
});
