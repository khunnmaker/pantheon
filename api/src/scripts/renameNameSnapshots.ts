// One-off data fix for the 2026-07-22 staff-name harmonization (see api/src/db/ensureSeeded.ts
// STAFF/TIER_ACCOUNTS — English display names → Thai). The boot-time roster sync
// (syncStaff/ensureCeres) only heals LIVE rows (Agent.name, CeresParty.name); it never touches
// the many DENORMALIZED "name at the time this record was written" snapshot strings frozen on
// historical rows, so those keep showing the old English name forever unless fixed here.
//
// Idempotent: matches rows by the OLD name only, so a re-run after a successful apply finds
// nothing left to change (0 everywhere). Safe to run more than once.
//
// Usage (mirrors the other one-off scripts in this dir):
//   npx tsx src/scripts/renameNameSnapshots.ts                 # dry-run: prints counts, writes nothing
//   CONFIRM_RENAME=yes npx tsx src/scripts/renameNameSnapshots.ts   # applies the updates
import 'dotenv/config';
import { prisma } from '../db/prisma.js';

// Old display name → new canonical Thai name. Exactly the pairs the owner confirmed for this
// rename — do not add slugs/names beyond this list without a matching roster change.
const RENAMES: Record<string, string> = {
  Nee: 'นี',
  'Dr. M': 'หมอไม้',
  Noey: 'เนย',
  Bow: 'โบว์',
  Benz: 'เบนซ์',
  Anny: 'แอนนี่',
  NaDeer: 'นาเดียร์',
  Meow: 'เหมียว',
  Tham: 'ธรรม',
  Rak: 'รักษ์',
};

const CONFIRM = process.env.CONFIRM_RENAME === 'yes';

// One entry per denormalized name column named in the task. `count`/`apply` both filter by
// the OLD name so a partially-applied run (crash mid-way) is safe to just re-run.
interface FieldTarget {
  label: string;
  count: (oldName: string) => Promise<number>;
  apply: (oldName: string, newName: string) => Promise<number>;
}

const targets: FieldTarget[] = [
  {
    label: 'ManualBill.createdByName',
    count: (oldName) => prisma.manualBill.count({ where: { createdByName: oldName } }),
    apply: async (oldName, newName) =>
      (await prisma.manualBill.updateMany({ where: { createdByName: oldName }, data: { createdByName: newName } })).count,
  },
  {
    label: 'CashMovement.createdByName',
    count: (oldName) => prisma.cashMovement.count({ where: { createdByName: oldName } }),
    apply: async (oldName, newName) =>
      (await prisma.cashMovement.updateMany({ where: { createdByName: oldName }, data: { createdByName: newName } })).count,
  },
  {
    label: 'CashMovement.partyName',
    count: (oldName) => prisma.cashMovement.count({ where: { partyName: oldName } }),
    apply: async (oldName, newName) =>
      (await prisma.cashMovement.updateMany({ where: { partyName: oldName }, data: { partyName: newName } })).count,
  },
  {
    label: 'CeresExpense.enteredByName',
    count: (oldName) => prisma.ceresExpense.count({ where: { enteredByName: oldName } }),
    apply: async (oldName, newName) =>
      (await prisma.ceresExpense.updateMany({ where: { enteredByName: oldName }, data: { enteredByName: newName } })).count,
  },
  {
    label: 'CeresExpense.partyName',
    count: (oldName) => prisma.ceresExpense.count({ where: { partyName: oldName } }),
    apply: async (oldName, newName) =>
      (await prisma.ceresExpense.updateMany({ where: { partyName: oldName }, data: { partyName: newName } })).count,
  },
  {
    label: 'CeresPaymentRequest.requestedByName',
    count: (oldName) => prisma.ceresPaymentRequest.count({ where: { requestedByName: oldName } }),
    apply: async (oldName, newName) =>
      (await prisma.ceresPaymentRequest.updateMany({ where: { requestedByName: oldName }, data: { requestedByName: newName } })).count,
  },
];

async function main(): Promise<void> {
  console.log(
    `renameNameSnapshots starting in ${CONFIRM ? 'APPLY' : 'DRY-RUN'} mode` +
      (CONFIRM ? '' : ' (set CONFIRM_RENAME=yes to write)') +
      '…',
  );

  let grandTotal = 0;
  for (const target of targets) {
    let sum = 0;
    for (const [oldName, newName] of Object.entries(RENAMES)) {
      sum += CONFIRM ? await target.apply(oldName, newName) : await target.count(oldName);
    }
    grandTotal += sum;
    console.log(`${(CONFIRM ? 'updated' : 'to update').padEnd(10)} ${target.label.padEnd(32)} ${sum}`);
  }

  console.log(`\nTotal rows ${CONFIRM ? 'updated' : 'that would update'}: ${grandTotal}`);
  if (!CONFIRM) console.log('Re-run with CONFIRM_RENAME=yes to write these rows.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
