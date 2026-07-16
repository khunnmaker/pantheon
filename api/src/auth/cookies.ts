// Shared-session cookie for suite-wide SSO (Pantheon Phase 3). ONE cookie, scoped to the
// parent domain (COOKIE_DOMAIN = ".prominentdental.com"), is set at login and is therefore
// shared by every *.prominentdental.com app. Its ONLY job is to authenticate GET
// /api/auth/me, which hands back a normal bearer token that each app then uses via the
// Authorization header exactly as before. Because the cookie never authenticates a
// state-changing request (only /me — a GET — ever reads it), there is no CSRF surface to
// defend. Dependency-free by design (no @fastify/cookie): we serialize/parse the one cookie
// by hand so nothing new enters the auth dependency tree.
import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';

export const SESSION_COOKIE = 'pantheon_session';

// Build a Set-Cookie value. `Secure` is gated on production so the cookie still sets over
// plain http on localhost during dev. `Domain` is only added when COOKIE_DOMAIN is set
// (production = ".prominentdental.com"); unset → a host-only cookie — fine for local dev, but
// NOT shared across subdomains, so real SSO needs COOKIE_DOMAIN set on the production api.
// SameSite=Lax: the cookie IS sent on requests between subdomains of the same registrable
// domain (minerva. → api.prominentdental.com is same-site), but NOT on cross-site fetch/XHR
// from another domain — so a foreign site can never make the browser attach it to an api call.
function serialize(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (env.COOKIE_DOMAIN) parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  if (env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function sessionSetCookie(token: string, maxAgeSeconds: number): string {
  return serialize(token, maxAgeSeconds);
}
export function sessionClearCookie(): string {
  return serialize('', 0);
}

// Read the session token from the request's Cookie header (dependency-free parse). Returns
// null when the cookie is absent. ONLY GET /api/auth/me consults this.
export function readSessionToken(req: FastifyRequest): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) {
      return pair.slice(eq + 1).trim() || null;
    }
  }
  return null;
}
