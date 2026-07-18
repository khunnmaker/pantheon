import {
  CustomerCreditError,
  customerBalanceSatang,
  customerCreditKey,
  discrepancyConfirmGate,
  grantCredit,
  netPendingUseCredit,
  releaseSpend,
  removeGrant,
  replaceSpend,
  type CreditTx,
} from '../finance/customerCredit.js';
import { effectivePaidSatang } from '../finance/discrepancy.js';

type Entry = {
  id: string; customerKey: string; customerCode: string; customerName: string;
  kind: string; amountSatang: number; paymentId: string; createdBy: string;
  createdAt: Date; updatedAt: Date;
};

class MemoryCreditDb {
  entries: Entry[] = [];
  payments: any[] = [];
  receipts: any[] = [];
  private sequence = 0;
  private lockTails = new Map<string, Promise<void>>();

  async transaction<T>(work: (tx: CreditTx) => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    const held = new Set<string>();
    const acquire = async (key: string) => {
      if (held.has(key)) return;
      held.add(key);
      const previous = this.lockTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      this.lockTails.set(key, previous.then(() => gate));
      await previous;
      releases.push(release);
    };
    const db = this;
    const tx = {
      $queryRaw: async (_strings: TemplateStringsArray, value: string) => { await acquire(value); return []; },
      customerCreditEntry: {
        findUnique: async ({ where }: any) => {
          const key = where.paymentId_kind;
          return db.entries.find((entry) => entry.paymentId === key.paymentId && entry.kind === key.kind) ?? null;
        },
        aggregate: async ({ where }: any) => ({
          _sum: { amountSatang: db.entries.filter((entry) => entry.customerKey === where.customerKey).reduce((sum, entry) => sum + entry.amountSatang, 0) || null },
        }),
        create: async ({ data }: any) => {
          if (db.entries.some((entry) => entry.paymentId === data.paymentId && entry.kind === data.kind)) throw new Error('unique violation');
          const now = new Date();
          const entry = { id: `entry-${++db.sequence}`, createdAt: now, updatedAt: now, ...data } as Entry;
          db.entries.push(entry);
          return entry;
        },
        upsert: async ({ where, create, update }: any) => {
          const key = where.paymentId_kind;
          const entry = db.entries.find((row) => row.paymentId === key.paymentId && row.kind === key.kind);
          if (entry) { Object.assign(entry, update); return entry; }
          return tx.customerCreditEntry.create({ data: create });
        },
        delete: async ({ where }: any) => {
          const index = db.entries.findIndex((entry) => entry.id === where.id);
          return db.entries.splice(index, 1)[0];
        },
        count: async ({ where }: any) => db.entries.filter((entry) => entry.paymentId === where.paymentId).length,
      },
      payment: {
        findMany: async () => db.payments,
        update: async ({ where, data }: any) => {
          const row = db.payments.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error(`payment not found: ${where.id}`);
          Object.assign(row, data);
          return row;
        },
      },
      reReceipt: { findMany: async () => db.receipts },
    } as unknown as CreditTx;
    try { return await work(tx); }
    finally { for (const release of releases.reverse()) release(); }
  }
}

let failed = 0;
const check = (condition: boolean, label: string) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failed++;
};
const payment = (id: string, customerCode = 'C-1', customerName = 'Customer') => ({
  id, customerCode, customerName, wrongTransferAt: null,
});
const isCode = (error: unknown, code: string) => error instanceof CustomerCreditError && error.code === code;

check(
  discrepancyConfirmGate({ source: 'line', reconciled: false, receivedAt: null } as any, 0) === 'disc_confirm_needs_bank',
  'unlinked transfer confirmation is blocked by the stage-3 bank gate',
);
check(
  discrepancyConfirmGate({ source: 'cheque', reconciled: false, receivedAt: null } as any, 0) === 'disc_confirm_needs_receive',
  'unreceived cheque confirmation is blocked by the stage-3 receive gate',
);
check(
  discrepancyConfirmGate({ source: 'line', reconciled: false, receivedAt: null } as any, 1) === null,
  'an actual PaymentBankMatch link satisfies the transfer gate even if the mirror flag is stale',
);

const db = new MemoryCreditDb();
await db.transaction(async (tx) => {
  check(customerCreditKey(payment('grant')) === 'C-1', 'customer code is the exact grouping key');
  await grantCredit(tx, payment('grant') as any, 10_000, 'supervisor');
});
await db.transaction(async (tx) => { await grantCredit(tx, payment('grant') as any, 99_999, 'supervisor'); });
check(db.entries.filter((entry) => entry.paymentId === 'grant' && entry.kind === 'grant').length === 1, 'repeated supervisor confirm leaves one unchanged grant');
check(db.entries.find((entry) => entry.paymentId === 'grant')?.amountSatang === 10_000, 'repeated confirm cannot enlarge a grant');

const wrongTransferDb = new MemoryCreditDb();
const wrongTransferPayment = { ...payment('wrong-grant', 'C-WRONG'), wrongTransferAt: new Date() };
const wrongTransferDiff = effectivePaidSatang({
  amount: '500.00', whtAmount: '', creditUsed: '', wrongTransferAt: wrongTransferPayment.wrongTransferAt,
});
await wrongTransferDb.transaction((tx) => grantCredit(tx, wrongTransferPayment as any, wrongTransferDiff, 'supervisor'));
check(wrongTransferDiff === 50_000, 'wrong-transfer credit diff is the full payment amount against expected zero');
check(wrongTransferDb.entries.find((entry) => entry.paymentId === 'wrong-grant')?.amountSatang === 50_000, 'wrong-transfer credit confirmation grants the full payment amount');
await wrongTransferDb.transaction((tx) => replaceSpend(tx, payment('wrong-dependent', 'C-WRONG') as any, 1_000, 'fin'));
try {
  await wrongTransferDb.transaction((tx) => removeGrant(tx, 'wrong-grant'));
  check(false, 'spent wrong-transfer grant cannot be un-confirmed');
} catch (error) { check(isCode(error, 'credit_grant_spent'), 'wrong-transfer grant keeps the standard spent-grant lifecycle lock'); }

try {
  await db.transaction((tx) => grantCredit(tx, payment('keyless', '', '') as any, 100, 'supervisor'));
  check(false, 'keyless confirm is rejected');
} catch (error) { check(isCode(error, 'credit_customer_required'), 'keyless confirm returns credit_customer_required'); }

await db.transaction((tx) => replaceSpend(tx, payment('spend') as any, 4_000, 'fin'));
await db.transaction((tx) => replaceSpend(tx, payment('spend') as any, 6_000, 'fin'));
check(db.entries.find((entry) => entry.paymentId === 'spend')?.amountSatang === -6_000, 'spend replacement updates one unique ledger row');
check(effectivePaidSatang({ amount: '40', whtAmount: '', creditUsed: '60' }) === 10_000, 'credit spend balances a cash shortfall');
await db.transaction((tx) => replaceSpend(tx, payment('spend') as any, 0, 'fin'));
check(!db.entries.some((entry) => entry.paymentId === 'spend'), 'explicit zero clears spend');

await db.transaction((tx) => replaceSpend(tx, payment('dependent') as any, 8_000, 'fin'));
try {
  await db.transaction((tx) => removeGrant(tx, 'grant'));
  check(false, 'spent grant removal is blocked');
} catch (error) { check(isCode(error, 'credit_grant_spent'), 'grant removal guard detects pooled spend'); }
await db.transaction((tx) => releaseSpend(tx, 'dependent'));
check(await db.transaction((tx) => customerBalanceSatang(tx, 'C-1')) === 10_000, 'void-style spend release restores availability');

const raceDb = new MemoryCreditDb();
await raceDb.transaction((tx) => grantCredit(tx, payment('race-grant') as any, 10_000, 'supervisor'));
let ready = 0;
let openBarrier!: () => void;
const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
const racer = async (id: string) => {
  ready++;
  if (ready === 2) openBarrier();
  await barrier;
  return raceDb.transaction((tx) => replaceSpend(tx, payment(id) as any, 7_000, 'fin'));
};
const raced = await Promise.allSettled([racer('race-a'), racer('race-b')]);
check(raced.filter((result) => result.status === 'fulfilled').length === 1, 'same-customer barrier race allows exactly one oversubscribing spend');
check(raceDb.entries.filter((entry) => entry.kind === 'spend').length === 1, 'unique payment/kind prevents duplicate spend rows');
check(await raceDb.transaction((tx) => customerBalanceSatang(tx, 'C-1')) >= 0, 'race leaves final ledger balance nonnegative');

const netDb = new MemoryCreditDb();
const pendingPayment = (id: string, createdAt: string, expected: string) => ({
  ...payment(id), amount: '0.00', whtAmount: '', creditUsed: '', reNumbers: [], status: 'verified',
  discExpected: expected, discResolution: 'use_credit', discConfirmedAt: null, wrongTransferAt: null,
  source: 'line', reconciled: true, receivedAt: null, bankMatches: [], transferAt: '', createdAt: new Date(createdAt),
});
netDb.payments = [
  pendingPayment('newer-shortfall', '2026-07-12T00:00:00Z', '80.00'),
  pendingPayment('older-shortfall', '2026-07-11T00:00:00Z', '60.00'),
];
await netDb.transaction((tx) => grantCredit(tx, payment('net-grant') as any, 10_000, 'supervisor'));
const netted = await netDb.transaction((tx) => netPendingUseCredit(tx, 'C-1', 'supervisor'));
check(netted.fullyCovered[0] === 'older-shortfall', 'auto-netting spends against the oldest pending shortfall first');
check(netDb.entries.find((entry) => entry.paymentId === 'older-shortfall')?.amountSatang === -6_000, 'auto-netting fully covers the oldest row');
check(netDb.entries.find((entry) => entry.paymentId === 'newer-shortfall')?.amountSatang === -4_000, 'auto-netting partially covers the next row with the remaining balance');
check(netDb.payments.find((row) => row.id === 'older-shortfall').discConfirmedBy === 'supervisor', 'a fully covered row is confirmed by the grant action');
check(netDb.payments.find((row) => row.id === 'newer-shortfall').discConfirmedAt === null, 'a partially covered row remains unconfirmed');
check(await netDb.transaction((tx) => customerBalanceSatang(tx, 'C-1')) === 0, 'auto-netting never overdraws the customer balance');
try {
  await netDb.transaction((tx) => removeGrant(tx, 'net-grant'));
  check(false, 'a fully spent auto-net grant cannot be un-confirmed');
} catch (error) { check(isCode(error, 'credit_grant_spent'), 'auto-net spend preserves the credit_grant_spent un-confirm guard'); }

if (failed) {
  console.error(`\n${failed} customer-credit check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Juno customer-credit checks PASSED');
