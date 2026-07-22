import { prisma } from './prisma.js';
import { STAFF, staffEmail } from './ensureSeeded.js';

// Carrier-bucket parties (kind "carrier") — expenses booked against a courier
// rather than a person. sortOrder 100+ so they always list after the messengers.
// Deactivated on every boot (see the fixup below) — couriers don't take cash advances
// and must never appear on the staff advance board; seeded inactive here too, so a
// fresh database never shows them active even for the one boot before the fixup runs.
const CARRIERS = [
  { name: 'J&T', sortOrder: 100 },
  { name: 'LALAMOVE Prom', sortOrder: 101 },
  { name: 'LALAMOVE Dentalport', sortOrder: 102 },
  { name: 'ทั่วไป', sortOrder: 103 },
] as const;

// Full company-wide expense category catalog. Shipping categories retain the
// legacy "ลูกค้า: X" customer-note requirement.
const CATEGORIES = [
  { id: 'cerescat_shipping_sd', name: 'ค่าขนส่ง SD', group: 'งานขนส่ง (เมสเซนเจอร์)', kind: 'shipping', ceiling: '', needsCustomerNote: true, active: true, sortOrder: 10 },
  { id: 'cerescat_shipping_jt', name: 'ค่าขนส่ง J&T', group: 'งานขนส่ง (เมสเซนเจอร์)', kind: 'shipping', ceiling: '', needsCustomerNote: true, active: true, sortOrder: 20 },
  { id: 'cerescat_shipping_lalamove_prom', name: 'ค่าขนส่ง LALAMOVE Prom', group: 'งานขนส่ง (เมสเซนเจอร์)', kind: 'shipping', ceiling: '', needsCustomerNote: true, active: true, sortOrder: 30 },
  { id: 'cerescat_shipping_lalamove_dentalport', name: 'ค่าขนส่ง LALAMOVE Dentalport', group: 'งานขนส่ง (เมสเซนเจอร์)', kind: 'shipping', ceiling: '', needsCustomerNote: true, active: true, sortOrder: 40 },
  { id: 'cerescat_shipping_general', name: 'ค่าขนส่งทั่วไป', group: 'งานขนส่ง (เมสเซนเจอร์)', kind: 'shipping', ceiling: '', needsCustomerNote: true, active: true, sortOrder: 50 },
  { id: 'cerescat_postage', name: 'ค่าไปรษณีย์', group: 'งานขนส่ง (เมสเซนเจอร์)', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 60 },
  { id: 'cerescat_fuel', name: 'ค่าน้ำมัน', group: 'ยานพาหนะ/เดินทาง', kind: 'fuel', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 110 },
  { id: 'cerescat_toll', name: 'ค่าทางด่วน', group: 'ยานพาหนะ/เดินทาง', kind: 'toll', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 120 },
  { id: 'cerescat_vehicle_repair', name: 'ค่าซ่อมบำรุงรถ', group: 'ยานพาหนะ/เดินทาง', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 130 },
  { id: 'cerescat_travel_public', name: 'ค่าเดินทาง (แท็กซี่/วิน/รถสาธารณะ)', group: 'ยานพาหนะ/เดินทาง', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 140 },
  { id: 'cerescat_parking', name: 'ค่าที่จอดรถ', group: 'ยานพาหนะ/เดินทาง', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 150 },
  { id: 'cerescat_documents_admin', name: 'ค่าเอกสาร/ธุรการ', group: 'สำนักงาน/ธุรการ', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 210 },
  { id: 'cerescat_office_supplies', name: 'อุปกรณ์/เครื่องเขียนสำนักงาน', group: 'สำนักงาน/ธุรการ', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 220 },
  { id: 'cerescat_copy_print', name: 'ค่าถ่ายเอกสาร/พิมพ์งาน', group: 'สำนักงาน/ธุรการ', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 230 },
  { id: 'cerescat_consumables', name: 'ของใช้สิ้นเปลือง', group: 'ของใช้/วัสดุ', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 310 },
  { id: 'cerescat_tools', name: 'อุปกรณ์/เครื่องมือ', group: 'ของใช้/วัสดุ', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 320 },
  { id: 'cerescat_food_drink', name: 'ค่าอาหารและเครื่องดื่ม', group: 'อาหาร/รับรอง', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 410 },
  { id: 'cerescat_client_entertainment', name: 'ค่ารับรองลูกค้า', group: 'อาหาร/รับรอง', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 420 },
  { id: 'cerescat_facility_repair', name: 'ค่าซ่อมแซม/บำรุงสถานที่', group: 'สถานที่/ซ่อมแซม', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 510 },
  { id: 'cerescat_other', name: 'อื่นๆ', group: 'อื่นๆ', kind: 'general', ceiling: '', needsCustomerNote: false, active: true, sortOrder: 910 },
] as const;

// Populate Ceres's reference tables. Categories are always inserted idempotently
// because a fresh database migration already creates the nine newer rows.
export async function ensureCeres(): Promise<void> {
  try {
    if ((await prisma.cashAccount.count()) === 0) {
      await prisma.cashAccount.createMany({
        data: [
          { id: 'pettyCash', name: 'เงินสดย่อย (กล่อง)' },
          { id: 'bank', name: 'บัญชีบริษัท (GM)' },
        ],
      });
      // eslint-disable-next-line no-console
      console.log('[seed] created Ceres cash accounts');
    }

    if ((await prisma.ceresParty.count()) === 0) {
      const persons = STAFF.map((e, i) => ({
        name: e.name,
        kind: 'person',
        agentEmail: staffEmail(e.slug),
        sortOrder: i,
      }));
      const carriers = CARRIERS.map((c) => ({
        name: c.name,
        kind: 'carrier',
        agentEmail: null,
        sortOrder: c.sortOrder,
        active: false,
      }));
      await prisma.ceresParty.createMany({ data: [...persons, ...carriers] });
      // eslint-disable-next-line no-console
      console.log(`[seed] created ${persons.length + carriers.length} Ceres parties`);
    }

    // Idempotent roster fixups (run every boot; cheap).
    //  (a) every STAFF entry gets a person party keyed by its STABLE agentEmail (the
    //      slug never changes even when a display name does) — creates any missing
    //      party, and heals its `name` if the roster's display name has since changed.
    //      Looking this up BY NAME (the old approach) is what orphaned a row on every
    //      code rename and spawned a stray duplicate party (the inactive "Bow Tham Rak"
    //      artifact is that exact failure mode) — email is the durable key, name is not.
    //      A rename only ever touches this ONE row's `name` column; nothing else moves.
    for (const [i, e] of STAFF.entries()) {
      const email = staffEmail(e.slug);
      const party = await prisma.ceresParty.findFirst({ where: { agentEmail: email, kind: 'person' } });
      if (!party) {
        await prisma.ceresParty.create({
          data: { name: e.name, kind: 'person', agentEmail: email, sortOrder: i },
        });
        // eslint-disable-next-line no-console
        console.log(`[seed] created Ceres party for ${e.slug}`);
        continue;
      }
      if (party.name !== e.name) {
        // `name` is UNIQUE — if some OTHER party already holds the roster's target name,
        // renaming would crash the boot. Warn and skip rather than throw; the mismatch
        // stays visible in logs every boot until a human resolves the collision.
        const collision = await prisma.ceresParty.findUnique({ where: { name: e.name } });
        if (collision && collision.id !== party.id) {
          // eslint-disable-next-line no-console
          console.warn(
            `[seed] cannot rename Ceres party "${party.name}" (${e.slug}) to "${e.name}" — ` +
              `that name already belongs to party ${collision.id}; skipping`,
          );
        } else {
          await prisma.ceresParty.update({ where: { id: party.id }, data: { name: e.name } });
          // eslint-disable-next-line no-console
          console.log(`[seed] renamed Ceres party "${party.name}" → "${e.name}" for ${e.slug}`);
        }
      }
    }
    // (b) the party named "นี" is Nee the GM, not staff (owner correction) — unlink +
    //     deactivate it, but NEVER delete (append-only history). Unlike the STAFF loop
    //     above, Nee/Noon are TIER_ACCOUNTS, not STAFF, so this stays a targeted lookup
    //     by name — there is no stable agentEmail key to generalize it onto here.
    const neeParty = await prisma.ceresParty.findUnique({ where: { name: 'นี' } });
    if (neeParty && (neeParty.agentEmail !== null || neeParty.active)) {
      await prisma.ceresParty.update({
        where: { id: neeParty.id },
        data: { agentEmail: null, active: false },
      });
      // eslint-disable-next-line no-console
      console.log('[seed] unlinked/deactivated party "นี" (she is the GM, not staff)');
    }

    // (c) carriers never take cash advances and must not appear on the staff advance
    //     board — deactivate the four CARRIERS rows every boot (belt-and-braces on top
    //     of computeBoard's kind='person' filter and the now-inactive fresh-DB seed).
    //     Carriers have no agentEmail, so name is their only (and stable) lookup key.
    for (const c of CARRIERS) {
      const party = await prisma.ceresParty.findUnique({ where: { name: c.name } });
      if (party && party.active) {
        await prisma.ceresParty.update({ where: { id: party.id }, data: { active: false } });
        // eslint-disable-next-line no-console
        console.log(`[seed] deactivated carrier party "${c.name}" (off the staff advance board)`);
      }
    }

    await prisma.ceresCategory.createMany({
      data: CATEGORIES.map((category) => ({ ...category })),
      skipDuplicates: true,
    });

    // Rolling-deploy repair: an older API instance may have accepted a legacy
    // receipt between the migration backfill and this code reaching every node.
    // Register referenced files idempotently; no historical row is changed.
    const legacyReceipts = await prisma.ceresExpense.findMany({
      where: { receiptUploadId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        receiptUploadId: true,
        receiptSha: true,
        enteredById: true,
        enteredByName: true,
        createdAt: true,
      },
    });
    const mediaById = new Map<string, (typeof legacyReceipts)[number] & { receiptUploadId: string }>();
    for (const row of legacyReceipts) {
      if (row.receiptUploadId && !mediaById.has(row.receiptUploadId)) {
        mediaById.set(row.receiptUploadId, { ...row, receiptUploadId: row.receiptUploadId });
      }
    }
    if (mediaById.size > 0) {
      await prisma.ceresMedia.createMany({
        data: [...mediaById.values()].map((row) => ({
          id: row.receiptUploadId,
          purpose: 'legacy_receipt',
          sha256: row.receiptSha,
          uploadedById: row.enteredById,
          uploadedByName: row.enteredByName,
          createdAt: row.createdAt,
        })),
        skipDuplicates: true,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[seed] ensureCeres failed', err);
  }
}
