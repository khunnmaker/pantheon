import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  categories: new Map<string, { id: string; name: string } & Record<string, unknown>>([
    ['ค่าเดินทาง (แท็กซี่/วิน/รถสาธารณะ)', { id: 'cerescat_travel_public', name: 'ค่าเดินทาง (แท็กซี่/วิน/รถสาธารณะ)' }],
    ['ค่าที่จอดรถ', { id: 'cerescat_parking', name: 'ค่าที่จอดรถ' }],
    ['อุปกรณ์/เครื่องเขียนสำนักงาน', { id: 'cerescat_office_supplies', name: 'อุปกรณ์/เครื่องเขียนสำนักงาน' }],
    ['ค่าถ่ายเอกสาร/พิมพ์งาน', { id: 'cerescat_copy_print', name: 'ค่าถ่ายเอกสาร/พิมพ์งาน' }],
    ['ของใช้สิ้นเปลือง', { id: 'cerescat_consumables', name: 'ของใช้สิ้นเปลือง' }],
    ['อุปกรณ์/เครื่องมือ', { id: 'cerescat_tools', name: 'อุปกรณ์/เครื่องมือ' }],
    ['ค่าอาหารและเครื่องดื่ม', { id: 'cerescat_food_drink', name: 'ค่าอาหารและเครื่องดื่ม' }],
    ['ค่ารับรองลูกค้า', { id: 'cerescat_client_entertainment', name: 'ค่ารับรองลูกค้า' }],
    ['ค่าซ่อมแซม/บำรุงสถานที่', { id: 'cerescat_facility_repair', name: 'ค่าซ่อมแซม/บำรุงสถานที่' }],
  ]),
  createCategories: vi.fn(),
}));

vi.mock('../src/db/ensureSeeded.js', () => ({ EMPLOYEES: [], employeeEmail: vi.fn() }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    cashAccount: { count: vi.fn().mockResolvedValue(1) },
    ceresParty: { count: vi.fn().mockResolvedValue(1), findUnique: vi.fn().mockResolvedValue(null) },
    ceresCategory: { createMany: mocks.createCategories },
    ceresExpense: { findMany: vi.fn().mockResolvedValue([]) },
    ceresMedia: { createMany: vi.fn() },
  },
}));

import { ensureCeres } from '../src/db/ensureCeres.js';

describe('Ceres category seed', () => {
  it('completes a fresh migrated database to all 20 categories including legacy shipping rows', async () => {
    mocks.createCategories.mockImplementation(async ({ data, skipDuplicates }) => {
      expect(skipDuplicates).toBe(true);
      for (const category of data) {
        if (!mocks.categories.has(category.name)) mocks.categories.set(category.name, category);
      }
      return { count: 11 };
    });

    await ensureCeres();

    expect(mocks.createCategories).toHaveBeenCalledOnce();
    expect(mocks.categories.size).toBe(20);
    expect(mocks.categories.get('ค่าขนส่ง SD')).toMatchObject({
      id: 'cerescat_shipping_sd', kind: 'shipping', needsCustomerNote: true, sortOrder: 10,
    });
    expect(mocks.categories.get('ค่าขนส่งทั่วไป')).toMatchObject({
      id: 'cerescat_shipping_general', kind: 'shipping', needsCustomerNote: true, sortOrder: 50,
    });
  });
});
