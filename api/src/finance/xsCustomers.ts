import type { PrismaClient } from '@prisma/client';

type XsCustomerPrisma = Pick<PrismaClient, 'venusCustomer'>;

function toSearchKey(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-z\u0E00-\u0E7F]/g, '');
}

export async function resolveXsCustomerNames(
  prisma: XsCustomerPrisma,
  notes: string[],
): Promise<Map<string, string>> {
  const candidates = notes
    .map((raw) => ({ raw, trimmed: raw.trim() }))
    .filter(({ trimmed }) => trimmed !== '');
  if (candidates.length === 0) return new Map();

  try {
    const trimmedNotes = [...new Set(candidates.map(({ trimmed }) => trimmed))];
    const exactCustomers = await prisma.venusCustomer.findMany({
      where: { code: { in: trimmedNotes } },
      select: { code: true, name: true },
    });
    const exactNameByCode = new Map(exactCustomers.map(({ code, name }) => [code, name]));
    const resolved = new Map<string, string>();
    for (const { raw, trimmed } of candidates) {
      const name = exactNameByCode.get(trimmed);
      if (name !== undefined) resolved.set(raw, name);
    }

    const unmatched = candidates.filter(({ raw }) => !resolved.has(raw));
    const searchKeys = [...new Set(unmatched.map(({ trimmed }) => toSearchKey(trimmed)).filter(Boolean))];
    if (searchKeys.length === 0) return resolved;

    const fallbackCustomers = await prisma.venusCustomer.findMany({
      where: { searchKey: { in: searchKeys } },
      select: { code: true, name: true, searchKey: true },
    });
    const fallbackNameByKey = new Map<string, string>();
    for (const { searchKey, name } of fallbackCustomers) {
      if (!fallbackNameByKey.has(searchKey)) fallbackNameByKey.set(searchKey, name);
    }
    for (const { raw, trimmed } of unmatched) {
      const name = fallbackNameByKey.get(toSearchKey(trimmed));
      if (name !== undefined) resolved.set(raw, name);
    }
    return resolved;
  } catch {
    return new Map();
  }
}
