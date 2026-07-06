// Cloud connection state for local-Mercury. The owner enters the cloud api base URL and
// authenticates by REUSING THE SUITE LOGIN (his supervisor credentials → a JWT). We persist the
// base URL + JWT in a LOCAL, GITIGNORED file so the app survives restarts without re-login.
//
// SECURITY: this file holds a live suite JWT (a bearer token). It lives ONLY on the owner's
// machine (same trust boundary as the secrets DB) and is gitignored. Never commit it, never log
// its contents. The password is NEVER stored — only the resulting token.
import './env.js';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PKG_ROOT } from './env.js';

// The gitignored connection file (see .gitignore: .mercury-connection.json).
const CONNECTION_FILE = resolve(PKG_ROOT, '.mercury-connection.json');

export interface Connection {
  baseUrl: string; // cloud api base, e.g. https://minerva-api.up.railway.app (no trailing slash)
  token: string; // suite JWT (supervisor). Bearer for /api/mercury/*.
  agentName?: string; // display only — who we logged in as
  agentEmail?: string; // display only
  connectedAt?: string; // ISO — when we last authenticated
}

// A redacted view safe to return to the client UI (NEVER expose the token).
export interface ConnectionStatus {
  connected: boolean;
  baseUrl: string;
  agentName?: string;
  agentEmail?: string;
  connectedAt?: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConnection(): Connection | null {
  if (!existsSync(CONNECTION_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONNECTION_FILE, 'utf8')) as Partial<Connection>;
    if (!raw.baseUrl || !raw.token) return null;
    return {
      baseUrl: stripTrailingSlash(String(raw.baseUrl)),
      token: String(raw.token),
      agentName: raw.agentName ? String(raw.agentName) : undefined,
      agentEmail: raw.agentEmail ? String(raw.agentEmail) : undefined,
      connectedAt: raw.connectedAt ? String(raw.connectedAt) : undefined,
    };
  } catch {
    return null; // corrupt file — treat as not connected
  }
}

export function saveConnection(conn: Connection): void {
  const clean: Connection = { ...conn, baseUrl: stripTrailingSlash(conn.baseUrl) };
  // 0600-ish intent: written into the owner's already-encrypted machine. JSON, pretty for
  // human inspection; the token is the only sensitive field.
  writeFileSync(CONNECTION_FILE, JSON.stringify(clean, null, 2), { encoding: 'utf8' });
}

export function clearConnection(): void {
  if (existsSync(CONNECTION_FILE)) rmSync(CONNECTION_FILE);
}

// Redact for the UI — connected flag + non-secret metadata only.
export function toStatus(conn: Connection | null): ConnectionStatus {
  if (!conn) return { connected: false, baseUrl: '' };
  return {
    connected: true,
    baseUrl: conn.baseUrl,
    agentName: conn.agentName,
    agentEmail: conn.agentEmail,
    connectedAt: conn.connectedAt,
  };
}

export { CONNECTION_FILE };
