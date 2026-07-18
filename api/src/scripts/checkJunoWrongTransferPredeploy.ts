// Read-only predeploy audit. It intentionally prints only a count, never payment/customer data.
// Run before deploying the add-only marker migration; FIN must re-save only confirmed cases.
import 'dotenv/config';
import { prisma } from '../db/prisma.js';

try {
  const [result] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM "Payment"
    WHERE '0000000' = ANY("reNumbers")
       OR regexp_replace("reNumber", '[^0-9/]', '', 'g') ~ '(^|/)0000000(/|$)'
  `;
  console.log(`Legacy 0000000 payment rows requiring FIN review: ${result?.count ?? 0}`);
} finally {
  await prisma.$disconnect();
}
