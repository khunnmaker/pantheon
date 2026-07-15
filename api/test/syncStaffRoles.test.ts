import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
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
  hashPassword: vi.fn(async () => 'test-password-hash'),
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

import { syncStaff } from '../src/db/ensureSeeded.js';

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
  it('upserts Noon as gm and the three new PIN-auth staff as agm', async () => {
    mocks.env.EMPLOYEE_PINS = 'nun:184263,poopae:295374,win:306485,mail:417596';

    await syncStaff();

    const writes = mocks.upsert.mock.calls.map(([args]) => args);
    expect(writes.find((w) => w.where.email === 'nun@prominent.local')?.update.role).toBe('gm');
    for (const slug of ['poopae', 'win', 'mail']) {
      const write = writes.find((w) => w.where.email === `${slug}@prominent.local`);
      expect(write?.update.role).toBe('agm');
      expect(write?.create.role).toBe('agm');
    }
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('skips the new agm accounts while their PINs are absent and keeps pruning paused', async () => {
    await syncStaff();

    const emails = mocks.upsert.mock.calls.map(([args]) => args.where.email);
    expect(emails).not.toContain('poopae@prominent.local');
    expect(emails).not.toContain('win@prominent.local');
    expect(emails).not.toContain('mail@prominent.local');
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
