// PO email composition + review-then-send orchestration (Phase 2c). Builds the default,
// EDITABLE email for a draft PO (To/CC/subject/body prefilled from the vendor), renders the
// dry-run, and — only on an explicit send — dispatches via SMTP (nodemailer) and marks the PO sent.
//
// REVIEW-THEN-SEND, NEVER AUTO-SEND: there is exactly ONE code path that sends mail
// (sendPoEmail), and it is only reachable from the POST /api/purchase-orders/:id/send route, which
// is only hit by the owner clicking Send. No scheduler, no cron, no implicit send anywhere.
// See docs/MERCURY_BRIEF.md §6.
import './env.js';
import { prisma } from './db.js';
import {
  renderMessage,
  sendMessage,
  makeMailTransport,
  MailError,
  type EmailSpec,
  type RenderedMessage,
  type MailTransport,
} from './mail.js';
import { loadConnection } from './connection.js';
import { cloudPatchStatus, CloudError } from './cloud.js';

// The composed, editable defaults handed to the review UI. The owner may edit To/CC/subject/body
// before sending; the PDF attachment is fixed (the generated PO).
export interface ComposedEmail {
  poId: string;
  poNumber: string;
  vendorName: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  attachmentName: string;
  attachmentBytes: number;
  attachmentFound: boolean; // false → owner must generate the PDF first
  alreadySent: boolean; // PO.status === 'sent'
}

function splitCc(ccList: string): string[] {
  return ccList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Default subject + body — clean ENGLISH (matches the PDF + the retired skills' tone).
function defaultSubject(poNumber: string): string {
  return `Purchase Order ${poNumber} — Prominent`;
}

function defaultBody(opts: {
  vendorName: string;
  contactName: string;
  poNumber: string;
  lineCount: number;
}): string {
  const greeting = opts.contactName ? `Dear ${opts.contactName},` : `Dear ${opts.vendorName},`;
  return [
    greeting,
    '',
    `Please find attached our Purchase Order ${opts.poNumber} (${opts.lineCount} item${opts.lineCount === 1 ? '' : 's'}).`,
    '',
    'Kindly confirm receipt of this order and the expected ship date at your earliest convenience.',
    '',
    'Thank you,',
    'Prominent Purchasing',
    'purchasing@prominentdental.com',
  ].join('\n');
}

// Load a PO and build the default editable email. Throws MailError with a clear message/status on
// the not-found / no-vendor / no-PDF cases so the route can translate them.
export async function composePoEmail(poId: string): Promise<ComposedEmail> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { vendor: true, lines: true },
  });
  if (!po) throw new MailError('po not found', 404);
  if (!po.vendor) throw new MailError('po has no vendor', 409);

  const poNumber = po.poNumber ?? po.id;
  // The attachment is the generated PDF (may not exist yet — rendered.attachmentFound reflects it).
  const spec: EmailSpec = {
    to: po.vendor.email,
    cc: splitCc(po.vendor.ccList),
    subject: defaultSubject(poNumber),
    body: defaultBody({
      vendorName: po.vendor.name,
      contactName: po.vendor.contactName,
      poNumber,
      lineCount: po.lines.length,
    }),
    attachmentPath: po.pdfPath ?? '',
    attachmentName: `${poNumber}.pdf`,
  };
  const rendered = renderMessage(spec);
  return {
    poId: po.id,
    poNumber,
    vendorName: po.vendor.name,
    to: rendered.to,
    cc: rendered.cc,
    subject: rendered.subject,
    body: rendered.body,
    attachmentName: rendered.attachmentName,
    attachmentBytes: rendered.attachmentBytes,
    attachmentFound: rendered.attachmentFound,
    alreadySent: po.status === 'sent',
  };
}

// Overrides the owner may pass from the review UI. Anything omitted falls back to the PO default.
export interface SendOverrides {
  to?: string;
  cc?: string[];
  subject?: string;
  body?: string;
}

// Build the concrete EmailSpec for a PO given optional owner overrides. Requires the PDF to exist.
async function buildSpec(poId: string, overrides?: SendOverrides): Promise<{ spec: EmailSpec; poNumber: string }> {
  const composed = await composePoEmail(poId);
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po?.pdfPath) throw new MailError('PO PDF not generated yet — generate it first', 409);
  const spec: EmailSpec = {
    to: (overrides?.to ?? composed.to).trim(),
    cc: (overrides?.cc ?? composed.cc).map((c) => c.trim()).filter(Boolean),
    subject: (overrides?.subject ?? composed.subject).trim(),
    body: overrides?.body ?? composed.body,
    attachmentPath: po.pdfPath,
    attachmentName: `${composed.poNumber}.pdf`,
  };
  if (!spec.to) throw new MailError('recipient (To) is empty — set the vendor email', 409);
  return { spec, poNumber: composed.poNumber };
}

// DRY-RUN: render the EXACT outgoing message (From/To/CC/subject/body + attachment name/size)
// WITHOUT sending. No SMTP transport, no credential touched.
export async function dryRunPoEmail(poId: string, overrides?: SendOverrides): Promise<RenderedMessage> {
  const { spec } = await buildSpec(poId, overrides);
  return renderMessage(spec);
}

// SEND: the one and only path that dispatches mail. `transport` is injectable for tests; when
// omitted, the real SMTP transport is built. On success: mark the PO sent + stamp emailedAt,
// and mark the underlying local PendingRequests 'ordered' (cloud status push-back is Phase 3).
export interface SendOutcome {
  messageId: string;
  poId: string;
  poNumber: string;
  markedOrdered: number; // how many local PendingRequests were flipped to 'ordered'
  cloudPushed: number; // how many cloud MercuryRequests were PATCHed → 'ordered' (Phase 3)
  cloudPushError?: string; // set if the cloud status push failed (send + local update still stand)
}

// Push a set of cloud MercuryRequest ids to a status (Phase 3). Best-effort: never throws — a
// cloud-unreachable / expired-session leaves the successful local send + PO update intact, and the
// next Sync will reconcile. Returns how many were pushed and the first error message (if any).
// Injectable pusher for tests (defaults to the real cloud client).
export async function pushCloudStatus(
  requestIds: string[],
  status: string,
  pusher: (baseUrl: string, token: string, id: string, status: string) => Promise<void> = cloudPatchStatus,
): Promise<{ pushed: number; error?: string }> {
  if (!requestIds.length) return { pushed: 0 };
  const conn = loadConnection();
  if (!conn) return { pushed: 0, error: 'not connected — status not pushed to cloud' };
  let pushed = 0;
  let error: string | undefined;
  for (const id of requestIds) {
    try {
      await pusher(conn.baseUrl, conn.token, id, status);
      pushed++;
    } catch (e) {
      // Record the first failure; keep trying the rest (partial push is still progress).
      if (!error) error = e instanceof CloudError ? e.message : 'cloud push failed';
    }
  }
  return { pushed, error };
}

export async function sendPoEmail(
  poId: string,
  overrides?: SendOverrides,
  transport?: MailTransport,
  pushCloud: (ids: string[], status: string) => Promise<{ pushed: number; error?: string }> = (ids, status) =>
    pushCloudStatus(ids, status),
): Promise<SendOutcome> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
  if (!po) throw new MailError('po not found', 404);
  if (po.status === 'sent') throw new MailError('this PO was already sent', 409);

  const { spec, poNumber } = await buildSpec(poId, overrides);
  const mail = transport ?? (await makeMailTransport());
  const { id: messageId } = await sendMessage(mail, spec);

  // Success → local bookkeeping. Mark the PO sent + stamp the audit time.
  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: 'sent', emailedAt: new Date() },
  });

  // Mark the underlying local PendingRequests 'ordered' so the local view reflects it.
  const cloudRequestIds = Array.from(
    new Set(po.lines.map((l) => l.cloudRequestId).filter((x) => x && x.trim())),
  );
  let markedOrdered = 0;
  if (cloudRequestIds.length) {
    const upd = await prisma.pendingRequest.updateMany({
      where: { cloudRequestId: { in: cloudRequestIds }, status: { not: 'ordered' } },
      data: { status: 'ordered' },
    });
    markedOrdered = upd.count;
  }

  // Phase 3 — push 'ordered' back to the cloud MercuryRequests so the phone/board shows "สั่งแล้ว".
  // Best-effort: a cloud-unreachable failure never rolls back the successful send / local update.
  const { pushed: cloudPushed, error: cloudPushError } = await pushCloud(cloudRequestIds, 'ordered');

  return { messageId, poId, poNumber, markedOrdered, cloudPushed, cloudPushError };
}

export { MailError };
