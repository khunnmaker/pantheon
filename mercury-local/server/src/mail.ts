// SMTP send integration for local-Mercury (Phase 2c). Sends a Purchase Order email via SMTP
// (nodemailer) authenticated with a Google App Password. See docs/MERCURY_BRIEF.md §6
// (review-then-send, NEVER auto-send) + §8 (security: the App Password lives ONLY on the owner's
// machine, gitignored).
//
// SENDER MODEL (from the owner's setup):
//   - The message From header is "Prominent Purchasing <purchasing@prominentdental.com>".
//   - purchasing@ is a VERIFIED "Send mail as" ALIAS on the Google Workspace seat
//     khunnakritr@prominentdental.com. SMTP authenticates AS khunnakritr@prominentdental.com
//     (SMTP_USER), and lets us set From to the verified purchasing@ alias.
//   - DKIM is already published; SPF + DMARC are added during owner setup (see the runbook).
//
// WHY SMTP + App Password (not OAuth): a single-user on-prem tool. An App Password (16 chars,
// requires 2-Step Verification on the account) is simpler than an OAuth client + refresh-token
// dance and needs no GCP project. The owner generates it once and pastes it into a local config.
//
// CREDENTIAL FILE (gitignored — never committed):
//   - .mercury-smtp.json  — { SMTP_HOST?, SMTP_PORT?, SMTP_SECURE?, SMTP_USER, SMTP_PASS, MAIL_FROM? }
//     Only SMTP_USER + SMTP_PASS are required; the rest default to Gmail's SMTP + the purchasing@
//     From header. Environment variables of the same names override the file.
//
// TESTABILITY: every function that would touch SMTP takes an injectable MailTransport (structurally
// nodemailer's Transporter — just .sendMail(message)), so the whole send path is verifiable with a
// MOCK and NO real credential (see server/src/verify-send.ts). The default factory builds the real
// nodemailer SMTP transport from the local config.
import './env.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, resolve, isAbsolute } from 'node:path';
import { PKG_ROOT } from './env.js';

// ── Constants ────────────────────────────────────────────────────────────────
// The verified send-as alias + display name for the From header.
export const SENDER_EMAIL = 'purchasing@prominentdental.com';
export const SENDER_NAME = 'Prominent Purchasing';
// The Workspace seat SMTP authenticates as (the alias hangs off this account).
export const AUTH_ACCOUNT_HINT = 'khunnakritr@prominentdental.com';

// SMTP defaults (Gmail submission over implicit TLS).
export const DEFAULT_SMTP_HOST = 'smtp.gmail.com';
export const DEFAULT_SMTP_PORT = 465;
export const DEFAULT_SMTP_SECURE = true;
export const DEFAULT_MAIL_FROM = `${SENDER_NAME} <${SENDER_EMAIL}>`;

// Gitignored SMTP config path (see .gitignore).
export const SMTP_CONFIG_FILE = resolve(PKG_ROOT, '.mercury-smtp.json');

// ── A tidy error carrying an http-ish status so routes can translate to a clear message. ──────
export class MailError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
    this.name = 'MailError';
  }
}

// ── SMTP config (the gitignored JSON, overridable by env of the same key names) ────────────────
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

// A raw (possibly-incomplete) config as read from file/env — user/pass may be missing until the
// owner fills them in. Used by loadSmtpConfig() / smtpStatus().
interface RawSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

function readSmtpFile(): Record<string, unknown> {
  if (!existsSync(SMTP_CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(SMTP_CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    throw new MailError('.mercury-smtp.json is not valid JSON', 400);
  }
}

// Merge file + env (env wins) into a raw config with defaults applied. Missing user/pass surface as
// empty strings so smtpStatus() can report "not configured" without throwing.
function readRawConfig(): RawSmtpConfig {
  const file = readSmtpFile();
  const pick = (key: string): string | undefined => {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') return String(fromEnv).trim();
    const fromFile = file[key];
    if (fromFile !== undefined && fromFile !== null && String(fromFile).trim() !== '')
      return String(fromFile).trim();
    return undefined;
  };
  const host = pick('SMTP_HOST') ?? DEFAULT_SMTP_HOST;
  const portRaw = pick('SMTP_PORT');
  const port = portRaw ? Number(portRaw) : DEFAULT_SMTP_PORT;
  const secureRaw = pick('SMTP_SECURE');
  const secure = secureRaw === undefined ? DEFAULT_SMTP_SECURE : /^(1|true|yes)$/i.test(secureRaw);
  const user = pick('SMTP_USER') ?? '';
  const pass = pick('SMTP_PASS') ?? '';
  const from = pick('MAIL_FROM') ?? DEFAULT_MAIL_FROM;
  return { host, port: Number.isFinite(port) ? port : DEFAULT_SMTP_PORT, secure, user, pass, from };
}

// Load a COMPLETE, ready-to-send config. Throws MailError(409) if user or pass is missing, so the
// send path fails cleanly with a clear message instead of a raw nodemailer auth error.
export function loadSmtpConfig(): SmtpConfig {
  const raw = readRawConfig();
  if (!raw.user)
    throw new MailError('SMTP not configured — set SMTP_USER in .mercury-smtp.json', 409);
  if (!raw.pass)
    throw new MailError('SMTP not configured — set SMTP_PASS (the App Password) in .mercury-smtp.json', 409);
  return raw;
}

// Redacted status for the UI — NEVER exposes the App Password.
export interface SmtpStatus {
  configured: boolean; // both SMTP_USER and SMTP_PASS are present
  host: string;
  port: number;
  secure: boolean;
  smtpUser?: string; // the auth account (e.g. khunnakritr@) — display only, not a secret
  senderEmail: string; // purchasing@prominentdental.com (from the From header)
  senderName: string; // Prominent Purchasing
  mailFrom: string; // the full From header
  authAccountHint: string;
}

export function smtpStatus(): SmtpStatus {
  let raw: RawSmtpConfig;
  try {
    raw = readRawConfig();
  } catch {
    // Malformed JSON — surface as "not configured"; the connect/send route re-reads for detail.
    raw = { host: DEFAULT_SMTP_HOST, port: DEFAULT_SMTP_PORT, secure: DEFAULT_SMTP_SECURE, user: '', pass: '', from: DEFAULT_MAIL_FROM };
  }
  const configured = !!raw.user && !!raw.pass;
  return {
    configured,
    host: raw.host,
    port: raw.port,
    secure: raw.secure,
    smtpUser: raw.user || undefined,
    senderEmail: SENDER_EMAIL,
    senderName: SENDER_NAME,
    mailFrom: raw.from,
    authAccountHint: AUTH_ACCOUNT_HINT,
  };
}

// ── Message construction ───────────────────────────────────────────────────────────────────────
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

// The From header. Comes from MAIL_FROM (config), defaulting to the purchasing@ alias with display
// name. The dry-run/render path uses the default (no config needed to preview); the send path uses
// the configured value (which is the same default unless the owner overrode MAIL_FROM).
function fromHeader(): string {
  try {
    return readRawConfig().from || DEFAULT_MAIL_FROM;
  } catch {
    return DEFAULT_MAIL_FROM;
  }
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

// Render the message for review/dry-run WITHOUT building the SMTP payload or sending anything.
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

// ── The mockable SMTP seam ─────────────────────────────────────────────────────────────────────
// The nodemailer message object we hand to transport.sendMail(). Structurally a subset of
// nodemailer's SendMailOptions — everything the send path sets.
export interface MailMessage {
  from: string;
  to: string;
  cc?: string; // comma-joined (nodemailer accepts a string list)
  subject: string;
  text: string; // plain-text body
  attachments: { filename: string; path: string; contentType: string }[];
}

// A minimal structural interface matching nodemailer's Transporter.sendMail — everything the send
// path uses. The mock in verify-send.ts implements exactly this, so no real credential is needed to
// prove the call shape.
export interface MailTransport {
  sendMail(message: MailMessage): Promise<{ messageId?: string }>;
}

// Build the nodemailer message from an EmailSpec (+ the configured From). Throws if the PDF is
// missing. Split out from send so it is unit-testable without a transport.
export function buildMailMessage(spec: EmailSpec, from: string = fromHeader()): MailMessage {
  const att = resolveAttachment(spec.attachmentPath);
  if (!att.exists)
    throw new MailError(`attachment not found: ${spec.attachmentPath} — generate the PDF first`, 409);
  const filename = spec.attachmentName?.trim() || basename(att.path);
  const cc = spec.cc.filter((c) => c.trim());
  return {
    from,
    to: spec.to,
    ...(cc.length ? { cc: cc.join(', ') } : {}),
    subject: spec.subject,
    text: spec.body,
    attachments: [{ filename, path: att.path, contentType: 'application/pdf' }],
  };
}

// Factory for the REAL nodemailer SMTP transport. Lazily imports nodemailer so mocked tests and the
// dry-run path never load it. Throws MailError (never a raw nodemailer error) on missing config.
export async function makeMailTransport(): Promise<MailTransport> {
  const cfg = loadSmtpConfig(); // throws MailError(409) if user/pass missing
  const nodemailer = await import('nodemailer');
  const create = (nodemailer as unknown as { default?: typeof import('nodemailer'); createTransport?: typeof import('nodemailer').createTransport }).createTransport
    ?? (nodemailer as unknown as { default: typeof import('nodemailer') }).default.createTransport;
  const transport = create({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return transport as unknown as MailTransport;
}

// ── Send ────────────────────────────────────────────────────────────────────────────────────
export interface SendResult {
  id: string; // SMTP message id
}

// Send the PO email. `transport` is injected so the path is testable with a mock; production passes
// the result of makeMailTransport(). The From header is the verified purchasing@ alias; SMTP auth is
// khunnakritr@ (SMTP_USER). `from` is threaded from the configured MAIL_FROM so the sent message
// matches the config (tests pass the default).
export async function sendMessage(transport: MailTransport, spec: EmailSpec, from: string = fromHeader()): Promise<SendResult> {
  const message = buildMailMessage(spec, from);
  const res = await transport.sendMail(message);
  const id = res?.messageId;
  if (!id) throw new MailError('SMTP accepted the message but returned no message id', 502);
  return { id };
}
