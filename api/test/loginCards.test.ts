import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('../src/db/prisma.js', () => ({
  prisma: { agent: { findMany: mocks.findMany } },
}));
vi.mock('../src/db/ensureSeeded.js', () => ({
  TIER_ACCOUNTS: [
    { email: 'drm@prominent.local', name: 'Dr. M', role: 'supervisor', group: 'ceo', gender: 'male' },
    { email: 'md@prominent.local', name: 'Nee', role: 'gm', group: 'gm', gender: 'female' },
    { email: 'nun@prominent.local', name: 'Noon', role: 'gm', group: 'gm', gender: 'female' },
  ],
  EMPLOYEES: [
    { slug: 'sales', name: 'Sales', apps: ['ceres'], group: 'sales', gender: 'female' },
    { slug: 'poopae', name: 'Poopae', apps: ['ceres'], role: 'agm', group: 'agm', gender: 'female' },
    { slug: 'win', name: 'Win', apps: ['ceres'], role: 'agm', group: 'agm', gender: 'male' },
    { slug: 'mail', name: 'Mail', apps: ['ceres'], role: 'agm', group: 'agm', gender: 'female' },
  ],
  employeeEmail: (slug: string) => `${slug}@prominent.local`,
}));
vi.mock('../src/auth/jwt.js', () => ({
  GM_APPS: ['ceres', 'minerva', 'juno', 'apollo'],
}));

import { buildLoginCards } from '../src/auth/loginCards.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockImplementation(async ({ where }: { where: { email: { in: string[] } } }) =>
    where.email.in.map((email) => ({ email })),
  );
});

describe('buildLoginCards', () => {
  it('returns supervisor, both password GMs, AGMs, then employees in order', async () => {
    const cards = await buildLoginCards('ceres');

    expect(cards.slice(0, 6).map(({ email, kind }) => ({ email, kind }))).toEqual([
      { email: 'drm@prominent.local', kind: 'password' },
      { email: 'md@prominent.local', kind: 'password' },
      { email: 'nun@prominent.local', kind: 'password' },
      { email: 'poopae@prominent.local', kind: 'pin' },
      { email: 'win@prominent.local', kind: 'pin' },
      { email: 'mail@prominent.local', kind: 'pin' },
    ]);
    expect(cards.filter((card) => card.email === 'nun@prominent.local')).toEqual([
      expect.objectContaining({ kind: 'password', group: 'gm', gender: 'female' }),
    ]);
    expect(cards.slice(6).every((card) => card.kind === 'pin')).toBe(true);
  });
});
