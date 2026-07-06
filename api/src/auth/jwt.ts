import jwt from 'jsonwebtoken';
import { env } from '../env.js';

// Unified auth: three live tiers. 'agent'/'messenger' are RETIRED roles — no live Agent row
// can carry them after boot (ensureSeeded heals every row to one of the three below) — but a
// pre-deploy token signed under the old scheme may still carry one until it expires (<=12h).
export type Role = 'supervisor' | 'md' | 'employee';
// Every live role, as a runtime tuple. Use where an endpoint means "any authenticated
// account" and then gates per-app inside the handler (see middleware.requireAnyAuth /
// the Jupiter badges route). Mirrors LIVE_ROLES in middleware.ts; adding a future role
// here keeps those "any account" paths from silently omitting it.
export const ALL_ROLES = ['supervisor', 'md', 'employee'] as const;
// Accepted at TOKEN VERIFICATION ONLY, so an old token isn't rejected outright mid-rollout;
// every consumer re-reads the LIVE Agent row (see authedAgentFromToken), which decides real
// access and can never itself be 'agent'/'messenger' post-boot.
const TOKEN_ROLES = ['supervisor', 'md', 'employee', 'agent', 'messenger'] as const;
type TokenRole = (typeof TOKEN_ROLES)[number];

export type AppName = 'minerva' | 'vulcan' | 'juno' | 'ceres' | 'mercury' | 'venus';

// What we put inside the signed token (and hydrate onto each request).
export interface AuthedAgent {
  id: string;
  email: string;
  name: string;
  role: Role;
  apps: string[];
}

const EXPIRES_IN = '12h';

export function signToken(agent: Pick<AuthedAgent, 'id' | 'email' | 'name' | 'role'>): string {
  return jwt.sign(
    { email: agent.email, name: agent.name, role: agent.role },
    env.JWT_SECRET,
    { subject: agent.id, expiresIn: EXPIRES_IN, algorithm: 'HS256' },
  );
}

// Returns the CLAIMED identity from the token, or null if missing/invalid/expired. The role
// here is only a signed claim — every consumer re-reads the live Agent row (see
// authedAgentFromToken) to get the real, current role + apps before trusting anything.
export function verifyToken(token: string): { id: string; email: string; name: string; role: TokenRole } | null {
  try {
    // Pin the accepted algorithm so verification can't drift to another scheme.
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub || !TOKEN_ROLES.includes(p.role)) return null;
    return {
      id: String(p.sub),
      email: String(p.email ?? ''),
      name: String(p.name ?? ''),
      role: p.role,
    };
  } catch {
    return null;
  }
}

// supervisor → everything; md → Ceres + Minerva + Juno (the MD runs expenses, the sales
// console, and finance); employee → their own per-person Agent.apps grant list.
export const MD_APPS: readonly AppName[] = ['ceres', 'minerva', 'juno'];
export function hasAppAccess(agent: AuthedAgent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'md') return MD_APPS.includes(app);
  return agent.apps.includes(app);
}
