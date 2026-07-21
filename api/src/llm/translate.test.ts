import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callClaude: vi.fn(),
  llmAvailable: vi.fn(() => true),
  pushToConsole: vi.fn(),
  messageFindUnique: vi.fn(),
  messageUpdate: vi.fn(),
  customerUpdate: vi.fn(),
}));

vi.mock('./anthropic.js', () => ({
  callClaude: mocks.callClaude,
  llmAvailable: mocks.llmAvailable,
}));
vi.mock('../ws/io.js', () => ({ pushToConsole: mocks.pushToConsole }));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    message: { findUnique: mocks.messageFindUnique, update: mocks.messageUpdate },
    customer: { update: mocks.customerUpdate },
  },
}));

import {
  isNonThaiText,
  parseInboundTranslation,
  parseOutboundTranslation,
  translateInbound,
  translateOutbound,
} from './translate.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.llmAvailable.mockReturnValue(true);
  mocks.messageUpdate.mockResolvedValue({});
  mocks.customerUpdate.mockResolvedValue({});
});

describe('isNonThaiText', () => {
  it('skips Thai text', () => {
    expect(isNonThaiText('สวัสดีค่ะ สนใจสั่งซื้อสินค้า')).toBe(false);
  });

  it('detects English text', () => {
    expect(isNonThaiText('Hello, do you have this in stock?')).toBe(true);
  });

  it('skips mixed Thai+English text (any Thai character wins)', () => {
    expect(isNonThaiText('Hello สวัสดีค่ะ')).toBe(false);
  });

  it('skips emoji-only text', () => {
    expect(isNonThaiText('👍👍👍')).toBe(false);
  });

  it('skips numbers-only text', () => {
    expect(isNonThaiText('0812345678')).toBe(false);
  });

  it('skips a single stray letter (below the 2-letter floor)', () => {
    expect(isNonThaiText('A 123')).toBe(false);
  });

  it('skips empty text', () => {
    expect(isNonThaiText('')).toBe(false);
  });

  it('detects non-Latin non-Thai scripts (e.g. Chinese)', () => {
    expect(isNonThaiText('你好，请问这个多少钱')).toBe(true);
  });
});

describe('parseInboundTranslation', () => {
  it('parses good JSON and normalizes the language code', () => {
    const result = parseInboundTranslation('{"lang":"EN","thai":"สวัสดีค่ะ"}');
    expect(result).toEqual({ lang: 'en', thai: 'สวัสดีค่ะ' });
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const result = parseInboundTranslation('here you go:\n{"lang":"en","thai":"ทดสอบ"}\nthanks');
    expect(result).toEqual({ lang: 'en', thai: 'ทดสอบ' });
  });

  it('falls back to null on malformed JSON', () => {
    expect(parseInboundTranslation('not json at all')).toBeNull();
  });

  it('falls back to null when required fields are missing', () => {
    expect(parseInboundTranslation('{"lang":"en"}')).toBeNull();
    expect(parseInboundTranslation('{"thai":"ทดสอบ"}')).toBeNull();
  });

  it('falls back to null when JSON parsing throws', () => {
    expect(parseInboundTranslation('{"lang":"en","thai":')).toBeNull();
  });
});

describe('parseOutboundTranslation', () => {
  it('parses good JSON with a note', () => {
    const result = parseOutboundTranslation('{"text":"Hello!","note":"ราคาไม่แน่ใจ"}');
    expect(result).toEqual({ text: 'Hello!', note: 'ราคาไม่แน่ใจ' });
  });

  it('treats an empty note as null', () => {
    const result = parseOutboundTranslation('{"text":"Hello!","note":""}');
    expect(result).toEqual({ text: 'Hello!', note: null });
  });

  it('falls back to plain-text handling on malformed JSON', () => {
    const result = parseOutboundTranslation('Hello, just plain text');
    expect(result).toEqual({ text: 'Hello, just plain text', note: null });
  });

  it('strips a trailing --- or ⚠️ section even without JSON', () => {
    const result = parseOutboundTranslation('Hello!\n---\nsome internal note');
    expect(result).toEqual({ text: 'Hello!', note: null });
  });
});

describe('translateInbound', () => {
  it('translates, stores translatedText/sourceLang + Customer.replyLang, and pushes a socket update', async () => {
    mocks.messageFindUnique.mockResolvedValue({
      id: 'msg-1',
      customerId: 'cust-1',
      role: 'customer',
      text: 'Hello, is this in stock?',
    });
    mocks.callClaude.mockResolvedValue('{"lang":"en","thai":"สวัสดีค่ะ มีสินค้านี้ไหมคะ"}');

    await translateInbound('msg-1');

    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      where: { id: 'msg-1' },
      data: { translatedText: 'สวัสดีค่ะ มีสินค้านี้ไหมคะ', sourceLang: 'en' },
    });
    expect(mocks.customerUpdate).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
      data: { replyLang: 'en' },
    });
    expect(mocks.pushToConsole).toHaveBeenCalledWith('message:update', {
      customerId: 'cust-1',
      id: 'msg-1',
      translatedText: 'สวัสดีค่ะ มีสินค้านี้ไหมคะ',
      sourceLang: 'en',
      replyLang: 'en',
    });
  });

  it('is a no-op (never throws) when the LLM is unavailable', async () => {
    mocks.llmAvailable.mockReturnValue(false);
    await expect(translateInbound('msg-1')).resolves.toBeUndefined();
    expect(mocks.messageFindUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the message is not a customer message', async () => {
    mocks.messageFindUnique.mockResolvedValue({ id: 'msg-1', customerId: 'cust-1', role: 'agent', text: 'hi' });
    await translateInbound('msg-1');
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('never throws when callClaude rejects', async () => {
    mocks.messageFindUnique.mockResolvedValue({
      id: 'msg-1', customerId: 'cust-1', role: 'customer', text: 'hello',
    });
    mocks.callClaude.mockRejectedValue(new Error('anthropic down'));
    await expect(translateInbound('msg-1')).resolves.toBeUndefined();
    expect(mocks.messageUpdate).not.toHaveBeenCalled();
  });

  it('does not persist or push when the model response fails to parse', async () => {
    mocks.messageFindUnique.mockResolvedValue({
      id: 'msg-1', customerId: 'cust-1', role: 'customer', text: 'hello',
    });
    mocks.callClaude.mockResolvedValue('not json');
    await translateInbound('msg-1');
    expect(mocks.messageUpdate).not.toHaveBeenCalled();
    expect(mocks.pushToConsole).not.toHaveBeenCalled();
  });
});

describe('translateOutbound', () => {
  it('returns the translated text + note on a good response', async () => {
    mocks.callClaude.mockResolvedValue('{"text":"Hello, yes we have stock.","note":""}');
    const result = await translateOutbound('สวัสดีค่ะ มีของค่ะ', 'en');
    expect(result).toEqual({ text: 'Hello, yes we have stock.', note: null });
    expect(mocks.callClaude.mock.calls[0]?.[4]).toEqual({ app: 'minerva', feature: 'translate' });
  });

  it('falls back to the original Thai text when the LLM is unavailable', async () => {
    mocks.llmAvailable.mockReturnValue(false);
    const result = await translateOutbound('สวัสดีค่ะ', 'en');
    expect(result).toEqual({ text: 'สวัสดีค่ะ', note: null });
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('falls back to the original Thai text when parsing yields no text', async () => {
    mocks.callClaude.mockResolvedValue('{"note":"เอ๊ะ"}');
    const result = await translateOutbound('สวัสดีค่ะ', 'en');
    expect(result.text).toBe('สวัสดีค่ะ');
  });
});
