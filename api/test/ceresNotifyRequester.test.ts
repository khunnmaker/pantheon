import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), sendLineText: vi.fn() }));

vi.mock('../src/db/prisma.js', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock('../src/line/send.js', () => ({ sendLineText: mocks.sendLineText }));

import { notifyRequesterForEvent, notifyRequesterForMoneyEvent } from '../src/ceres/notifyRequester.js';

const row = (kind: string) => ({
  eventId: `event-${kind}`,
  kind,
  note: 'ข้อมูลไม่ครบ https://files.example.test/receipt/secret',
  requestId: 'request-1',
  requestType: kind === 'bought' ? 'purchase' : 'advance',
  amount: '1234.50',
  lineUserId: 'U-requester',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendLineText.mockResolvedValue(undefined);
});

describe('Ceres requester LINE notifications', () => {
  it.each([
    ['nee_approved', 'ได้รับอนุมัติ'],
    ['nee_rejected', 'ถูกปฏิเสธ'],
    ['ceo_rejected', 'ถูกปฏิเสธ'],
    ['paid', 'จ่ายเงิน'],
    ['bought', 'จัดซื้อ'],
  ])('sends the %s trigger with amount, type/reason and a Ceres deep link only', async (kind, statusText) => {
    mocks.queryRaw.mockResolvedValue([row(kind)]);
    await notifyRequesterForEvent(`event-${kind}`);
    const message = mocks.sendLineText.mock.calls[0][1] as string;
    expect(message).toContain(statusText);
    expect(message).toContain('฿1234.50');
    expect(message).toContain('ประเภท:');
    expect(message).toContain('https://ceres.prominentdental.com/?request=request-1');
    expect(message).not.toContain('files.example.test');
  });

  it('swallows LINE failure after the committed event is claimed', async () => {
    mocks.queryRaw.mockResolvedValue([row('paid')]);
    mocks.sendLineText.mockRejectedValue(new Error('line_unavailable'));
    await expect(notifyRequesterForMoneyEvent('money-1')).resolves.toBeUndefined();
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
  });

  it('does not send twice when a retried operation resolves to the same request event', async () => {
    mocks.queryRaw.mockResolvedValueOnce([row('bought')]).mockResolvedValueOnce([]);
    await notifyRequesterForMoneyEvent('money-1');
    await notifyRequesterForMoneyEvent('money-1');
    expect(mocks.sendLineText).toHaveBeenCalledOnce();
  });
});
