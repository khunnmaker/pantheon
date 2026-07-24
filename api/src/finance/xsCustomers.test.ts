import { describe, expect, it, vi } from 'vitest';
import { resolveXsCustomerNames } from './xsCustomers.js';

describe('resolveXsCustomerNames', () => {
  it('resolves exact codes first, falls back by Venus searchKey, and skips blanks/unresolved notes', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ code: 'R022', name: 'คลินิกตัวอย่าง' }])
      .mockResolvedValueOnce([{ code: 'AB123', name: 'Fallback Customer', searchKey: 'ab123' }]);
    const prisma = { venusCustomer: { findMany } } as unknown as Parameters<typeof resolveXsCustomerNames>[0];

    const result = await resolveXsCustomerNames(prisma, [' R022 ', 'ab-123', 'MISSING', '  ']);

    expect(result).toEqual(new Map([
      [' R022 ', 'คลินิกตัวอย่าง'],
      ['ab-123', 'Fallback Customer'],
    ]));
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { code: { in: ['R022', 'ab-123', 'MISSING'] } },
      select: { code: true, name: true },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: { searchKey: { in: ['ab123', 'missing'] } },
      select: { code: true, name: true, searchKey: true },
    });
  });

  it('returns an empty map when the exact-code query fails', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const prisma = { venusCustomer: { findMany } } as unknown as Parameters<typeof resolveXsCustomerNames>[0];

    await expect(resolveXsCustomerNames(prisma, ['R022'])).resolves.toEqual(new Map());
  });

  it('returns an empty map when the fallback query fails, discarding partial results', async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{ code: 'R022', name: 'คลินิกตัวอย่าง' }])
      .mockRejectedValueOnce(new Error('database unavailable'));
    const prisma = { venusCustomer: { findMany } } as unknown as Parameters<typeof resolveXsCustomerNames>[0];

    await expect(resolveXsCustomerNames(prisma, ['R022', 'R-999'])).resolves.toEqual(new Map());
  });
});
