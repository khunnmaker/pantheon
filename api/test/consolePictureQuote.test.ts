import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  customerFindUnique: vi.fn(),
  customerUpdate: vi.fn(),
  messageCreate: vi.fn(),
  readUploadMeta: vi.fn(),
  sendLineImages: vi.fn(),
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    customer: { findUnique: mocks.customerFindUnique, update: mocks.customerUpdate },
    message: { create: mocks.messageCreate },
  },
}));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => { req.agent = { id: 'agent-1' }; },
  requireApp: () => async () => undefined,
}));
vi.mock('../src/memory/summarize.js', () => ({ endSession: vi.fn() }));
vi.mock('../src/line/send.js', () => ({
  sendLineText: vi.fn(),
  sendLineImages: mocks.sendLineImages,
  sendLineReply: vi.fn(),
}));
vi.mock('../src/line/staffUploads.js', () => ({
  readStaffUploadMeta: mocks.readUploadMeta,
  UPLOAD_ID_RE: /^[A-Za-z0-9-]+$/,
}));
vi.mock('../src/line/picture.js', () => ({ maybeRefreshCustomerPicture: vi.fn() }));
vi.mock('../src/routes/content.js', () => ({ PRODUCT_PHOTO_DIR: 'unused-test-dir' }));
vi.mock('../src/stages.js', () => ({ isStage: vi.fn(() => true) }));
vi.mock('../src/ws/io.js', () => ({ pushToConsole: vi.fn() }));
vi.mock('../src/stock/helpers.js', () => ({ isLow: vi.fn(() => false) }));
vi.mock('../src/llm/captionImage.js', () => ({ captionStaffUpload: vi.fn() }));
vi.mock('../src/llm/draftQueue.js', () => ({
  bumpClearEpoch: vi.fn(),
  cancelPending: vi.fn(),
  flushPending: vi.fn(),
  getPending: vi.fn(),
  isGenerating: vi.fn(() => false),
  runDraft: vi.fn(),
}));

import { consoleRoutes } from '../src/routes/console.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.customerFindUnique.mockResolvedValue({ id: 'customer-1', lineUserId: 'U-customer' });
  mocks.customerUpdate.mockResolvedValue({});
  mocks.readUploadMeta.mockResolvedValue({ fileName: 'photo.png', contentType: 'image/png', kind: 'image' });
  mocks.sendLineImages.mockResolvedValue({
    sent: true,
    dryRun: false,
    channelMsgId: 'line-image-1',
    quoteToken: 'quote-image-1',
  });
  mocks.messageCreate.mockImplementation(async ({ data }) => ({ id: 'message-1', ...data }));
});

describe('outgoing staff picture quote-token storage', () => {
  it('stores the sendLineImages quoteToken on an instant photo Message', async () => {
    const app = Fastify();
    await consoleRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/customers/customer-1/photo',
      payload: { uploadId: 'upload-1' },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attachmentType: 'image',
        channelMsgId: 'line-image-1',
        quoteToken: 'quote-image-1',
      }),
    });
  });
});
