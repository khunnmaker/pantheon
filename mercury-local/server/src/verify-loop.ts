// Offline proof of the Mercury Phase-3 loop-close (local side) — mocked cloud calls, NO network,
// NO prod DB (seeds + cleans up throwaway rows in the LOCAL sqlite dev DB).
// Run: npm run verify:loop  (tsx server/src/verify-loop.ts)
//
// Proves:
//   (c) SECRET goods-receipt from local: resolveSecret bumps Vesta stock via the cloud adjust
//       endpoint keyed on the LOCAL realSku, then marks the cloud request 'received' (STATUS ONLY).
//       The captured cloud calls show realSku ONLY on the adjust call (a transient stock bump) and
//       NEVER on the receive/status call — the invariant "secret realSku never lands on a cloud
//       row" holds.
//   (d) Status push: pushCloudStatus PATCHes each cloud request → 'ordered' (best-effort; a
//       cloud-unreachable failure is swallowed, not thrown).
import './env.js';
import { prisma } from './db.js';
import { receiveSecret } from './po.js';
import { pushCloudStatus } from './poEmail.js';
import { saveConnection, clearConnection, loadConnection } from './connection.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log('mercury-local — Phase-3 loop proof (mocked cloud, no network, no prod DB)\n');

  const stamp = Date.now();
  const priorConn = loadConnection(); // preserve/restore any real connection file
  // A throwaway connection so loadConnection() inside the code paths returns a baseUrl+token.
  saveConnection({ baseUrl: 'https://verify.invalid', token: 'verify-token', connectedAt: new Date().toISOString() });

  // Seed: a vendor + a SECRET SecretMap (realSku lives ONLY here) + a pending SECRET shadow.
  const vendor = await prisma.vendor.create({ data: { name: `__loop_vendor_${stamp}`, email: 'v@example.com' } });
  const cloudItemId = `__loop_item_${stamp}`;
  const cloudRequestId = `__loop_req_${stamp}`;
  const secret = await prisma.secretMap.create({
    data: {
      cloudItemId,
      realName: 'Secret Widget X',
      vendorId: vendor.id,
      realSku: '12-34-56', // the REAL sku — must never reach a cloud row
      unitCost: '100',
      classification: 'special',
    },
  });
  const shadow = await prisma.pendingRequest.create({
    data: {
      cloudRequestId,
      itemId: cloudItemId,
      qty: '6',
      status: 'pending',
      itemDisplayName: 'วัตถุดิบ A-17', // the alias the cloud sees — NOT the real name
      itemIsSecret: true,
      itemVestaSku: null, // secret items carry no SKU on the cloud row
    },
  });

  // ── (c) SECRET receipt with MOCKED cloud calls — capture every cloud interaction. ────────────
  console.log('(c) SECRET goods-receipt from local (mocked cloud adjust + receive):');
  const adjustCalls: { sku: string; delta: number; reason: string }[] = [];
  const receiveCalls: { requestId: string; qty: string }[] = [];
  const outcome = await receiveSecret(cloudRequestId, 6, {
    adjust: async (_baseUrl, _token, realSku, delta, reason) => {
      adjustCalls.push({ sku: realSku, delta, reason });
      return { toQty: 6 + delta }; // pretend prior stock was 6
    },
    receive: async (_baseUrl, _token, requestId, qty) => {
      receiveCalls.push({ requestId, qty });
    },
  });

  check('resolved the real SKU from the LOCAL SecretMap', outcome.realSku === '12-34-56', outcome.realSku);
  check('called cloud stock-adjust exactly once', adjustCalls.length === 1, `${adjustCalls.length} calls`);
  check('adjust used the REAL sku + received qty', adjustCalls[0]?.sku === '12-34-56' && adjustCalls[0]?.delta === 6);
  check('adjust reason = Mercury secret goods-receipt', adjustCalls[0]?.reason === 'Mercury secret goods-receipt');
  check('marked the cloud request received (status only) exactly once', receiveCalls.length === 1);
  check('receive call carried NO sku (only requestId + qty)', receiveCalls[0]?.requestId === cloudRequestId && receiveCalls[0]?.qty === '6');
  // INVARIANT: realSku appears ONLY in the adjust call, NEVER in the receive/status call.
  check(
    'INVARIANT: realSku never on the cloud request/status call',
    JSON.stringify(receiveCalls).indexOf('12-34-56') === -1,
  );
  // Local shadow reflects received.
  const shadowAfter = await prisma.pendingRequest.findUnique({ where: { id: shadow.id } });
  check("local shadow flipped to 'received'", shadowAfter?.status === 'received');
  // The cloud row would still hold only the alias — the SecretMap (real name/sku) never leaves.
  check('SecretMap realSku is still LOCAL only (unchanged)', (await prisma.secretMap.findUnique({ where: { id: secret.id } }))?.realSku === '12-34-56');

  // ── (d) Status push — best-effort PATCH → 'ordered'. ─────────────────────────────────────────
  console.log('\n(d) Status push to cloud (mocked PATCH → ordered):');
  const patchCalls: { id: string; status: string }[] = [];
  const okPush = await pushCloudStatus([cloudRequestId, `${cloudRequestId}_b`], 'ordered', async (_b, _t, id, status) => {
    patchCalls.push({ id, status });
  });
  check('pushed 2 cloud statuses', okPush.pushed === 2, `${okPush.pushed}`);
  check('each PATCH set ordered', patchCalls.length === 2 && patchCalls.every((c) => c.status === 'ordered'));

  console.log('\n    Status push is BEST-EFFORT (a cloud failure never throws):');
  const partial = await pushCloudStatus([cloudRequestId], 'ordered', async () => {
    throw new Error('cloud down');
  });
  check('failure swallowed (pushed 0, error recorded)', partial.pushed === 0 && !!partial.error);

  // ── Cleanup ─────────────────────────────────────────────────────────────────────────────────
  await prisma.pendingRequest.delete({ where: { id: shadow.id } });
  await prisma.secretMap.delete({ where: { id: secret.id } });
  await prisma.vendor.delete({ where: { id: vendor.id } });
  clearConnection();
  if (priorConn) saveConnection(priorConn); // restore any pre-existing real connection

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — no network, no prod DB used.`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('verify-loop crashed:', e);
  clearConnection();
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
