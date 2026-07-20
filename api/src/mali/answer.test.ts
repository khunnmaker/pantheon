import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { MALI_DAILY_LIMIT: 2, MALI_MIN_SIMILARITY: 0.55 },
  count: vi.fn(),
  create: vi.fn(),
  embedOne: vi.fn(),
  retrieve: vi.fn(),
  callClaude: vi.fn(),
}));

vi.mock('../env.js', () => ({ env: mocks.env }));
vi.mock('../db/prisma.js', () => ({
  prisma: { knowledgeQuestion: { count: mocks.count, create: mocks.create } },
}));
vi.mock('../memory/embeddings.js', () => ({
  embedOne: mocks.embedOne,
  retrieveRelevantKnowledge: mocks.retrieve,
}));
vi.mock('../llm/anthropic.js', () => ({ callClaude: mocks.callClaude }));

import { answerMaliQuestion, bangkokDayBounds } from './answer.js';

const article = {
  id: 'article-1',
  title: 'วิธีขออนุมัติวันลา',
  body: 'ยื่นคำขอในระบบก่อนวันลา',
  departmentId: 'hr',
  audience: 'everyone',
  lineExposable: true,
  similarity: 0.8,
};

describe('answerMaliQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.MALI_DAILY_LIMIT = 2;
    mocks.env.MALI_MIN_SIMILARITY = 0.55;
    mocks.count.mockResolvedValue(0);
    mocks.create.mockImplementation(async ({ data }) => ({ id: 'question-1', ...data }));
    mocks.embedOne.mockResolvedValue([0.1, 0.2]);
    mocks.retrieve.mockResolvedValue([article]);
    mocks.callClaude.mockResolvedValue('กรุณายื่นคำขอในระบบก่อนวันลาค่ะ');
  });

  it('logs waiting and returns the forward message below the similarity gate', async () => {
    mocks.retrieve.mockResolvedValue([{ ...article, similarity: 0.54 }]);

    const result = await answerMaliQuestion({
      agent: { id: 'agent-1', role: 'employee' },
      questionText: 'ลางานอย่างไร',
      channel: 'line',
      now: new Date('2026-07-20T17:30:00.000Z'),
    });

    expect(result.status).toBe('waiting');
    expect(result.message).toBe('ขอส่งต่อให้ผู้เกี่ยวข้องก่อนนะคะ จะรีบแจ้งเมื่อได้คำตอบค่ะ');
    expect(mocks.callClaude).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'waiting', topSimilarity: 0.54 }) });
  });

  it('logs answered_auto and appends deterministic article-title citations above the gate', async () => {
    const result = await answerMaliQuestion({
      agent: { id: 'agent-1', role: 'employee' },
      questionText: 'ลางานอย่างไร',
      channel: 'line',
    });

    expect(result.status).toBe('answered_auto');
    expect(result.message).toContain('กรุณายื่นคำขอในระบบก่อนวันลาค่ะ');
    expect(result.message).toMatch(/ที่มา: วิธีขออนุมัติวันลา$/);
    expect(mocks.retrieve).toHaveBeenCalledWith([0.1, 0.2], 'employee', 'line', 6);
    expect(mocks.callClaude).toHaveBeenCalledWith(
      'ลางานอย่างไร',
      expect.stringContaining('ตอบคำถามจากบทความที่ให้มาเท่านั้น'),
      800,
      undefined,
      { app: 'mali', feature: 'staff-answer' },
    );
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'answered_auto' }) });
  });

  it('treats an above-threshold answer that admits uncertainty as waiting', async () => {
    mocks.callClaude.mockResolvedValue('น้องมะลิไม่ทราบค่ะ');

    const result = await answerMaliQuestion({
      agent: { id: 'agent-1', role: 'employee' },
      questionText: 'เรื่องที่ไม่มีในบทความ',
      channel: 'line',
    });

    expect(result.status).toBe('waiting');
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'waiting' }) });
  });

  it('trips at the configured daily count without embedding or logging another question', async () => {
    mocks.count.mockResolvedValue(2);

    const result = await answerMaliQuestion({
      agent: { id: 'agent-1', role: 'employee' },
      questionText: 'คำถามถัดไป',
      channel: 'line',
    });

    expect(result.status).toBe('rate_limited');
    expect(result.message).toContain('ครบ 2 คำถาม');
    expect(mocks.embedOne).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('counts by the Asia/Bangkok calendar day', () => {
    const bounds = bangkokDayBounds(new Date('2026-07-20T18:30:00.000Z'));
    expect(bounds.start.toISOString()).toBe('2026-07-20T17:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-07-21T17:00:00.000Z');
  });
});
