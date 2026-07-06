// Gmail send integration for local-Mercury (Phase 2c). Sends a Purchase Order email via the
// Gmail API using OAuth2. See docs/MERCURY_BRIEF.md §6 (review-then-send, NEVER auto-send) + §8
// (security: the token lives ONLY on the owner's machine, gitignored, revocable).
//
// SENDER MODEL (from the owner's setup):
//   - The message From header is "Prominent Purchasing <purchasing@prominentdental.com>".
//   - purchasing@ is a VERIFIED "Send mail as" ALIAS on the Google Workspace seat
//     khunnakritr@prominentdental.com. So OAuth authenticates AS khunnakritr@prominentdental.com
//     (a distinct account from the owner's personal gmail), and Gmail lets us set From=purchasing@.
//   - DKIM is already published; SPF+DMARC are added during owner setup (see the runbook).
//
// CREDENTIAL FILES (both gitignored — never committed):
//   - gmail-oauth-client.json  — the OAuth *client* (client_id/secret) the owner downloads from a
//                                GCP project. Desktop/installed-app client (loopback redirect).
//   - gmail-token.json         — the *refresh token* saved after the owner authorizes once.
//
// TESTABILITY: every function that would touch Google takes an injectable GmailClient/OAuth2-like
// object, so the whole send path is verifiable with a MOCK and NO real credential (see
// server/src/verify-send.ts). The default factory builds the real googleapis client.
import './env.js';
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { basename, resolve, isAbsolute } from 'node:path';
import { PKG_ROOT } from './env.js';

// ── Constants ────────────────────────────────────────────────────────────────
// Minimal Gmail SEND scope — nothing else. (No read, no modify, no full mail.)
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
// The verified send-as alias + display name for the From header.
export const SENDER_EMAIL = 'purchasing@prominentdental.com';
export const SENDER_NAME = 'Prominent Purchasing';
// The Workspace seat OAuth must authenticate as (the alias hangs off this account).
export const AUTH_ACCOUNT_HINT = 'khunnakritr@prominentdental.com';
// Loopback redirect for the installed-app flow. Port is fixed so the runbook can list it as an
// authorized redirect URI; the desktop OAuth client type also accepts arbitrary loopback ports.
export const OAUTH_LOOPBACK_PORT = 4620;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`;

// Gitignored credential paths (see .gitignore).
export const OAUTH_CLIENT_FILE = resolve(PKG_ROOT, 'gmail-oauth-client.json');
export const TOKEN_FILE = resolve(PKG_ROOT, 'gmail-token.json');

// ── A tidy error carrying an http-ish status so routes can translate to a clear message. ──────
export class GmailError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
    this.name = 'GmailError';
  }
}

// ── OAuth client credentials (the downloaded GCP JSON) ────────────────────────────────────────
export interface OAuthClientCreds {
  clientId: string;
  clientSecret: string;
}

// Read + normalise the downloaded OAuth client JSON. Google emits it as { installed: {...} } for a
// Desktop client (or { web: {...} }); accept both plus a flat shape. Returns null if absent.
export function loadOAuthClient(): OAuthClientCreds | null {
  if (!existsSync(OAUTH_CLIENT_FILE)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(OAUTH_CLIENT_FILE, 'utf8'));
  } catch {
    throw new GmailError('gmail-oauth-client.json is not valid JSON', 400);
  }
  const obj = raw as Record<string, unknown>;
  const inner = (obj.installed ?? obj.web ?? obj) as Record<string, unknown>;
  const clientId = String(inner.client_id ?? inner.clientId ?? '').trim();
  const clientSecret = String(inner.client_secret ?? inner.clientSecret ?? '').trim();
  if (!clientId || !clientSecret)
    throw new GmailError('gmail-oauth-client.json is missing client_id / client_secret', 400);
  return { clientId, clientSecret };
}

// ── Stored refresh token ──────────────────────────────────────────────────────────────────────
export interface StoredToken {
  refresh_token: string;
  authorizedEmail?: string; // who authorized (display only) — expected khunnakritr@prominentdental.com
  authorizedAt?: string; // ISO
  scope?: string;
}

export function loadToken(): StoredToken | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Partial<StoredToken>;
    if (!raw.refresh_token) return null;
    return {
      refresh_token: String(raw.refresh_token),
      authorizedEmail: raw.authorizedEmail ? String(raw.authorizedEmail) : undefined,
      authorizedAt: raw.authorizedAt ? String(raw.authorizedAt) : undefined,
      scope: raw.scope ? String(raw.scope) : undefined,
    };
  } catch {
    return null; // corrupt → treat as not connected
  }
}

export function saveToken(t: StoredToken): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { encoding: 'utf8' });
}

export function clearToken(): void {
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
}

// Redacted status for the UI — never exposes the refresh token itself.
export interface GmailStatus {
  connected: boolean; // a refresh token is stored
  clientReady: boolean; // the OAuth client JSON is present
  authorizedEmail?: string;
  authorizedAt?: string;
  senderEmail: string;
  senderName: string;
  authAccountHint: string;
}

export function gmailStatus(): GmailStatus {
  const token = loadToken();
  let clientReady = false;
  try {
    clientReady = !!loadOAuthClient();
  } catch {
    clientReady = false; // present but malformed — surface as "not ready" (route re-reads for detail)
  }
  return {
    connected: !!token,
    clientReady,
    authorizedEmail: token?.authorizedEmail,
    authorizedAt: token?.authorizedAt,
    senderEmail: SENDER_EMAIL,
    senderName: SENDER_NAME,
    authAccountHint: AUTH_ACCOUNT_HINT,
  };
}

// ── MIME message construction ──────────────────────────────────────────────────────────────────
export interface EmailSpec {
  to: string;
  cc: string[]; // may be empty
  subject: string;
  body: string; // plain-text body
  attachmentPath: string; // absolute path to the PO PDF
  attachmentName?: string; // override the filename shown to the recipient
}

// A rendered view of the outgoing message — safe to show in the dry-run / review UI. Contains NO
// credential, only what the recipient would see plus the attachment's name+size.
export interface RenderedMessage {
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  attachmentName: string;
  attachmentBytes: number;
  attachmentFound: boolean;
}

function fromHeader(): string {
  return `${SENDER_NAME} <${SENDER_EMAIL}>`;
}

// Encode a header value that may contain non-ASCII (e.g. a Thai vendor name in the subject) as an
// RFC 2047 "encoded-word". ASCII-only values pass through untouched.
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// Resolve the attachment path (absolute, or relative to the package root) and read its stats.
// An empty path (PO PDF not generated yet) → not found, never resolves to a directory.
function resolveAttachment(attachmentPath: string): { path: string; exists: boolean; bytes: number } {
  if (!attachmentPath || !attachmentPath.trim()) return { path: '', exists: false, bytes: 0 };
  const p = isAbsolute(attachmentPath) ? attachmentPath : resolve(PKG_ROOT, attachmentPath);
  try {
    const st = statSync(p);
    if (!st.isFile()) return { path: p, exists: false, bytes: 0 };
    return { path: p, exists: true, bytes: st.size };
  } catch {
    return { path: p, exists: false, bytes: 0 };
  }
}

// Render the message for review/dry-run WITHOUT building the raw MIME or sending anything.
export function renderMessage(spec: EmailSpec): RenderedMessage {
  const att = resolveAttachment(spec.attachmentPath);
  return {
    from: fromHeader(),
    to: spec.to,
    cc: spec.cc.filter((c) => c.trim()),
    subject: spec.subject,
    body: spec.body,
    attachmentName: spec.attachmentName?.trim() || basename(att.path),
    attachmentBytes: att.bytes,
    attachmentFound: att.exists,
  };
}

// Build the raw RFC 5322 MIME message (multipart/mixed: text body + base64 PDF attachment) and
// return it base64url-encoded as the Gmail API `raw` field expects. Throws if the PDF is missing.
export function buildRawMessage(spec: EmailSpec): string {
  const att = resolveAttachment(spec.attachmentPath);
  if (!att.exists)
    throw new GmailError(`attachment not found: ${spec.attachmentPath} — generate the PDF first`, 409);
  const pdf = readFileSync(att.path);
  const filename = spec.attachmentName?.trim() || basename(att.path);
  const cc = spec.cc.filter((c) => c.trim());

  const boundary = `mercury_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    `From: ${fromHeader()}`,
    `To: ${spec.to}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(spec.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  // The PDF is chunked into 76-char base64 lines per MIME convention.
  const pdfB64 = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');

  const parts = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(spec.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    pdfB64,
    '',
    `--${boundary}--`,
    '',
  ];
  const mime = parts.join('\r\n');
  // Gmail API wants base64url (RFC 4648 §5): +→-, /→_, strip padding.
  return Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── The mockable Gmail seam ────────────────────────────────────────────────────────────────────
// A minimal structural interface matching googleapis' gmail.users.messages.send — everything the
// send path uses. The mock in verify-send.ts implements exactly this, so no real credential is
// needed to prove the call shape.
export interface GmailClient {
  users: {
    messages: {
      send(params: {
        userId: string;
        requestBody: { raw: string };
      }): Promise<{ data: { id?: string | null } }>;
    };
  };
}

// Factory for the REAL authenticated Gmail client. Lazily imports googleapis so that mocked tests
// and the dry-run path never load it. Throws GmailError (never a raw googleapis error) on any
// missing-credential condition so routes render a clean message.
export async function makeGmailClient(): Promise<GmailClient> {
  const creds = loadOAuthClient();
  if (!creds) throw new GmailError('OAuth client not configured — drop gmail-oauth-client.json in', 409);
  const token = loadToken();
  if (!token) throw new GmailError('Gmail not connected — click "Connect Gmail" first', 409);

  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, OAUTH_REDIRECT_URI);
  oauth2.setCredentials({ refresh_token: token.refresh_token });
  return google.gmail({ version: 'v1', auth: oauth2 }) as unknown as GmailClient;
}

// ── Send ────────────────────────────────────────────────────────────────────────────────────
export interface SendResult {
  id: string; // Gmail message id
}

// Send the PO email. `client` is injected so the path is testable with a mock; production passes
// the result of makeGmailClient(). userId 'me' = the authenticated account (khunnakritr@), and the
// From header (built into the raw MIME) is the verified purchasing@ alias.
export async function sendMessage(client: GmailClient, spec: EmailSpec): Promise<SendResult> {
  const raw = buildRawMessage(spec);
  const res = await client.users.messages.send({ userId: 'me', requestBody: { raw } });
  const id = res?.data?.id;
  if (!id) throw new GmailError('Gmail accepted the request but returned no message id', 502);
  return { id };
}

// ── OAuth loopback "Connect Gmail" flow ─────────────────────────────────────────────────────────
// Installed-app / loopback flow for a desktop app: spin up a one-shot localhost server on
// OAUTH_LOOPBACK_PORT, open the consent URL in the browser, catch the redirect with the code,
// exchange it for a refresh token, save it, and shut the server down. Handles "no client file"
// gracefully (caller checks loadOAuthClient first / catches GmailError).
export interface ConnectStartResult {
  authUrl: string; // the Google consent URL the owner must visit
}

// Build the consent URL (used by the connect flow). Split out so it's unit-testable without a net.
export async function buildAuthUrl(): Promise<string> {
  const creds = loadOAuthClient();
  if (!creds) throw new GmailError('OAuth client not configured — drop gmail-oauth-client.json in', 409);
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, OAUTH_REDIRECT_URI);
  return oauth2.generateAuthUrl({
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // force a refresh token even on re-consent
    scope: [GMAIL_SEND_SCOPE],
    login_hint: AUTH_ACCOUNT_HINT, // pre-fill khunnakritr@prominentdental.com in the picker
  });
}

// Run the full loopback exchange: opens the browser to consent, waits for the redirect, exchanges
// the code, saves the refresh token. Resolves with the authorized email (best-effort). This is the
// ONLY function that binds the loopback port; it always closes it. Times out after `timeoutMs`.
export async function runConnectFlow(
  openBrowser: (url: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<{ authorizedEmail?: string }> {
  const creds = loadOAuthClient();
  if (!creds) throw new GmailError('OAuth client not configured — drop gmail-oauth-client.json in', 409);
  const { google } = await import('googleapis');
  const { createServer } = await import('node:http');
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, OAUTH_REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GMAIL_SEND_SCOPE],
    login_hint: AUTH_ACCOUNT_HINT,
  });

  return new Promise<{ authorizedEmail?: string }>((resolvePromise, rejectPromise) => {
    let settled = false;
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URI);
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<h2>Authorization failed: ${err}</h2><p>You can close this tab.</p>`);
          finish(new GmailError(`authorization denied: ${err}`, 400));
          return;
        }
        if (!code) {
          // Ignore favicon / stray hits; keep waiting for the real redirect.
          res.writeHead(204);
          res.end();
          return;
        }
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            '<h2>No refresh token returned</h2><p>Remove Mercury from your Google account access and re-connect (needs a fresh consent). You can close this tab.</p>',
          );
          finish(new GmailError('no refresh token returned — revoke + reconnect for a fresh consent', 400));
          return;
        }
        // Best-effort: read which account authorized, for display/verification in the runbook.
        let authorizedEmail: string | undefined;
        try {
          oauth2.setCredentials(tokens);
          const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
          const info = await oauth2Api.userinfo.get();
          authorizedEmail = info.data.email ?? undefined;
        } catch {
          /* userinfo scope not granted (we only ask gmail.send) — fine, leave undefined */
        }
        saveToken({
          refresh_token: tokens.refresh_token,
          authorizedEmail,
          authorizedAt: new Date().toISOString(),
          scope: GMAIL_SEND_SCOPE,
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<h2>Mercury is connected to Gmail.</h2><p>Authorized as ${authorizedEmail ?? AUTH_ACCOUNT_HINT}. You can close this tab and return to Mercury.</p>`,
        );
        finish(null, { authorizedEmail });
      } catch (e) {
        try {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<h2>Something went wrong finishing the connection.</h2><p>You can close this tab.</p>');
        } catch {
          /* response already sent */
        }
        finish(e instanceof Error ? e : new GmailError('connect flow failed'));
      }
    });

    const timer = setTimeout(() => {
      finish(new GmailError('Gmail connect timed out — try again', 408));
    }, timeoutMs);

    function finish(err: Error | null, ok?: { authorizedEmail?: string }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) rejectPromise(err);
      else resolvePromise(ok ?? {});
    }

    server.on('error', (e) => finish(new GmailError(`could not bind loopback port ${OAUTH_LOOPBACK_PORT}: ${e.message}`, 500)));
    server.listen(OAUTH_LOOPBACK_PORT, '127.0.0.1', () => {
      // Server is up — now open the consent page.
      openBrowser(authUrl);
    });
  });
}
