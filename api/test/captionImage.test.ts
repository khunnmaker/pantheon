import { describe, expect, it, vi } from 'vitest';

const { defaultUpdate } = vi.hoisted(() => ({ defaultUpdate: vi.fn() }));

vi.mock('../src/env.js', () => ({ env: { DRAFT_IMAGE_MAX_BYTES: 100 } }));
vi.mock('../src/db/prisma.js', () => ({ prisma: { message: { update: defaultUpdate } } }));
vi.mock('../src/line/staffUploads.js', () => ({
  readStaffUploadMeta: vi.fn(),
  readStaffUploadFile: vi.fn(),
}));
vi.mock('../src/llm/anthropic.js', () => ({
  llmAvailable: vi.fn(() => false),
  callClaudeWithImage: vi.fn(),
}));

import { captionStaffUpload } from '../src/llm/captionImage.js';

function deps(overrides: Record<string, unknown> = {}) {
  return {
    available: vi.fn(() => true),
    readMeta: vi.fn(async () => ({ fileName: 'photo.png', contentType: 'image/png', kind: 'image' as const })),
    readFile: vi.fn(async () => Buffer.from('photo')),
    maxBytes: 100,
    describe: vi.fn(async () => 'กล่องวัสดุพิมพ์ปาก'),
    update: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('captionStaffUpload', () => {
  it('does nothing when the LLM is unavailable', async () => {
    const d = deps({ available: vi.fn(() => false) });

    await captionStaffUpload('message-1', 'upload-1', d);

    expect(d.readMeta).not.toHaveBeenCalled();
    expect(d.describe).not.toHaveBeenCalled();
    expect(d.update).not.toHaveBeenCalled();
  });

  it('does not read or caption a non-image upload', async () => {
    const d = deps({
      readMeta: vi.fn(async () => ({ fileName: 'quote.pdf', contentType: 'application/pdf', kind: 'file' as const })),
    });

    await captionStaffUpload('message-1', 'upload-1', d);

    expect(d.readFile).not.toHaveBeenCalled();
    expect(d.describe).not.toHaveBeenCalled();
    expect(d.update).not.toHaveBeenCalled();
  });

  it('skips an oversized image without calling the LLM', async () => {
    const d = deps({ readFile: vi.fn(async () => Buffer.alloc(101)) });

    await captionStaffUpload('message-1', 'upload-1', d);

    expect(d.describe).not.toHaveBeenCalled();
    expect(d.update).not.toHaveBeenCalled();
  });

  it('stores a trimmed, bounded Thai caption with the upload media type', async () => {
    const caption = `  ${'ภ'.repeat(205)}  `;
    const d = deps({ describe: vi.fn(async () => caption) });

    await captionStaffUpload('message-1', 'upload-1', d);

    expect(d.describe).toHaveBeenCalledWith({
      base64: Buffer.from('photo').toString('base64'),
      mediaType: 'image/png',
    });
    expect(d.update).toHaveBeenCalledWith('message-1', 'ภ'.repeat(200));
  });

  it('swallows LLM errors and never updates the message', async () => {
    const d = deps({ describe: vi.fn(async () => { throw new Error('model failed'); }) });

    await expect(captionStaffUpload('message-1', 'upload-1', d)).resolves.toBeUndefined();
    expect(d.update).not.toHaveBeenCalled();
  });
});
