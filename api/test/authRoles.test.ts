import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-jwt-secret' } }));

let auth: typeof import('../src/auth/jwt.js');

beforeAll(async () => {
  auth = await import('../src/auth/jwt.js');
});

const agent = (role: 'supervisor' | 'gm' | 'central' | 'staff', apps: string[] = []) => ({
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

  it('accepts a legacy agm claim at token verification during rollout', () => {
    const token = jwt.sign(
      { email: 'legacy-central@example.test', name: 'Legacy Central Office', role: 'agm' },
      'unit-test-jwt-secret',
      { subject: 'legacy-central-1', algorithm: 'HS256', expiresIn: '1h' },
    );
    expect(auth.verifyToken(token)).toMatchObject({ id: 'legacy-central-1', role: 'agm', authVersion: 0 });
  });

  it('accepts a legacy employee role claim (pre-rename token) at token verification', () => {
    const token = jwt.sign(
      { email: 'legacy-staff@example.test', name: 'Legacy Staff', role: 'employee' },
      'unit-test-jwt-secret',
      { subject: 'legacy-staff-1', algorithm: 'HS256', expiresIn: '1h' },
    );
    expect(auth.verifyToken(token)).toMatchObject({ id: 'legacy-staff-1', role: 'employee', authVersion: 0 });
  });

  it('maps a legacy sessionTier:"employee" cookie claim onto "staff" on verification', () => {
    const token = jwt.sign(
      {
        email: 'legacy-staff@example.test',
        name: 'Legacy Staff',
        role: 'employee',
        scope: auth.SESSION_SCOPE,
        sessionTier: 'employee',
      },
      'unit-test-jwt-secret',
      { subject: 'legacy-staff-1', algorithm: 'HS256', expiresIn: '7d' },
    );
    expect(auth.verifyToken(token, { scope: auth.SESSION_SCOPE })).toMatchObject({ sessionTier: 'staff' });
  });

  it('gives gm the implicit GM_APPS set', () => {
    for (const app of auth.GM_APPS) expect(auth.hasAppAccess(agent('gm'), app)).toBe(true);
    expect(auth.hasAppAccess(agent('gm'), 'venus')).toBe(false);
  });

  it('gives Central Office access only through Agent.apps', () => {
    expect(auth.hasAppAccess(agent('central'), 'apollo')).toBe(false);
    expect(auth.hasAppAccess(agent('central', ['apollo']), 'apollo')).toBe(true);
    expect(auth.hasAppAccess(agent('central', ['apollo']), 'juno')).toBe(false);
  });

  it('makes Mali available to every live staff role without a per-person app grant', () => {
    for (const role of auth.ALL_ROLES) {
      expect(auth.hasAppAccess(agent(role), 'mali')).toBe(true);
    }
  });

  it('admits a central account to juno ONLY once granted (Mail, 2026-07-21) — the role stays staff-equivalent, not widened', () => {
    expect(auth.hasAppAccess(agent('central', ['minerva', 'ceres', 'apollo']), 'juno')).toBe(false);
    expect(auth.hasAppAccess(agent('central', ['minerva', 'ceres', 'apollo', 'juno']), 'juno')).toBe(true);
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
    expect(seconds(auth.signToken(agent('staff')))).toBe(12 * 60 * 60);
    expect(seconds(auth.signSessionToken(agent('staff'), 'staff'))).toBe(7 * 24 * 60 * 60);
    expect(seconds(auth.signSessionToken(agent('gm'), 'manager'))).toBe(30 * 24 * 60 * 60);
  });
});
