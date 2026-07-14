import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { DRAFT_DEBOUNCE_MS: 15_000 },
  generateDraftForMessage: vi.fn(),
  pushToConsole: vi.fn(),
  draftDeleteMany: vi.fn(),
  draftUpsert: vi.fn(),
}));

vi.mock('../env.js', () => ({ env: mocks.env }));
vi.mock('./draft.js', () => ({ generateDraftForMessage: mocks.generateDraftForMessage }));
vi.mock('../ws/io.js', () => ({ pushToConsole: mocks.pushToConsole }));
vi.mock('../db/prisma.js', () => ({
  prisma: { draft: { deleteMany: mocks.draftDeleteMany, upsert: mocks.draftUpsert } },
}));

import {
  bumpClearEpoch,
  cancelPending,
  flushPending,
  getPending,
  isGenerating,
  scheduleDraft,
} from './draftQueue.js';

const outcome = { draft: { id: 'draft-1' }, guardrailReason: null };

describe('draft queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    mocks.env.DRAFT_DEBOUNCE_MS = 15_000;
    mocks.generateDraftForMessage.mockReset().mockResolvedValue(outcome);
    mocks.pushToConsole.mockReset();
    mocks.draftDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.draftUpsert.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a burst and drafts only its latest message', async () => {
    scheduleDraft('burst', 'message-1', 'text');
    await vi.advanceTimersByTimeAsync(10_000);
    scheduleDraft('burst', 'message-2', 'text');

    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.generateDraftForMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.generateDraftForMessage).toHaveBeenCalledTimes(1);
    expect(mocks.generateDraftForMessage).toHaveBeenCalledWith('message-2');
  });

  it('flushes immediately and cancels the scheduled timer', async () => {
    scheduleDraft('flush', 'message-1', 'text');

    expect(flushPending('flush')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.generateDraftForMessage).toHaveBeenCalledTimes(1);
    expect(getPending('flush')).toBeNull();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.generateDraftForMessage).toHaveBeenCalledTimes(1);
  });

  it('cancels without generating a draft', async () => {
    scheduleDraft('cancel', 'message-1', 'text');

    expect(cancelPending('cancel')).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(mocks.generateDraftForMessage).not.toHaveBeenCalled();
  });

  it('deletes an in-flight result after the clear epoch changes', async () => {
    let resolveDraft!: (value: typeof outcome) => void;
    mocks.env.DRAFT_DEBOUNCE_MS = 0;
    mocks.generateDraftForMessage.mockReturnValue(new Promise((resolve) => { resolveDraft = resolve; }));

    scheduleDraft('in-flight', 'message-1', 'text');
    expect(isGenerating('in-flight')).toBe(true);
    bumpClearEpoch('in-flight');
    resolveDraft(outcome);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.draftDeleteMany).toHaveBeenCalledWith({ where: { messageId: 'message-1' } });
    expect(mocks.pushToConsole).not.toHaveBeenCalledWith('draft:new', expect.anything());
    expect(isGenerating('in-flight')).toBe(false);
  });

  it('emits the queued state with its fire time', () => {
    const fireAt = Date.now() + 15_000;
    scheduleDraft('queued', 'message-1', 'sticker');

    expect(getPending('queued')).toEqual({ messageId: 'message-1', kind: 'sticker', fireAt });
    expect(mocks.pushToConsole).toHaveBeenCalledWith('draft:queued', {
      customerId: 'queued', messageId: 'message-1', fireAt,
    });
    cancelPending('queued');
  });
});
