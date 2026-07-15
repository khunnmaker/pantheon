import jwt from 'jsonwebtoken';
import { env } from '../env.js';

// Unified auth: four live tiers. 'md'/'agent'/'messenger' are RETIRED roles — no live Agent row
// can carry them after boot (ensureSeeded heals every row to one of the four below) — but a
// pre-deploy bearer/session token signed under an old scheme may still carry one until expiry.
export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
// Every live role, as a runtime tuple. Use where an endpoint means "any authenticated
// account" and then gates per-app inside the handler (see middleware.requireAnyAuth /
// the Pantheon badges route). Mirrors LIVE_ROLES in middleware.ts; adding a future role
// here keeps those "any account" paths from silently omitting it.
export const ALL_ROLES = ['supervisor', 'gm', 'agm', 'employee'] as const;
// Accepted at TOKEN VERIFICATION ONLY, so an old token isn't rejected outright mid-rollout;
// every consumer re-reads the LIVE Agent row (see authedAgentFromToken), which decides real
// access and can never itself be 'md'/'agent'/'messenger' post-boot.
const TOKEN_ROLES = ['supervisor', 'gm', 'agm', 'employee', 'md', 'agent', 'messenger'] as const;
type TokenRole = (typeof TOKEN_ROLES)[number];

// The suite's app names — the SINGLE source of truth (runtime tuple + type). requireApp,
// loginCards, and the badges route all derive from this; adding a future god (mars/neptune/
// vulcan) is a one-line edit here that both the type and the runtime checks pick up.
export const APP_NAMES = ['minerva', 'vesta', 'juno', 'jupiter', 'ceres', 'mercury', 'venus', 'diana', 'apollo'] as const;
export type AppName = (typeof APP_NAMES)[number];

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

// The scope carried by the long-lived OA-read-sync token. A token bearing this scope verifies
// ONLY on a matching-scope path (the /api/oa-sync endpoint passes { scope }); the default
// verifyToken() every other route uses REJECTS it — so even a leaked sync token can do nothing
// but post read-status. Access is still re-read from the live Agent row on every request (see
// authedAgentFromToken → requireApp), so demotion/removal revokes it immediately despite the
// long TTL. Long TTL because the Chrome extension can't silently re-auth (it never stores the
// password), and a 12h console token made the sync die daily.
export const OA_SYNC_SCOPE = 'oa-sync';
const OA_SYNC_EXPIRES = '180d';

export function signOaSyncToken(agent: Pick<AuthedAgent, 'id' | 'email' | 'name' | 'role'>): string {
  return jwt.sign(
    { email: agent.email, name: agent.name, role: agent.role, scope: OA_SYNC_SCOPE },
    env.JWT_SECRET,
    { subject: agent.id, expiresIn: OA_SYNC_EXPIRES, algorithm: 'HS256' },
  );
}

// The scope carried by the suite SSO *device-session* cookie ("remember this computer").
// Same isolation story as the OA-sync token: a session-scoped token verifies ONLY where the
// caller passes { scope: SESSION_SCOPE } — that's GET /api/auth/me and nothing else — and the
// default verifyToken() every API route uses REJECTS it, so the long-lived cookie can never be
// replayed as an Authorization bearer. Long TTL so staff log in once per device instead of
// every 12 hours; /me re-issues the cookie on each bootstrap (rolling window), and access is
// still re-read from the live Agent row per request, so removing/demoting an account revokes
// a remembered device immediately despite the TTL. The bearer tokens apps hold stay 12h.
export const SESSION_SCOPE = 'session';
const SESSION_EXPIRES = '30d';

export function signSessionToken(agent: Pick<AuthedAgent, 'id' | 'email' | 'name' | 'role'>): string {
  return jwt.sign(
    { email: agent.email, name: agent.name, role: agent.role, scope: SESSION_SCOPE },
    env.JWT_SECRET,
    { subject: agent.id, expiresIn: SESSION_EXPIRES, algorithm: 'HS256' },
  );
}

// Returns the CLAIMED identity from the token, or null if missing/invalid/expired. The role
// here is only a signed claim — every consumer re-reads the live Agent row (see
// authedAgentFromToken) to get the real, current role + apps before trusting anything.
//
// Scope gate: a token that carries a `scope` claim (e.g. the OA-sync token) is accepted ONLY
// when the caller passes the SAME `opts.scope`. So the default call verifyToken(token) (no
// scope) rejects every scoped token, keeping the long-lived sync token off all other routes;
// a normal console token (no scope claim) passes everywhere exactly as before.
export function verifyToken(
  token: string,
  opts?: { scope?: string },
): { id: string; email: string; name: string; role: TokenRole } | null {
  try {
    // Pin the accepted algorithm so verification can't drift to another scheme.
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!p.sub || !TOKEN_ROLES.includes(p.role)) return null;
    const scope = typeof p.scope === 'string' ? p.scope : undefined;
    if (scope && scope !== opts?.scope) return null; // scoped token: only valid on a matching-scope path
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

// supervisor → everything; gm → Ceres + Minerva + Juno + Apollo. The Juno grant admits GMs,
// while routes/juno.ts narrows them to bills/products only (owner decision 2026-07-13).
// agm/employee → their own per-person Agent.apps grant list.
export const GM_APPS: readonly AppName[] = ['ceres', 'minerva', 'juno', 'apollo'];
export function hasAppAccess(agent: AuthedAgent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'gm') return GM_APPS.includes(app);
  return agent.apps.includes(app);
}
