import { prisma } from './prisma.js';
import { EMPLOYEES, employeeEmail } from './ensureSeeded.js';

// Carrier-bucket parties (kind "carrier") — expenses booked against a courier
// rather than a person. sortOrder 100+ so they always list after the messengers.
const CARRIERS = [
  { name: 'J&T', sortOrder: 100 },
  { name: 'LALAMOVE Prom', sortOrder: 101 },
  { name: 'LALAMOVE Dentalport', sortOrder: 102 },
  { name: 'ทั่วไป', sortOrder: 103 },
] as const;

// Starter category list (order matches the old GAS expense-type set — see
// CERES_BRIEF §10.5/§6). Shipping categories require the "ลูกค้า: X" customer note.
const CATEGORIES = [
  { name: 'ค่าขนส่ง SD', kind: 'shipping', needsCustomerNote: true },
  { name: 'ค่าขนส่ง J&T', kind: 'shipping', needsCustomerNote: true },
  { name: 'ค่าขนส่ง LALAMOVE Prom', kind: 'shipping', needsCustomerNote: true },
  { name: 'ค่าขนส่ง LALAMOVE Dentalport', kind: 'shipping', needsCustomerNote: true },
  { name: 'ค่าขนส่งทั่วไป', kind: 'shipping', needsCustomerNote: true },
  { name: 'ค่าน้ำมัน', kind: 'fuel', needsCustomerNote: false },
  { name: 'ค่าทางด่วน', kind: 'toll', needsCustomerNote: false },
  { name: 'ค่าซ่อมบำรุงรถ', kind: 'general', needsCustomerNote: false },
  { name: 'ค่าไปรษณีย์', kind: 'general', needsCustomerNote: false },
  { name: 'ค่าเอกสาร/ธุรการ', kind: 'general', needsCustomerNote: false },
  { name: 'อื่นๆ', kind: 'general', needsCustomerNote: false },
] as const;

// Populate Ceres's reference tables (cash accounts, parties, categories) on an
// EMPTY production database, mirroring ensureCatalog/ensureStock's "seed once"
// pattern. Each table is checked independently and only inserted when empty, so
// a partial prior run (e.g. accounts seeded but parties not yet) still completes.
export async function ensureCeres(): Promise<void> {
  try {
    if ((await prisma.cashAccount.count()) === 0) {
      await prisma.cashAccount.createMany({
        data: [
          { id: 'pettyCash', name: 'เงินสดย่อย (กล่อง)' },
          { id: 'bank', name: 'บัญชีบริษัท (MD)' },
        ],
      });
      // eslint-disable-next-line no-console
      console.log('[seed] created Ceres cash accounts');
    }

    if ((await prisma.ceresParty.count()) === 0) {
      const persons = EMPLOYEES.map((e, i) => ({
        name: e.name,
        kind: 'person',
        agentEmail: employeeEmail(e.slug),
        sortOrder: i,
      }));
      const carriers = CARRIERS.map((c) => ({
        name: c.name,
        kind: 'carrier',
        agentEmail: null,
        sortOrder: c.sortOrder,
      }));
      await prisma.ceresParty.createMany({ data: [...persons, ...carriers] });
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${persons.length + carriers.length} Ceres parties`);
    }

    // Idempotent roster fixups (run every boot; cheap). Production was seeded from the
    // pre-unification roster (13 "messenger" parties on m-<slug>@ emails, incl. นี), so:
    //  (a) every EMPLOYEE gets a person party linked to the CURRENT <slug>@ email —
    //      relinks the old m-<slug>@ rows and creates missing parties (e.g. the three
    //      sales, who also enter expenses under the unified model);
    //  (b) the party named "นี" is Nee the MD, not an employee (owner correction) —
    //      unlink + deactivate it, but NEVER delete (append-only history).
    for (const [i, e] of EMPLOYEES.entries()) {
      const email = employeeEmail(e.slug);
      const party = await prisma.ceresParty.findUnique({ where: { name: e.name } });
      if (!party) {
        await prisma.ceresParty.create({
          data: { name: e.name, kind: 'person', agentEmail: email, sortOrder: i },
        });
        // eslint-disable-next-line no-console
        console.log(`[seed] created Ceres party for ${e.slug}`);
      } else if (party.agentEmail !== email) {
        await prisma.ceresParty.update({ where: { id: party.id }, data: { agentEmail: email } });
        // eslint-disable-next-line no-console
        console.log(`[seed] relinked Ceres party ${e.slug} to ${email}`);
      }
    }
    const neeParty = await prisma.ceresParty.findUnique({ where: { name: 'นี' } });
    if (neeParty && (neeParty.agentEmail !== null || neeParty.active)) {
      await prisma.ceresParty.update({
        where: { id: neeParty.id },
        data: { agentEmail: null, active: false },
      });
      // eslint-disable-next-line no-console
      console.log('[seed] unlinked/deactivated party "นี" (she is the MD, not an employee)');
    }

    if ((await prisma.ceresCategory.count()) === 0) {
      await prisma.ceresCategory.createMany({
        data: CATEGORIES.map((c, i) => ({
          name: c.name,
          kind: c.kind,
          needsCustomerNote: c.needsCustomerNote,
          sortOrder: i,
        })),
      });
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${CATEGORIES.length} Ceres categories`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureCeres failed', err);
  }
}
