import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  hashPassword: vi.fn(async (value: string) => `test-hash-for:${value}`),
  env: { AGENT_PINS: '', EMPLOYEE_PINS: '' },
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    agent: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
    },
  },
}));
vi.mock('../src/auth/password.js', () => ({
  hashPassword: mocks.hashPassword,
  verifyPassword: vi.fn(async () => false),
}));
vi.mock('../src/kb/historyKb.js', () => ({ HISTORY_KB: [] }));
vi.mock('../src/memory/embeddings.js', () => ({
  embed: vi.fn(), embeddingsAvailable: vi.fn(() => false), storeKbEmbedding: vi.fn(),
  kbEmbeddingText: vi.fn(), kbTextHash: vi.fn(),
}));
vi.mock('../src/llm/prewarm.js', () => ({ prewarmDraftCache: vi.fn() }));
vi.mock('../src/env.js', () => ({ env: mocks.env }));
vi.mock('../src/catalog/productEmbeddings.js', () => ({ backfillProductEmbeddings: vi.fn() }));

import { EMPLOYEES, syncStaff } from '../src/db/ensureSeeded.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SEED_PASSWORD', 'test-supervisor-password');
  vi.stubEnv('GM_PASSWORD', 'test-gm-password');
  vi.stubEnv('MD_PASSWORD', 'test-legacy-fallback-password');
  mocks.env.AGENT_PINS = '';
  mocks.env.EMPLOYEE_PINS = '';
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({});
  mocks.deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => vi.unstubAllEnvs());

describe('syncStaff role seeding', () => {
  it('upserts Noon from GM_PASSWORD as gm and the three PIN-auth staff as central', async () => {
    mocks.env.EMPLOYEE_PINS = 'poopae:295374,win:306485,mail:417596';

    await syncStaff();

    const writes = mocks.upsert.mock.calls.map(([args]) => args);
    const noon = writes.find((w) => w.where.email === 'nun@prominent.local');
    expect(noon?.update).toMatchObject({ role: 'gm', passwordHash: 'test-hash-for:test-gm-password' });
    expect(noon?.create).toMatchObject({
      email: 'nun@prominent.local',
      role: 'gm',
      passwordHash: 'test-hash-for:test-gm-password',
      apps: [],
    });
    for (const slug of ['poopae', 'win', 'mail']) {
      const write = writes.find((w) => w.where.email === `${slug}@prominent.local`);
      expect(write?.update.role).toBe('central');
      expect(write?.create.role).toBe('central');
    }
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', ''],
    ['present but deprecated', ',nun:928374'],
  ])('a %s nun PIN neither skips Noon nor freezes pruning', async (_label, nunPin) => {
    const allEmployeePins = EMPLOYEES
      .filter((employee) => employee.slug !== 'nun')
      .map((employee, index) => `${employee.slug}:${200000 + index}`)
      .join(',');
    mocks.env.EMPLOYEE_PINS = `${allEmployeePins}${nunPin}`;

    await syncStaff();

    expect(EMPLOYEES.some((employee) => employee.slug === 'nun')).toBe(false);
    const noonWrites = mocks.upsert.mock.calls
      .map(([args]) => args)
      .filter((write) => write.where.email === 'nun@prominent.local');
    expect(noonWrites).toHaveLength(1);
    expect(noonWrites[0].update.passwordHash).toBe('test-hash-for:test-gm-password');
    expect(mocks.deleteMany).toHaveBeenCalledOnce();
  });

  it('skips the new Central Office accounts while their PINs are absent and keeps pruning paused', async () => {
    await syncStaff();

    const emails = mocks.upsert.mock.calls.map(([args]) => args.where.email);
    expect(emails).not.toContain('poopae@prominent.local');
    expect(emails).not.toContain('win@prominent.local');
    expect(emails).not.toContain('mail@prominent.local');
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
