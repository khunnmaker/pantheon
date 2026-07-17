import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callClaude: vi.fn(),
  llmAvailable: vi.fn(() => true),
}));

vi.mock('./anthropic.js', () => ({
  callClaude: mocks.callClaude,
  llmAvailable: mocks.llmAvailable,
}));

import { distillKnowledge } from './distill.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.llmAvailable.mockReturnValue(true);
});

describe('distillKnowledge price-safe prompt', () => {
  it('tells the distiller to omit price content while retaining non-price product facts', async () => {
    mocks.callClaude.mockResolvedValue(
      JSON.stringify({ fact: 'ปูนบรรจุถุงละ 1 กิโลกรัม ผลิตในญี่ปุ่น', questionVariants: [], generalizable: true }),
    );

    await distillKnowledge('ปูนราคาเท่าไรและบรรจุเท่าไร', 'ราคา 625 บาท บรรจุถุงละ 1 กิโลกรัม ผลิตในญี่ปุ่น');

    const system = mocks.callClaude.mock.calls[0]?.[1];
    expect(system).toContain('ห้ามเก็บราคาสินค้า');
    expect(system).toContain('แคตตาล็อกสินค้าเป็นแหล่งข้อมูลราคาที่ถูกต้องเพียงแห่งเดียว');
    expect(system).toContain('จำนวนบรรจุ ขนาด แหล่งผลิต/ประเทศต้นทาง');
  });
});
