import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { enabled: true, delaySeconds: 15 },
  getConfig: vi.fn(),
  incrementCanceled: vi.fn(),
  push: vi.fn(),
  send: vi.fn(),
  draftFindUnique: vi.fn(),
  messageFindUnique: vi.fn(),
  messageFindFirst: vi.fn(),
  customerFindUnique: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getAutosendConfig: mocks.getConfig,
  incrementAutosendCanceled: mocks.incrementCanceled,
}));
vi.mock('../ws/io.js', () => ({ pushToConsole: mocks.push }));
vi.mock('../reply/sendDraftReply.js', () => ({ sendDraftReply: mocks.send }));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    draft: { findUnique: mocks.draftFindUnique },
    message: { findUnique: mocks.messageFindUnique, findFirst: mocks.messageFindFirst },
    customer: { findUnique: mocks.customerFindUnique },
  },
}));

import { cancelAllAutosends, maybeScheduleAutosend } from './scheduler.js';

const now = new Date('2026-07-18T00:00:00.000Z');
const draft = {
  id: 'draft-1', messageId: 'message-1', type: 'draft',
  draftText: 'ได้รับสลิปแล้วค่ะ เดี๋ยวเจ้าหน้าที่ตรวจสอบให้นะคะ', lane: 'slip_ack',
  usedKb: [], note: null, retrievedMsgIds: [], productSku: null, candidateSkus: [], crossSellSkus: [],
  createdAt: now, updatedAt: now,
};
const customerMessage = {
  id: 'message-1', customerId: 'customer-1', sessionId: 'session-1', role: 'customer', text: '[รูปภาพ]',
  createdAt: now,
};

describe('autosend fire-time guards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.getConfig.mockReset().mockResolvedValue({ ...mocks.config });
    mocks.incrementCanceled.mockReset().mockResolvedValue(undefined);
    mocks.push.mockReset();
    mocks.send.mockReset().mockResolvedValue({ ok: true, message: {}, sent: true, dryRun: false, learnedCaptured: false });
    mocks.draftFindUnique.mockReset().mockResolvedValue({ ...draft });
    mocks.messageFindUnique.mockReset().mockResolvedValue({ ...customerMessage });
    mocks.customerFindUnique.mockReset().mockResolvedValue({ id: 'customer-1', lineUserId: 'U-line' });
    mocks.messageFindFirst.mockReset().mockResolvedValue(null);
  });

  afterEach(async () => {
    await cancelAllAutosends('test_cleanup');
    vi.useRealTimers();
  });

  it('sends through the shared path only after all state is re-verified', async () => {
    await maybeScheduleAutosend('customer-1', draft);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ autoSent: true, finalText: draft.draftText }));
  });

  it('does nothing when the draft text changed after scheduling', async () => {
    await maybeScheduleAutosend('customer-1', draft);
    mocks.draftFindUnique.mockResolvedValue({ ...draft, draftText: `${draft.draftText} แก้ไข` });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does nothing when the config is disabled at fire time', async () => {
    await maybeScheduleAutosend('customer-1', draft);
    mocks.getConfig.mockResolvedValueOnce({ enabled: false, delaySeconds: 15 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does nothing when a newer inbound or staff message exists', async () => {
    await maybeScheduleAutosend('customer-1', draft);
    mocks.messageFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'new-inbound' }).mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
