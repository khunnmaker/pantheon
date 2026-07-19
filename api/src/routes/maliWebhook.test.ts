import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindUnique: vi.fn(),
  sendMali: vi.fn(),
  parseBind: vi.fn(),
  handleBind: vi.fn(),
  answer: vi.fn(),
}));

vi.mock('../env.js', () => ({
  env: { MALI_LINE_CHANNEL_ACCESS_TOKEN: 'configured', MALI_LINE_CHANNEL_SECRET: 'configured' },
}));
vi.mock('../db/prisma.js', () => ({ prisma: { agent: { findUnique: mocks.agentFindUnique } } }));
vi.mock('../line/send.js', () => ({ sendMaliLineText: mocks.sendMali }));
vi.mock('../line/staffBind.js', () => ({
  parseStaffBindCommand: mocks.parseBind,
  handleStaffBindCommand: mocks.handleBind,
}));
vi.mock('../line/signature.js', () => ({ verifyLineSignature: vi.fn(() => true) }));
vi.mock('../mali/answer.js', () => ({ answerMaliQuestion: mocks.answer }));

import { handleMaliLineEvent } from './maliWebhook.js';

describe('Mali webhook event gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseBind.mockReturnValue(null);
    mocks.sendMali.mockResolvedValue({ sent: true, dryRun: false });
  });

  it('gives an unbound user only the bind prompt and never enters knowledge retrieval', async () => {
    mocks.agentFindUnique.mockResolvedValue(null);

    await handleMaliLineEvent({
      type: 'message',
      replyToken: 'reply-1',
      source: { type: 'user', userId: 'U-unbound' },
      message: { type: 'text', text: 'นโยบายวันลาคืออะไร' },
    });

    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.sendMali).toHaveBeenCalledTimes(1);
    expect(mocks.sendMali).toHaveBeenCalledWith(
      'U-unbound',
      'reply-1',
      expect.stringMatching(/ผูกบัญชี.*MALI-XXXXXXXX/),
    );
  });

  it('routes a MALI bind command through the Mali channel before checking binding', async () => {
    mocks.parseBind.mockReturnValue({ form: 'mali', code: 'ABCDEFGH' });

    await handleMaliLineEvent({
      type: 'message',
      replyToken: 'reply-bind',
      source: { type: 'user', userId: 'U-new' },
      message: { type: 'text', text: 'MALI-ABCDEFGH' },
    });

    expect(mocks.handleBind).toHaveBeenCalledWith('MALI-ABCDEFGH', 'U-new', {
      channel: 'mali', replyToken: 'reply-bind',
    });
    expect(mocks.agentFindUnique).not.toHaveBeenCalled();
  });
});
