import { describe, expect, it } from 'vitest';
import { collectBurstImages, renderBurstQuestion, type BurstImageMessage } from '../src/llm/draftImages.js';

const image = (id: string): BurstImageMessage => ({
  id,
  text: '[รูปภาพ]',
  attachmentType: 'image',
  attachmentRef: 'image/png',
});

describe('unified burst images', () => {
  it('attaches images from an image + text burst, including a group @mention trigger', async () => {
    const messages: BurstImageMessage[] = [
      image('image-1'),
      { id: 'text-1', text: '@Prominent อันนี้ราคาเท่าไหร่คะ', attachmentType: null, attachmentRef: null },
    ];
    const attached = await collectBurstImages(messages, async () => Buffer.from('photo'), 3, 4_500_000);

    expect(attached.map((item) => item.messageId)).toEqual(['image-1']);
    expect(attached[0].base64).toBe(Buffer.from('photo').toString('base64'));
  });

  it('caps more than three images at the three most recent, still oldest-first', async () => {
    const messages = [image('image-1'), image('image-2'), image('image-3'), image('image-4')];
    const attached = await collectBurstImages(messages, async (id) => Buffer.from(id), 3, 4_500_000);

    expect(attached.map((item) => item.messageId)).toEqual(['image-2', 'image-3', 'image-4']);
  });

  it('skips an oversized image while leaving its text placeholder in the burst question', async () => {
    const messages = [
      image('too-large'),
      { id: 'text-1', text: 'มีรุ่นนี้ไหมคะ', attachmentType: null, attachmentRef: null },
    ];
    const attached = await collectBurstImages(
      messages,
      async () => Buffer.alloc(11),
      3,
      10,
    );

    expect(attached).toEqual([]);
    expect(renderBurstQuestion(messages, messages[1].text)).toContain('1. [รูปภาพ]');
  });
});
