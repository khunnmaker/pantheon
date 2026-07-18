import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callClaudeWithImage: vi.fn(),
}));

vi.mock('../src/llm/anthropic.js', () => ({
  callClaudeWithImage: mocks.callClaudeWithImage,
  llmAvailable: () => true,
}));
vi.mock('../src/line/contentStore.js', () => ({ readImageContent: vi.fn() }));

import { resolveSlipTransferAt } from '../src/finance/normalize.js';
import { readSlipFromBuffer } from '../src/llm/readSlip.js';

describe('slip transfer timestamp', () => {
  beforeEach(() => mocks.callClaudeWithImage.mockReset());

  it('extracts and normalizes the printed Buddhist-era date and HH:mm:ss time', async () => {
    mocks.callClaudeWithImage.mockResolvedValue(JSON.stringify({
      senderName: 'ผู้โอน',
      amount: '1500',
      bank: 'TTB',
      transferAt: 'วันที่ทำรายการ 04/07/2569 15:54:05',
      ref: '260704155405123',
    }));

    const fields = await readSlipFromBuffer(Buffer.from('slip'), 'image/jpeg');

    expect(fields.transferAt).toBe('04/07/2026 15:54');
    const systemPrompt = mocks.callClaudeWithImage.mock.calls[0][1] as string;
    expect(systemPrompt).toContain('วันและเวลาที่พิมพ์อยู่ภายในสลิปธนาคารเท่านั้น');
    expect(systemPrompt).toContain('ห้ามใช้เวลาที่ข้อความถูกส่งเข้า LINE');
  });

  it('uses LINE arrival only when OCR is blank and marks that fallback as editable', () => {
    const arrivedAt = new Date('2026-07-04T08:56:00.000Z'); // 15:56 Asia/Bangkok

    expect(resolveSlipTransferAt('04/07/2569 15:54:05', arrivedAt)).toEqual({
      value: '04/07/2026 15:54',
      fromSlip: true,
    });
    expect(resolveSlipTransferAt('   ', arrivedAt)).toEqual({
      value: '04/07/2026 15:56',
      fromSlip: false,
    });
  });
});
