import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMedia: vi.fn(),
  findParty: vi.fn(),
  findExpense: vi.fn(),
  findRequest: vi.fn(),
  findMoneyEvent: vi.fn(),
  findMediaLink: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-placeholder' } }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    ceresMedia: { findUnique: mocks.findMedia },
    ceresParty: { findFirst: mocks.findParty },
    ceresExpense: { findFirst: mocks.findExpense },
    ceresPaymentRequest: { findFirst: mocks.findRequest },
    ceresRequestMoneyEvent: { findFirst: mocks.findMoneyEvent },
    ceresMediaLink: { findMany: mocks.findMediaLink },
  },
}));

import { mediaVisibleToAgent } from '../src/ceres/mediaAccess.js';
import { resolveMediaIdList, idsWithFallback } from '../src/ceres/mediaLinks.js';
import { toExpenseRow, toStaffRequestRow, toMoneyEventRow } from '../src/routes/ceres/common.js';

const requestOwner = {
  id: 'staff-owner', email: 'owner@example.test', name: 'Owner', role: 'staff' as const,
  apps: ['ceres'], authVersion: 0,
};
const unrelatedStaff = {
  id: 'staff-other', email: 'other@example.test', name: 'Other', role: 'staff' as const,
  apps: ['ceres'], authVersion: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  // The media itself was uploaded by a THIRD party (e.g. gm on the requester's behalf) so
  // neither test agent matches the singular uploadedById/expense/request/moneyEvent joins —
  // the only path that can grant visibility is the CeresMediaLink row.
  mocks.findMedia.mockResolvedValue({
    id: 'photo-2', purpose: 'request_photo', sha256: 'hash', uploadedById: 'gm-1',
    uploadedByName: 'GM', createdAt: new Date(),
  });
  mocks.findParty.mockResolvedValue(null);
  mocks.findExpense.mockResolvedValue(null);
  mocks.findRequest.mockResolvedValue(null);
  mocks.findMoneyEvent.mockResolvedValue(null);
});

describe('mediaVisibleToAgent — CeresMediaLink fallback', () => {
  it('grants visibility to the request owner via a link row alone (element beyond the primary)', async () => {
    mocks.findMediaLink.mockResolvedValue([{ targetType: 'request', targetId: 'request-1' }]);
    // Only the OWNER's lookup should resolve a matching request.
    mocks.findRequest.mockImplementation(async ({ where }: any) =>
      where.requestedById === requestOwner.id ? { id: 'request-1' } : null);

    await expect(mediaVisibleToAgent('photo-2', requestOwner)).resolves.toMatchObject({ id: 'photo-2' });
    await expect(mediaVisibleToAgent('photo-2', unrelatedStaff)).resolves.toBeNull();
  });

  it('grants visibility via an expense-target link row to the entering staff member', async () => {
    mocks.findMediaLink.mockResolvedValue([{ targetType: 'expense', targetId: 'expense-1' }]);
    mocks.findExpense.mockImplementation(async ({ where }: any) =>
      where.OR?.some((clause: any) => clause.enteredById === requestOwner.id) ? { id: 'expense-1' } : null);

    await expect(mediaVisibleToAgent('photo-2', requestOwner)).resolves.toMatchObject({ id: 'photo-2' });
    await expect(mediaVisibleToAgent('photo-2', unrelatedStaff)).resolves.toBeNull();
  });

  it('grants visibility via a money_event-target link row to the owning request\'s requester', async () => {
    mocks.findMediaLink.mockResolvedValue([{ targetType: 'money_event', targetId: 'event-1' }]);
    mocks.findMoneyEvent.mockResolvedValue({ requestId: 'request-1' });
    mocks.findRequest.mockImplementation(async ({ where }: any) =>
      where.id === 'request-1' && where.requestedById === requestOwner.id ? { id: 'request-1' } : null);

    await expect(mediaVisibleToAgent('photo-2', requestOwner)).resolves.toMatchObject({ id: 'photo-2' });
    await expect(mediaVisibleToAgent('photo-2', unrelatedStaff)).resolves.toBeNull();
  });

  it('denies visibility when no link row exists and none of the singular joins match', async () => {
    mocks.findMediaLink.mockResolvedValue([]);
    await expect(mediaVisibleToAgent('photo-2', unrelatedStaff)).resolves.toBeNull();
  });
});

describe('resolveMediaIdList — shared array/singular normalization', () => {
  it('prefers a non-empty array over the singular field', () => {
    expect(resolveMediaIdList('singular-id', ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to the singular field when the array is empty or absent', () => {
    expect(resolveMediaIdList('singular-id', [])).toEqual(['singular-id']);
    expect(resolveMediaIdList('singular-id', undefined)).toEqual(['singular-id']);
  });

  it('returns [] when neither is present', () => {
    expect(resolveMediaIdList(null, undefined)).toEqual([]);
    expect(resolveMediaIdList(undefined, undefined)).toEqual([]);
  });

  it('silently de-duplicates while preserving first-seen order', () => {
    expect(resolveMediaIdList(undefined, ['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('idsWithFallback — batched-map fallback', () => {
  it('returns the linked ids when present in the map', () => {
    const map = new Map([['target-1', ['a', 'b']]]);
    expect(idsWithFallback(map, 'target-1', 'singular-id')).toEqual(['a', 'b']);
  });

  it('falls back to [singular] for a legacy row with no link rows', () => {
    const map = new Map<string, string[]>();
    expect(idsWithFallback(map, 'target-1', 'singular-id')).toEqual(['singular-id']);
  });

  it('falls back to [] when there are no links and no singular value', () => {
    const map = new Map<string, string[]>();
    expect(idsWithFallback(map, 'target-1', null)).toEqual([]);
  });
});

describe('serializer fallback (toExpenseRow / toStaffRequestRow / toMoneyEventRow)', () => {
  const baseExpense = {
    id: 'expense-1', partyId: 'party-1', partyName: 'Staff', enteredById: 'staff-1', enteredByName: 'Staff',
    entity: 'PROM', category: 'Travel', customerNote: '', amount: '100.00', spentAt: new Date(),
    receiptUploadId: 'legacy-receipt', receiptSha: 'sha', ocrAmount: '', ocrVendor: '', ocrDate: '',
    status: 'approved', approvedById: null, approvedAt: null, rejectReason: '',
    voidedById: null, voidedAt: null, voidReason: '', settlementId: null,
    advanceRequestId: null, fundingLane: 'cash', aiVerdict: '', note: '', createdAt: new Date(),
  };

  it('falls back to [receiptUploadId] for a legacy expense with no explicit array passed', () => {
    const row = toExpenseRow(baseExpense, 'https://api.example.test');
    expect(row.receiptUploadIds).toEqual(['legacy-receipt']);
  });

  it('returns [] for an expense with no receipt at all', () => {
    const row = toExpenseRow({ ...baseExpense, receiptUploadId: null }, 'https://api.example.test');
    expect(row.receiptUploadIds).toEqual([]);
  });

  it('uses the explicitly-passed array over the singular fallback', () => {
    const row = toExpenseRow(baseExpense, 'https://api.example.test', false, ['r1', 'r2', 'r3']);
    expect(row.receiptUploadIds).toEqual(['r1', 'r2', 'r3']);
    expect(row.receiptUploadId).toBe('legacy-receipt'); // singular column untouched
  });

  const baseRequest = {
    id: 'request-1', requestedById: 'staff-1', requestedByName: 'Staff', requesterPartyId: 'party-1',
    entity: 'PROM', payee: 'Staff', category: 'general', categoryGroups: '', amount: '100.00', detail: 'taxi',
    requestType: 'reimbursement', approvalStatus: 'pending_nee', fulfillmentStatus: 'unfulfilled',
    requestPhotoUploadId: 'legacy-photo', ocrAmount: '', ocrVendor: '', ocrDate: '',
    aiScreenStatus: 'clear', aiReviewId: null, neeDecidedById: null, neeDecidedByName: '', neeDecidedAt: null,
    neeDecisionNote: '', decidedById: null, decidedAt: null, decisionNote: '',
    voidedById: null, voidedAt: null, voidReason: '', rowVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  };

  it('falls back to [requestPhotoUploadId] for a legacy request row', () => {
    const row = toStaffRequestRow(baseRequest);
    expect(row.requestPhotoUploadIds).toEqual(['legacy-photo']);
  });

  it('uses the explicitly-passed array over the singular fallback for a request row', () => {
    const row = toStaffRequestRow(baseRequest, null, ['p1', 'p2']);
    expect(row.requestPhotoUploadIds).toEqual(['p1', 'p2']);
  });

  it('falls back to both singular-derived arrays for a legacy money event with no links', () => {
    const event = { id: 'event-1', transferSlipUploadId: 'slip-1', purchaseReceiptUploadId: null };
    const row = toMoneyEventRow(event);
    expect(row.transferSlipUploadIds).toEqual(['slip-1']);
    expect(row.purchaseReceiptUploadIds).toEqual([]);
  });

  it('uses explicitly-passed arrays over the singular fallback for a money event', () => {
    const event = { id: 'event-1', transferSlipUploadId: 'slip-1', purchaseReceiptUploadId: null };
    const row = toMoneyEventRow(event, ['slip-1', 'slip-2'], ['photo-1']);
    expect(row.transferSlipUploadIds).toEqual(['slip-1', 'slip-2']);
    expect(row.purchaseReceiptUploadIds).toEqual(['photo-1']);
  });
});
