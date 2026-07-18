import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prominentPush: vi.fn(),
  appdentPush: vi.fn(),
  env: {
    LINE_DRY_RUN: '',
    LINE_CHANNEL_ACCESS_TOKEN: 'prominent-test-token',
    APPDENT_LINE_CHANNEL_ACCESS_TOKEN: 'appdent-test-token',
    APPDENT_OWNER_LINE_USER_ID: 'U-appdent-owner',
  },
}));

vi.mock('../src/env.js', () => ({ env: mocks.env }));
vi.mock('../src/line/client.js', () => ({
  getLineClient: () => ({ pushMessage: mocks.prominentPush }),
  getAppdentLineClient: () => mocks.env.APPDENT_LINE_CHANNEL_ACCESS_TOKEN
    ? { pushMessage: mocks.appdentPush }
    : null,
}));

import { sendOwnerLineText } from '../src/line/send.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.LINE_DRY_RUN = '';
  mocks.env.APPDENT_LINE_CHANNEL_ACCESS_TOKEN = 'appdent-test-token';
  mocks.env.APPDENT_OWNER_LINE_USER_ID = 'U-appdent-owner';
  mocks.appdentPush.mockResolvedValue({ sentMessages: [{ id: 'owner-message' }] });
});

describe('appdent owner LINE sender', () => {
  it('uses only the appdent client and explicit appdent destination', async () => {
    await expect(sendOwnerLineText('U-prominent-owner', 'private digest')).resolves.toMatchObject({
      sent: true,
      dryRun: false,
    });
    expect(mocks.appdentPush).toHaveBeenCalledWith({
      to: 'U-appdent-owner',
      messages: [{ type: 'text', text: 'private digest' }],
    });
    expect(mocks.prominentPush).not.toHaveBeenCalled();
  });

  it('fails closed with a distinct skipped result when the appdent token is unset', async () => {
    mocks.env.APPDENT_LINE_CHANNEL_ACCESS_TOKEN = '';
    await expect(sendOwnerLineText('U-prominent-owner', 'private digest')).resolves.toEqual({
      sent: false,
      dryRun: false,
      skipped: true,
      skipReason: 'appdent_token_unset',
    });
    expect(mocks.appdentPush).not.toHaveBeenCalled();
    expect(mocks.prominentPush).not.toHaveBeenCalled();
  });

  it('honors LINE_DRY_RUN without calling either LINE client', async () => {
    mocks.env.LINE_DRY_RUN = 'true';
    await expect(sendOwnerLineText('U-prominent-owner', 'private digest')).resolves.toEqual({
      sent: false,
      dryRun: true,
    });
    expect(mocks.appdentPush).not.toHaveBeenCalled();
    expect(mocks.prominentPush).not.toHaveBeenCalled();
  });
});
