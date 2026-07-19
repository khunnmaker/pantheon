import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  sendLine: vi.fn(),
  sendMali: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: { agent: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock('./send.js', () => ({ sendLineText: mocks.sendLine, sendMaliLineText: mocks.sendMali }));

import { handleStaffBindCommand, parseStaffBindCommand } from './staffBind.js';

describe('MALI staff binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique
      .mockResolvedValueOnce({ id: 'agent-1', name: 'เมย์' })
      .mockResolvedValueOnce(null);
    mocks.update.mockResolvedValue({});
    mocks.sendMali.mockResolvedValue({ sent: true, dryRun: false });
  });

  it('parses the new MALI prefix', () => {
    expect(parseStaffBindCommand('MALI-ABCDEFGH')).toEqual({ form: 'mali', code: 'ABCDEFGH' });
  });

  it('binds and confirms through the Mali client when invoked by the Mali webhook', async () => {
    const handled = await handleStaffBindCommand('MALI-ABCDEFGH', 'U-staff', {
      channel: 'mali', replyToken: 'reply-bind',
    });

    expect(handled).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { lineUserId: 'U-staff', lineBindCode: null },
    });
    expect(mocks.sendMali).toHaveBeenCalledWith(
      'U-staff',
      'reply-bind',
      expect.stringContaining('ผูก LINE กับบัญชีพนักงานสำเร็จแล้ว'),
    );
    expect(mocks.sendLine).not.toHaveBeenCalled();
  });
});
