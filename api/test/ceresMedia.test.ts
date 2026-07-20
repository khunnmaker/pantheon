import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { JWT_SECRET: 'unit-test-placeholder' },
  findMedia: vi.fn(),
  findParty: vi.fn(),
  findExpense: vi.fn(),
  findRequest: vi.fn(),
  findMoneyEvent: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: mocks.env }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    ceresMedia: { findUnique: mocks.findMedia },
    ceresParty: { findFirst: mocks.findParty },
    ceresExpense: { findFirst: mocks.findExpense },
    ceresPaymentRequest: { findFirst: mocks.findRequest },
    ceresRequestMoneyEvent: { findFirst: mocks.findMoneyEvent },
  },
}));

import {
  CERES_EMBEDDED_MEDIA_URL_TTL_SECONDS,
  CERES_MEDIA_URL_TTL_SECONDS,
  ceresReceiptUrl,
  verifyCeresReceiptToken,
} from '../src/ceres/receiptLink.js';
import { mediaCanBeAttachedBy } from '../src/ceres/mediaAccess.js';

const employee = {
  id: 'employee-1', email: 'employee@example.test', name: 'Employee', role: 'employee' as const,
  apps: ['ceres'], authVersion: 0,
};
const gm = { ...employee, id: 'gm-1', role: 'gm' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMedia.mockResolvedValue({
    id: 'upload-1', purpose: 'legacy_receipt', sha256: 'hash', uploadedById: 'employee-2',
    uploadedByName: 'Other', createdAt: new Date(),
  });
});

describe('Ceres media security', () => {
  it('generates a ten-minute signature bound to both upload id and expiry', () => {
    const now = Date.UTC(2026, 6, 17, 0, 0, 0);
    const url = new URL(ceresReceiptUrl('https://api.example.test', 'upload-1', now));
    const expires = url.searchParams.get('expires')!;
    const token = url.searchParams.get('t')!;
    expect(Number(expires) - Math.floor(now / 1000)).toBe(CERES_MEDIA_URL_TTL_SECONDS);
    expect(verifyCeresReceiptToken('upload-1', token, expires, now)).toBe(true);
    expect(verifyCeresReceiptToken('upload-2', token, expires, now)).toBe(false);
    expect(verifyCeresReceiptToken('upload-1', token, String(Number(expires) + 60), now)).toBe(false);
    expect(verifyCeresReceiptToken('upload-1', token, expires, now + CERES_MEDIA_URL_TTL_SECONDS * 1000)).toBe(false);
  });

  it('rejects tokens without an expiry', () => {
    const token = 'legacy-token';
    expect(verifyCeresReceiptToken('upload-1', token, undefined)).toBe(false);
    expect(ceresReceiptUrl('https://api.example.test', 'upload-1')).toContain('expires=');
  });

  it('can mint a 60-minute signature for URLs embedded in response rows', () => {
    const now = Date.UTC(2026, 6, 17, 0, 0, 0);
    const url = new URL(ceresReceiptUrl(
      'https://api.example.test',
      'upload-1',
      now,
      CERES_EMBEDDED_MEDIA_URL_TTL_SECONDS,
    ));
    expect(Number(url.searchParams.get('expires')) - Math.floor(now / 1000))
      .toBe(CERES_EMBEDDED_MEDIA_URL_TTL_SECONDS);
  });

  it('prevents an employee from attaching another employee upload while allowing management', async () => {
    await expect(mediaCanBeAttachedBy('upload-1', employee, ['legacy_receipt'])).resolves.toBeNull();
    await expect(mediaCanBeAttachedBy('upload-1', gm, ['legacy_receipt'])).resolves.toMatchObject({ id: 'upload-1' });
  });

  it('rejects attaching a media purpose that does not match the expense lane', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'upload-1', purpose: 'transfer_slip', sha256: 'hash', uploadedById: employee.id,
      uploadedByName: employee.name, createdAt: new Date(),
    });
    await expect(mediaCanBeAttachedBy('upload-1', employee, ['legacy_receipt'])).resolves.toBeNull();
  });
});
