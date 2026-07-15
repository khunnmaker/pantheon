import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-jwt-secret' } }));

let auth: typeof import('../src/auth/jwt.js');

beforeAll(async () => {
  auth = await import('../src/auth/jwt.js');
});

const agent = (role: 'supervisor' | 'gm' | 'agm' | 'employee', apps: string[] = []) => ({
  id: `${role}-1`, email: `${role}@example.test`, name: role, role, apps,
});

describe('unified auth roles', () => {
  it('accepts a legacy md claim at token verification during rollout', () => {
    const token = jwt.sign(
      { email: 'legacy@example.test', name: 'Legacy GM', role: 'md' },
      'unit-test-jwt-secret',
      { subject: 'legacy-1', algorithm: 'HS256', expiresIn: '1h' },
    );
    expect(auth.verifyToken(token)).toMatchObject({ id: 'legacy-1', role: 'md' });
  });

  it('gives gm the implicit GM_APPS set', () => {
    for (const app of auth.GM_APPS) expect(auth.hasAppAccess(agent('gm'), app)).toBe(true);
    expect(auth.hasAppAccess(agent('gm'), 'venus')).toBe(false);
  });

  it('gives agm access only through Agent.apps', () => {
    expect(auth.hasAppAccess(agent('agm'), 'apollo')).toBe(false);
    expect(auth.hasAppAccess(agent('agm', ['apollo']), 'apollo')).toBe(true);
    expect(auth.hasAppAccess(agent('agm', ['apollo']), 'juno')).toBe(false);
  });
});
