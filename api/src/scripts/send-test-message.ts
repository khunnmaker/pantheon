// Dev/demo helper: simulate a customer messaging the LINE OA, so you can try the
// console without a public webhook. Signs a webhook payload like LINE would and
// posts it to the local API. The AI then drafts a reply you review in the console.
//
//   npm run demo:msg -- "ราคาเท่าไหร่คะ"
//   npm run demo:msg -- "do you have stock?" --user U_demo_2 --name "Test Clinic B"
import 'dotenv/config';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const positional = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--user' && arr[i - 1] !== '--name');
const text = positional.join(' ') || 'สวัสดีค่ะ สอบถามฟูลไรด์เจลหน่อยค่ะ มีรสอะไรบ้าง';
const userId = argValue('--user') || 'U_demo_customer';
const name = argValue('--name') || 'คุณทดสอบ (เดโม)';

const base = `http://localhost:${process.env.PORT || 3000}`;
const secret = process.env.LINE_CHANNEL_SECRET;

async function main() {
  if (!secret) {
    console.error('LINE_CHANNEL_SECRET is not set in api/.env');
    process.exit(1);
  }
  // Give the demo customer a friendly display name (real LINE supplies this via
  // the profile API; for a simulated user we set it directly).
  await prisma.customer.upsert({
    where: { lineUserId: userId },
    update: {},
    create: { lineUserId: userId, displayName: name },
  });

  const body = JSON.stringify({
    events: [{ type: 'message', message: { type: 'text', id: 'demo-' + Date.now(), text }, source: { type: 'user', userId } }],
  });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  const res = await fetch(`${base}/webhook/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': sig },
    body,
  });

  console.log(`✓ sent as "${name}": "${text}"  → webhook HTTP ${res.status}`);
  console.log('  Open http://localhost:5173 — it appears in the queue and the AI drafts a reply in a few seconds.');
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
