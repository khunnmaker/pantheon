// Standalone verification of the Gmail send path WITHOUT any real Google credential.
// Run: npm run verify:send  (tsx server/src/verify-send.ts)
//
// It proves, with a MOCK GmailClient (no network, no OAuth, no token):
//   1. Dry-run renders the exact message: From=purchasing@, To, CC, subject, body, attachment
//      name + non-zero size — and touches no credential.
//   2. Send calls gmail.users.messages.send({ userId:'me', requestBody:{ raw } }) exactly once,
//      and the decoded base64url MIME contains From=purchasing@, the correct To/Cc/Subject, and
//      a base64 PDF attachment (Content-Type: application/pdf + %PDF header).
//   3. On success the PO is marked 'sent', emailedAt is stamped, and the underlying local
//      PendingRequest is flipped to 'ordered' (Phase-3 cloud push-back is a documented TODO).
//
// It seeds its own throwaway rows in the local DB and cleans them up, so it is safe to re-run.
import './env.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from './db.js';
import { PKG_ROOT } from './env.js';
import {
  renderMessage,
  buildRawMessage,
  sendMessage,
  SENDER_EMAIL,
  type GmailClient,
  type EmailSpec,
} from './gmail.js';
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

// A mock Gmail client capturing the exact send() params — implements the same structural interface
// as googleapis' gmail.users.messages.send. No network, no auth.
function makeMockClient(): { client: GmailClient; calls: { userId: string; raw: string }[] } {
  const calls: { userId: string; raw: string }[] = [];
  const client: GmailClient = {
    users: {
      messages: {
        async send(params) {
          calls.push({ userId: params.userId, raw: params.requestBody.raw });
          return { data: { id: 'mock-msg-id-123' } };
        },
      },
    },
  };
  return { client, calls };
}

// Decode a Gmail base64url `raw` back into the MIME text for assertions.
function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

async function main(): Promise<void> {
  console.log('mercury-local — Gmail send verification (mocked, no real credential)\n');

  // ── A. Pure unit-level checks on the MIME builder (no DB) ──────────────────────────────────
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

  console.log('A. MIME builder + dry-run render:');
  const rendered = renderMessage(spec);
  check('From = purchasing@ alias with display name', rendered.from === `Prominent Purchasing <${SENDER_EMAIL}>`, rendered.from);
  check('To preserved', rendered.to === 'vendor@example.com');
  check('CC preserved (2)', rendered.cc.length === 2 && rendered.cc[0] === 'cc1@example.com');
  check('attachment name', rendered.attachmentName === 'PO-TEST-001.pdf');
  check('attachment size > 0', rendered.attachmentBytes === MINIMAL_PDF.length, `${rendered.attachmentBytes} bytes`);
  check('attachment found', rendered.attachmentFound === true);

  const raw = buildRawMessage(spec);
  const mime = decodeRaw(raw);
  check('raw is base64url (no +/= chars)', !/[+/=]/.test(raw));
  check('MIME From header = purchasing@', mime.includes(`From: Prominent Purchasing <${SENDER_EMAIL}>`));
  check('MIME To header', mime.includes('To: vendor@example.com'));
  check('MIME Cc header', mime.includes('Cc: cc1@example.com, cc2@example.com'));
  // The subject has a non-ASCII em dash → RFC 2047 encoded-word. Decode it back to verify.
  const subjMatch = /Subject: (.+)/.exec(mime)?.[1] ?? '';
  const decodedSubj = /=\?UTF-8\?B\?(.+)\?=/.exec(subjMatch);
  const subjText = decodedSubj ? Buffer.from(decodedSubj[1], 'base64').toString('utf8') : subjMatch;
  check('MIME Subject (RFC 2047 decoded)', subjText === 'Purchase Order PO-TEST-001 — Prominent', subjText);
  check('MIME multipart/mixed', /Content-Type: multipart\/mixed; boundary=/.test(mime));
  check('MIME PDF part present', mime.includes('Content-Type: application/pdf; name="PO-TEST-001.pdf"'));
  check('MIME attachment disposition', mime.includes('Content-Disposition: attachment; filename="PO-TEST-001.pdf"'));
  // The PDF bytes are base64-embedded — decode the attachment part and check the %PDF magic.
  const attMatch = mime.split('Content-Transfer-Encoding: base64').pop() ?? '';
  const attB64 = attMatch.split(/\r?\n\r?\n/).slice(1).join('').replace(/--.*$/s, '').replace(/\s+/g, '');
  const attDecoded = Buffer.from(attB64, 'base64');
  check('embedded attachment decodes to a PDF', attDecoded.slice(0, 5).toString('utf8') === '%PDF-');

  // ── B. sendMessage() calls the client with the right shape (mock) ──────────────────────────
  console.log('\nB. sendMessage() via mock client:');
  const { client: mockA, calls: callsA } = makeMockClient();
  const resA = await sendMessage(mockA, spec);
  check('called send() exactly once', callsA.length === 1);
  check("userId = 'me' (auth account; From alias is in the MIME)", callsA[0]?.userId === 'me');
  check('returned the mock message id', resA.id === 'mock-msg-id-123');
  const mimeA = decodeRaw(callsA[0]?.raw ?? '');
  check('sent MIME From = purchasing@', mimeA.includes(`From: Prominent Purchasing <${SENDER_EMAIL}>`));
  check('sent MIME To', mimeA.includes('To: vendor@example.com'));
  check('sent MIME Cc', mimeA.includes('Cc: cc1@example.com, cc2@example.com'));

  // ── C. End-to-end through poEmail against seeded DB rows (mock client) ──────────────────────
  console.log('\nC. sendPoEmail() end-to-end (DB, mock client):');
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
  check('dry-run From = purchasing@', dry.from === `Prominent Purchasing <${SENDER_EMAIL}>`);
  check('dry-run To from vendor', dry.to === 'vendor@example.com');
  check('dry-run CC from vendor ccList', dry.cc.length === 2);
  check('dry-run attachment found', dry.attachmentFound === true);
  const poAfterDry = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
  check('dry-run did NOT send (still draft)', poAfterDry?.status === 'draft');

  // Now send with the mock client (explicit) — proves the success bookkeeping.
  const { client: mockC } = makeMockClient();
  const outcome = await sendPoEmail(po.id, undefined, mockC);
  check('send returned a message id', outcome.messageId === 'mock-msg-id-123');
  check('send marked 1 pending request ordered', outcome.markedOrdered === 1);
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

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — no real Google credential was used.`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('verify-send crashed:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
