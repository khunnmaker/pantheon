import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pushMessage: vi.fn() }));

vi.mock('../src/env.js', () => ({
  env: { LINE_DRY_RUN: '', LINE_CHANNEL_ACCESS_TOKEN: 'test-token' },
}));
vi.mock('../src/line/client.js', () => ({
  getLineClient: () => ({ pushMessage: mocks.pushMessage }),
  getAppdentLineClient: () => null,
}));

import { sendLineImages, sendLineReply } from '../src/line/send.js';

beforeEach(() => vi.clearAllMocks());

describe('LINE sent-image quote tokens', () => {
  it('returns the id and quoteToken LINE issues for an image-only push', async () => {
    mocks.pushMessage.mockResolvedValue({
      sentMessages: [{ id: 'line-image-1', quoteToken: 'quote-image-1' }],
    });

    await expect(sendLineImages('U-customer', ['https://example.test/photo.png'])).resolves.toEqual({
      sent: true,
      dryRun: false,
      channelMsgId: 'line-image-1',
      quoteToken: 'quote-image-1',
    });
  });

  it('returns the first image response for a mixed text-and-image push', async () => {
    mocks.pushMessage.mockResolvedValue({
      sentMessages: [
        { id: 'line-text-1', quoteToken: 'quote-text-1' },
        { id: 'line-image-1', quoteToken: 'quote-image-1' },
      ],
    });

    const result = await sendLineReply(
      'U-customer',
      'Here is the picture',
      ['https://example.test/photo.png'],
      'quote-inbound-image',
    );

    expect(result).toMatchObject({ channelMsgId: 'line-image-1', quoteToken: 'quote-image-1' });
    expect(mocks.pushMessage).toHaveBeenCalledWith({
      to: 'U-customer',
      messages: [
        { type: 'text', text: 'Here is the picture', quoteToken: 'quote-inbound-image' },
        {
          type: 'image',
          originalContentUrl: 'https://example.test/photo.png',
          previewImageUrl: 'https://example.test/photo.png',
        },
      ],
    });
  });
});
