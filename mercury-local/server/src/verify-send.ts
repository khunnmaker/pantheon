// Standalone verification of the SMTP send path WITHOUT any real credential.
// Run: npm run verify:send  (tsx server/src/verify-send.ts)
//
// It proves, with a MOCK MailTransport (no network, no SMTP, no App Password):
//   1. Dry-run renders the exact message: From=purchasing@, To, CC, subject, body, attachment
//      name + non-zero size — and touches no credential.
//   2. Send calls transport.sendMail({ from, to, cc, subject, text, attachments }) exactly once,
//      with From=purchasing@ alias, correct To/Cc/Subject, and the PO PDF attached (application/pdf,
//      pointing at the real generated file on disk).
//   3. On success the PO is marked 'sent', emailedAt is stamped, and the underlying local
//      PendingRequest is flipped to 'ordered' (Phase-3 cloud push-back is stubbed here).
//   4. A re-send of an already-sent PO is refused (no double-send).
//
// It seeds its own throwaway rows in the local DB and cleans them up, so it is safe to re-run.
import './env.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from './db.js';
import { PKG_ROOT } from './env.js';
import {
  renderMessage,
  buildMailMessage,
  sendMessage,
  SENDER_EMAIL,
  DEFAULT_MAIL_FROM,
  type MailTransport,
  type MailMessage,
  type EmailSpec,
} from './mail.js';
import { dryRunPoEmail, sendPoEmail } from './poEmail.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

// A minimal valid PDF (header + EOF) so the attachment is real bytes without pulling in pdfkit.
const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

// A mock SMTP transport capturing the exact sendMail() message — implements the same structural
// interface as nodemailer's Transporter.sendMail. No network, no auth, no App Password.
function makeMockTransport(): { transport: MailTransport; calls: MailMessage[] } {
  const calls: MailMessage[] = [];
  const transport: MailTransport = {
    async sendMail(message) {
      calls.push(message);
      return { messageId: 'mock-msg-id-123' };
    },
  };
  return { transport, calls };
}

async function main(): Promise<void> {
  console.log('mercury-local — SMTP send verification (mocked, no real credential)\n');

  // ── A. Pure unit-level checks on the message builder (no DB) ──────────────────────────────────
  const outDir = resolve(PKG_ROOT, 'po-output');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const pdfPath = resolve(outDir, '__verify_send__.pdf');
  writeFileSync(pdfPath, MINIMAL_PDF);

  const spec: EmailSpec = {
    to: 'vendor@example.com',
    cc: ['cc1@example.com', 'cc2@example.com'],
    subject: 'Purchase Order PO-TEST-001 — Prominent',
    body: 'Dear Vendor,\n\nPlease find attached PO-TEST-001.\n\nThank you,\nProminent Purchasing',
    attachmentPath: pdfPath,
    attachmentName: 'PO-TEST-001.pdf',
  };

  console.log('A. message builder + dry-run render:');
  const rendered = renderMessage(spec);
  check('From = purchasing@ alias with display name', rendered.from === DEFAULT_MAIL_FROM, rendered.from);
  check('From contains purchasing@', rendered.from.includes(SENDER_EMAIL));
  check('To preserved', rendered.to === 'vendor@example.com');
  check('CC preserved (2)', rendered.cc.length === 2 && rendered.cc[0] === 'cc1@example.com');
  check('attachment name', rendered.attachmentName === 'PO-TEST-001.pdf');
  check('attachment size > 0', rendered.attachmentBytes === MINIMAL_PDF.length, `${rendered.attachmentBytes} bytes`);
  check('attachment found', rendered.attachmentFound === true);

  const msg = buildMailMessage(spec);
  check('built From = purchasing@ alias', msg.from === DEFAULT_MAIL_FROM, msg.from);
  check('built To header', msg.to === 'vendor@example.com');
  check('built Cc header (comma-joined)', msg.cc === 'cc1@example.com, cc2@example.com');
  check('built Subject', msg.subject === 'Purchase Order PO-TEST-001 — Prominent');
  check('built plain-text body', msg.text === spec.body);
  check('exactly one attachment', msg.attachments.length === 1);
  check('attachment filename', msg.attachments[0]?.filename === 'PO-TEST-001.pdf');
  check('attachment content-type = application/pdf', msg.attachments[0]?.contentType === 'application/pdf');
  check('attachment path points at the PDF on disk', msg.attachments[0]?.path === pdfPath);

  // ── B. sendMessage() calls the transport with the right shape (mock) ──────────────────────────
  console.log('\nB. sendMessage() via mock transport:');
  const { transport: mockA, calls: callsA } = makeMockTransport();
  const resA = await sendMessage(mockA, spec);
  check('called sendMail() exactly once', callsA.length === 1);
  check('returned the mock message id', resA.id === 'mock-msg-id-123');
  check('sent From = purchasing@ alias', callsA[0]?.from === DEFAULT_MAIL_FROM);
  check('sent To', callsA[0]?.to === 'vendor@example.com');
  check('sent Cc', callsA[0]?.cc === 'cc1@example.com, cc2@example.com');
  check('sent subject', callsA[0]?.subject === 'Purchase Order PO-TEST-001 — Prominent');
  check('sent one PDF attachment', callsA[0]?.attachments.length === 1 && callsA[0]?.attachments[0]?.contentType === 'application/pdf');

  // ── C. End-to-end through poEmail against seeded DB rows (mock transport) ──────────────────────
  console.log('\nC. sendPoEmail() end-to-end (DB, mock transport):');
  const stamp = Date.now();
  const vendor = await prisma.vendor.create({
    data: {
      name: `__verify_vendor_${stamp}`,
      email: 'vendor@example.com',
      ccList: 'cc1@example.com, cc2@example.com',
      contactName: 'Mr. Test',
    },
  });
  const pendingReq = await prisma.pendingRequest.create({
    data: {
      cloudRequestId: `__verify_req_${stamp}`,
      itemId: `__verify_item_${stamp}`,
      qty: '10',
      status: 'pending',
      itemDisplayName: 'Widget A',
    },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      vendorId: vendor.id,
      poNumber: `PO-VERIFY-${stamp}`,
      status: 'draft',
      pdfPath,
      lines: {
        create: [
          {
            cloudItemId: `__verify_item_${stamp}`,
            cloudRequestId: `__verify_req_${stamp}`,
            realName: 'Real Widget A',
            qty: '10',
          },
        ],
      },
    },
  });

  // Dry-run first — must render, must NOT change the PO.
  const dry = await dryRunPoEmail(po.id);
  check('dry-run From = purchasing@', dry.from === DEFAULT_MAIL_FROM);
  check('dry-run To from vendor', dry.to === 'vendor@example.com');
  check('dry-run CC from vendor ccList', dry.cc.length === 2);
  check('dry-run attachment found', dry.attachmentFound === true);
  const poAfterDry = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
  check('dry-run did NOT send (still draft)', poAfterDry?.status === 'draft');

  // Now send with the mock transport (explicit) — proves the success bookkeeping. The cloud status
  // push is stubbed (records the call) so this stays hermetic (no network); Phase-3 cloud push is
  // proven separately in verify-loop.ts.
  const { transport: mockC } = makeMockTransport();
  const pushed: { ids: string[]; status: string }[] = [];
  const outcome = await sendPoEmail(po.id, undefined, mockC, async (ids, status) => {
    pushed.push({ ids, status });
    return { pushed: ids.length };
  });
  check('send returned a message id', outcome.messageId === 'mock-msg-id-123');
  check('send marked 1 pending request ordered', outcome.markedOrdered === 1);
  check('send pushed 1 cloud status (ordered)', outcome.cloudPushed === 1 && pushed[0]?.status === 'ordered');
  const poAfter = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
  check("PO status = 'sent'", poAfter?.status === 'sent');
  check('PO emailedAt stamped', !!poAfter?.emailedAt);
  const reqAfter = await prisma.pendingRequest.findUnique({ where: { id: pendingReq.id } });
  check("underlying PendingRequest status = 'ordered'", reqAfter?.status === 'ordered');

  // Guard: a second send of an already-sent PO is refused (no double-send).
  let refused = false;
  try {
    await sendPoEmail(po.id, undefined, mockC);
  } catch {
    refused = true;
  }
  check('re-send of an already-sent PO is refused', refused);

  // ── Cleanup ────────────────────────────────────────────────────────────────────────────────
  await prisma.purchaseOrder.delete({ where: { id: po.id } });
  await prisma.pendingRequest.delete({ where: { id: pendingReq.id } });
  await prisma.vendor.delete({ where: { id: vendor.id } });
  if (existsSync(pdfPath)) rmSync(pdfPath);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — no real SMTP credential was used.`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('verify-send crashed:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
