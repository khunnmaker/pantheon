import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  saveContent: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  scheduleDraft: vi.fn(),
  nonTextNeedsHuman: vi.fn(),
}));

vi.mock('../src/line/signature.js', () => ({ verifyLineSignature: () => true }));
vi.mock('../src/line/ingest.js', () => ({ ingestCustomerText: mocks.ingest }));
vi.mock('../src/line/contentStore.js', () => ({ saveLineContent: mocks.saveContent }));
vi.mock('../src/llm/draftQueue.js', () => ({
  scheduleDraft: mocks.scheduleDraft,
  nonTextNeedsHuman: mocks.nonTextNeedsHuman,
  KIND_LABEL: { video: 'วิดีโอ' },
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: { message: { findFirst: mocks.findFirst, update: mocks.update } },
}));
vi.mock('../src/ws/io.js', () => ({ pushToConsole: vi.fn() }));
vi.mock('../src/line/staffBind.js', () => ({ handleStaffBindCommand: vi.fn(async () => false) }));

import { webhookRoutes } from '../src/routes/webhook.js';

const customer = { id: 'customer-1' };
const message = { id: 'message-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.ingest.mockResolvedValue({ customer, message, isNewCustomer: false });
  mocks.saveContent.mockResolvedValue(null);
  mocks.nonTextNeedsHuman.mockResolvedValue(undefined);
});

async function injectMessage(type: 'image' | 'video', quoteToken: string) {
  const app = Fastify();
  await webhookRoutes(app);
  const response = await app.inject({
    method: 'POST',
    url: '/webhook/line',
    payload: {
      events: [{
        type: 'message',
        source: { type: 'user', userId: 'U-customer' },
        message: { type, id: `line-${type}-1`, quoteToken },
      }],
    },
  });
  await app.close();
  return response;
}

describe('inbound picture quote-token capture', () => {
  it('passes an image webhook quoteToken into ingestion', async () => {
    const response = await injectMessage('image', 'quote-inbound-image');

    expect(response.statusCode).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith({
      lineUserId: 'U-customer',
      text: '[รูปภาพ]',
      channelMsgId: 'line-image-1',
      attachmentType: 'image',
      quoteToken: 'quote-inbound-image',
    });
  });

  it('passes a video webhook quoteToken into ingestion', async () => {
    const response = await injectMessage('video', 'quote-inbound-video');

    expect(response.statusCode).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith({
      lineUserId: 'U-customer',
      text: '[วิดีโอ]',
      channelMsgId: 'line-video-1',
      attachmentType: 'video',
      quoteToken: 'quote-inbound-video',
    });
  });
});
