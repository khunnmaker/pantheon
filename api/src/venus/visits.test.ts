import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    venusCustomerAlias: { findUnique: vi.fn(), upsert: vi.fn() },
    venusCustomer: { findUnique: vi.fn(), findMany: vi.fn() },
    venusVisitMessage: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    venusVisit: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    venusActionItem: { createMany: vi.fn(), updateMany: vi.fn() },
    agent: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    prisma,
    callClaudeWithImages: vi.fn(),
    fetchContent: vi.fn(),
    fetchProfile: vi.fn(),
    sendMali: vi.fn(),
    env: {
      VENUS_VISITS_DEBOUNCE_MS: 120000,
      VENUS_VISITS_MODEL: 'claude-fable-5',
    },
  };
});

vi.mock('../db/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('../env.js', () => ({ env: mocks.env }));
vi.mock('../llm/anthropic.js', () => ({ callClaudeWithImages: mocks.callClaudeWithImages }));
vi.mock('../line/client.js', () => ({
  fetchMaliMessageContent: mocks.fetchContent,
  fetchMaliGroupMemberDisplayName: mocks.fetchProfile,
}));
vi.mock('../line/send.js', () => ({ sendMaliLineText: mocks.sendMali }));

import {
  cancelAllVisitTimersForTest,
  captureVisitMatchReply,
  formatVisitMatchQuestion,
  matchVisitCustomer,
  parseVisitMatchReply,
  processVisitBatch,
  sweepUnprocessedVisitMessages,
} from './visits.js';

const textMessage = {
  id: 'msg-1',
  groupId: 'C-sales',
  lineUserId: 'U-rep',
  lineMessageId: 'M-1',
  type: 'text',
  text: 'เข้าพบ Sunshine สต็อกเหลือ 2 กล่อง',
  visitId: null,
  processedAt: null,
  createdAt: new Date('2026-07-22T03:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.VENUS_VISITS_DEBOUNCE_MS = 120000;
  mocks.env.VENUS_VISITS_MODEL = 'claude-fable-5';
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => unknown) => fn(mocks.prisma));
  mocks.prisma.venusCustomerAlias.findUnique.mockResolvedValue(null);
  mocks.prisma.venusCustomer.findUnique.mockResolvedValue(null);
  mocks.prisma.venusCustomer.findMany.mockResolvedValue([]);
  mocks.prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', name: 'นิด' });
  mocks.fetchProfile.mockResolvedValue(null);
  mocks.fetchContent.mockResolvedValue(null);
  mocks.sendMali.mockResolvedValue({ sent: true, dryRun: false });
  mocks.prisma.venusVisitMessage.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.venusActionItem.createMany.mockResolvedValue({ count: 0 });
});

afterEach(() => cancelAllVisitTimersForTest());

describe('visit customer matcher', () => {
  it('uses an exact normalized alias before customer-name matching', async () => {
    mocks.prisma.venusCustomerAlias.findUnique.mockResolvedValue({
      aliasKey: 'sunshineคลินิก', customerCode: 'C001', source: 'chat-confirm', createdAt: new Date(),
    });
    mocks.prisma.venusCustomer.findUnique.mockResolvedValue({ code: 'C001', name: 'Sunshine Dental' });

    const result = await matchVisitCustomer('Sunshine คลินิก');

    expect(result).toEqual({
      customer: { code: 'C001', name: 'Sunshine Dental' },
      candidates: [{ code: 'C001', name: 'Sunshine Dental' }],
      via: 'alias',
    });
    expect(mocks.prisma.venusCustomer.findMany).not.toHaveBeenCalled();
  });

  it('returns all normalized contains hits as ambiguous and formats at most three choices', async () => {
    mocks.prisma.venusCustomer.findMany.mockResolvedValue([
      { code: 'C001', name: 'Sunshine Dental', searchKey: 'c001' },
      { code: 'C002', name: 'Sunshine Clinic', searchKey: 'c002' },
    ]);

    const result = await matchVisitCustomer('Sunshine');
    const question = formatVisitMatchQuestion('Sunshine', result.candidates);

    expect(result.via).toBe('ambiguous');
    expect(result.customer).toBeNull();
    expect(question).toContain('1. C001 — Sunshine Dental');
    expect(question).toContain('2. C002 — Sunshine Clinic');
    expect(question).toContain('ตอบหมายเลข หรือพิมพ์รหัสลูกค้าได้เลยค่ะ');
  });
});

describe('deterministic match reply parser', () => {
  it('accepts only bare numbered choices or one bare customer code', () => {
    expect(parseVisitMatchReply(' 2 ')).toEqual({ index: 1 });
    expect(parseVisitMatchReply('C-001')).toEqual({ customerCode: 'C-001' });
    expect(parseVisitMatchReply('เลือก 2')).toBeNull();
    expect(parseVisitMatchReply('C 001')).toBeNull();
    expect(parseVisitMatchReply('')).toBeNull();
  });

  it('links a valid customer code, saves the alias, and consumes the persisted reply row atomically', async () => {
    const pending = {
      id: 'visit-pending',
      groupId: 'C-sales',
      extractJson: {
        isVisitReport: true,
        customerNameGuess: 'ซันชายน์',
        summary: '', proposed: [], orderedLines: [], objections: [], stockNotes: [], actionItems: [],
      },
    };
    mocks.prisma.venusVisit.findFirst
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ id: 'visit-pending' })
      .mockResolvedValueOnce(null);
    mocks.prisma.venusVisit.findUnique.mockResolvedValue(pending);
    mocks.prisma.venusCustomer.findUnique.mockResolvedValue({ code: 'C001', name: 'Sunshine Dental' });

    await expect(captureVisitMatchReply('C-sales', 'C001', 'reply-row')).resolves.toBe(true);

    expect(mocks.prisma.venusCustomerAlias.upsert).toHaveBeenCalledWith({
      where: { aliasKey: 'ซันชายน์' },
      create: { aliasKey: 'ซันชายน์', customerCode: 'C001', source: 'chat-confirm' },
      update: { customerCode: 'C001', source: 'chat-confirm' },
    });
    expect(mocks.prisma.venusVisitMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 'reply-row', processedAt: null },
      data: { visitId: 'visit-pending', processedAt: expect.any(Date) },
    });
  });
});

describe('visit extraction pipeline', () => {
  it('sends untrusted report text only in the user turn, uses the Venus model/meta, and stays silent when matched', async () => {
    mocks.prisma.venusVisitMessage.findMany.mockResolvedValue([textMessage]);
    mocks.callClaudeWithImages.mockResolvedValue(JSON.stringify({
      isVisitReport: true,
      customerNameGuess: 'Sunshine',
      summary: 'เข้าพบและตรวจสต็อก',
      proposed: [], orderedLines: [], objections: [], stockNotes: ['เหลือ 2 กล่อง'], actionItems: [],
    }));
    mocks.prisma.venusCustomer.findMany.mockResolvedValue([
      { code: 'C001', name: 'Sunshine Dental', searchKey: 'c001' },
    ]);
    mocks.prisma.venusVisit.create.mockResolvedValue({ id: 'visit-1', status: 'matched' });

    expect(await processVisitBatch('C-sales', 'U-rep')).toBe(true);

    const call = mocks.callClaudeWithImages.mock.calls[0];
    expect(call[0]).toContain(textMessage.text);
    expect(call[1]).not.toContain(textMessage.text);
    expect(call[4]).toEqual({ app: 'venus', feature: 'visit-extract' });
    expect(call[5]).toBe('claude-fable-5');
    expect(mocks.prisma.venusVisit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'matched', customerCode: 'C001', model: 'claude-fable-5' }),
    }));
    expect(mocks.sendMali).not.toHaveBeenCalled();
  });

  it('marks non-report chatter skipped and never replies', async () => {
    mocks.prisma.venusVisitMessage.findMany.mockResolvedValue([textMessage]);
    mocks.callClaudeWithImages.mockResolvedValue(JSON.stringify({
      isVisitReport: false,
      customerNameGuess: '', summary: '', proposed: [], orderedLines: [], objections: [], stockNotes: [], actionItems: [],
    }));
    mocks.prisma.venusVisit.create.mockResolvedValue({ id: 'visit-skip', status: 'skipped' });

    expect(await processVisitBatch('C-sales', 'U-rep')).toBe(true);
    expect(mocks.prisma.venusVisit.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'skipped', customerCode: null }),
    }));
    expect(mocks.sendMali).not.toHaveBeenCalled();
  });

  it('leaves the inbox unprocessed when extraction fails', async () => {
    mocks.prisma.venusVisitMessage.findMany.mockResolvedValue([textMessage]);
    mocks.callClaudeWithImages.mockRejectedValue(new Error('model unavailable'));

    expect(await processVisitBatch('C-sales', 'U-rep')).toBe(false);
    expect(mocks.prisma.venusVisit.create).not.toHaveBeenCalled();
    expect(mocks.prisma.venusVisitMessage.updateMany).not.toHaveBeenCalled();
  });
});

describe('visit inbox boot sweep', () => {
  it('immediately retries a sender batch whose quiet window elapsed before boot', async () => {
    const stale = { ...textMessage, createdAt: new Date(Date.now() - 180000) };
    mocks.prisma.venusVisitMessage.findMany
      .mockResolvedValueOnce([{ groupId: 'C-sales', lineUserId: 'U-rep', createdAt: stale.createdAt }])
      .mockResolvedValueOnce([stale]);
    mocks.callClaudeWithImages.mockResolvedValue(JSON.stringify({
      isVisitReport: false,
      customerNameGuess: '', summary: '', proposed: [], orderedLines: [], objections: [], stockNotes: [], actionItems: [],
    }));
    mocks.prisma.venusVisit.create.mockResolvedValue({ id: 'visit-retry', status: 'skipped' });

    await expect(sweepUnprocessedVisitMessages()).resolves.toEqual({ stale: 1, rearmed: 0 });
    expect(mocks.callClaudeWithImages).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.venusVisitMessage.updateMany).toHaveBeenCalledTimes(1);
  });
});
