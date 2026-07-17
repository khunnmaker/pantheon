import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  learnedFindMany: vi.fn(),
  learnedFindUnique: vi.fn(),
  learnedUpdate: vi.fn(),
  learnedUpdateMany: vi.fn(),
  kbCount: vi.fn(),
  txKbCreate: vi.fn(),
  txLearnedUpdate: vi.fn(),
  transaction: vi.fn(),
  distill: vi.fn(),
  countEmbeddings: vi.fn(),
  findSimilar: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = {
      id: 'supervisor-1',
      email: 'supervisor@example.test',
      name: 'Supervisor',
      role: 'supervisor',
      apps: ['minerva'],
      authVersion: 0,
    };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    learnedAnswer: {
      findMany: mocks.learnedFindMany,
      findUnique: mocks.learnedFindUnique,
      update: mocks.learnedUpdate,
      updateMany: mocks.learnedUpdateMany,
    },
    kbEntry: { count: mocks.kbCount },
    $transaction: mocks.transaction,
    $queryRaw: vi.fn(),
  },
}));
vi.mock('../src/llm/distill.js', () => ({ distillKnowledge: mocks.distill }));
vi.mock('../src/memory/embeddings.js', () => ({
  embedKbEntry: mocks.embed,
  kbEmbeddingText: ({ questionVariants, answer }: { questionVariants: string[]; answer: string }) =>
    `${questionVariants.join(' | ')}\n${answer}`,
  findSimilarKb: mocks.findSimilar,
  countActiveKbEmbeddings: mocks.countEmbeddings,
}));

import { learningRoutes } from '../src/routes/learning.js';

const learnedRecord = {
  id: 'learned-1',
  customerQuestion: 'สินค้านี้มาจากไหน',
  aiDraft: 'ไม่ทราบค่ะ',
  finalAnswer: 'สินค้านำเข้าจากญี่ปุ่นค่ะ',
  agentId: 'staff-1',
  edited: true,
  status: 'pending',
  flagNote: null,
  promotedKbId: null,
  createdAt: new Date(),
};

async function buildApp() {
  const app = Fastify();
  await learningRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.learnedFindMany.mockResolvedValue([]);
  mocks.learnedFindUnique.mockResolvedValue({ ...learnedRecord });
  mocks.learnedUpdate.mockResolvedValue({ ...learnedRecord });
  mocks.learnedUpdateMany.mockResolvedValue({ count: 1 });
  mocks.kbCount.mockResolvedValue(0);
  mocks.countEmbeddings.mockResolvedValue(0);
  mocks.findSimilar.mockResolvedValue(null);
  mocks.txKbCreate.mockResolvedValue({ id: 'kb-1', answer: 'สินค้านำเข้าจากญี่ปุ่น' });
  mocks.txLearnedUpdate.mockResolvedValue({ ...learnedRecord, status: 'approved' });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      kbEntry: { create: mocks.txKbCreate },
      learnedAnswer: { update: mocks.txLearnedUpdate },
    }),
  );
});

describe('learning hardening routes', () => {
  it('queries the durable flagged lane', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/learned?status=flagged' });

    expect(res.statusCode).toBe(200);
    expect(mocks.learnedFindMany).toHaveBeenCalledWith({
      where: { status: 'flagged' },
      orderBy: { createdAt: 'desc' },
    });
    await app.close();
  });

  it('leaves the learned answer pending when distilled text still contains a price', async () => {
    mocks.distill.mockResolvedValue({
      fact: 'ปูน ราคา 625 บาท ต่อถุง',
      questionVariants: ['ปูนถุงละเท่าไร'],
      generalizable: true,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/learned/learned-1/promote' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, kb: null, skipped: true, reason: 'price_content' });
    expect(mocks.learnedUpdate).toHaveBeenCalledWith({
      where: { id: 'learned-1' },
      data: { status: 'pending' },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('moves a pending answer to flagged with an optional review note', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/learned/learned-1/flag',
      payload: { note: 'นโยบายจัดส่งขัดกับรายการเดิม' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.learnedUpdateMany).toHaveBeenCalledWith({
      where: { id: 'learned-1', status: 'pending' },
      data: { status: 'flagged', flagNote: 'นโยบายจัดส่งขัดกับรายการเดิม' },
    });
    await app.close();
  });

  it('refuses ordinary promotion of flagged answers', async () => {
    mocks.learnedUpdateMany.mockResolvedValue({ count: 0 });
    mocks.learnedFindUnique.mockResolvedValue({ ...learnedRecord, status: 'flagged' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/learned/learned-1/promote' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'flagged_requires_resolution' });
    expect(mocks.distill).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps flagged rejection in the resolve lane too', async () => {
    mocks.learnedFindUnique.mockResolvedValue({ ...learnedRecord, status: 'flagged' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/learned/learned-1/reject' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'flagged_requires_resolution' });
    expect(mocks.learnedUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('promote-resolves with exactly the owner-approved KB wording and no distillation', async () => {
    const kbText = '  สินค้านำเข้าจากญี่ปุ่น รับประกัน 1 ปี  ';
    mocks.learnedFindUnique.mockResolvedValue({ ...learnedRecord, status: 'resolving' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/learned/learned-1/resolve',
      payload: { action: 'promote', kbText },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.txKbCreate.mock.calls[0]?.[0].data.answer).toBe(kbText);
    expect(mocks.distill).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects price-bearing owner wording with 400 and leaves the item flagged', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/learned/learned-1/resolve',
      payload: { action: 'promote', kbText: 'หน้ากากอนามัย ราคา 55 บาท' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'price_content' });
    expect(mocks.learnedUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('reject-resolves a flagged answer without creating KB knowledge', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/learned/learned-1/resolve',
      payload: { action: 'reject' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.learnedUpdateMany).toHaveBeenCalledWith({
      where: { id: 'learned-1', status: 'flagged' },
      data: { status: 'rejected' },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });
});
