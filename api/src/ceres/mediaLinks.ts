import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export type CeresTx = Prisma.TransactionClient;

// The three kinds of row a CeresMediaLink can point at. Kept as a plain string union
// (matches CeresMedia's own flat-metadata style — no @relation on the model).
export type CeresMediaTargetType = 'request' | 'expense' | 'money_event';

// Additive multi-image support (2026-07-22): an OPTIONAL array field lives alongside every
// existing singular upload-id field across Ceres (receiptUploadId(s), requestPhotoUploadId(s),
// transferSlipUploadId(s), purchaseReceiptUploadId(s)). This is the single normalization rule
// shared by every write path — array wins when both are sent, silently de-duplicated
// (order-preserving), empty/undefined array falls through to the singular field.
export function resolveMediaIdList(
  singular: string | null | undefined,
  array: string[] | undefined,
): string[] {
  if (array && array.length > 0) return [...new Set(array)];
  return singular ? [singular] : [];
}

// Writes one link row per id (sortOrder = array index). No-op for an empty list. Callers run
// this inside the SAME transaction as the parent row's create/update.
export async function writeMediaLinksInTx(
  tx: CeresTx,
  targetType: CeresMediaTargetType,
  targetId: string,
  purpose: string,
  mediaIds: readonly string[],
): Promise<void> {
  if (mediaIds.length === 0) return;
  await tx.ceresMediaLink.createMany({
    data: mediaIds.map((mediaId, index) => ({ targetType, targetId, mediaId, purpose, sortOrder: index })),
  });
}

// PATCH-style replace: drops the existing link set for this (targetType, targetId, purpose)
// and recreates it from mediaIds, in the same transaction as the row's own update. Scoped by
// purpose so e.g. a money event's transfer_slip links and purchase_receipt links never
// clobber each other (both share the same targetId).
export async function replaceMediaLinksInTx(
  tx: CeresTx,
  targetType: CeresMediaTargetType,
  targetId: string,
  purpose: string,
  mediaIds: readonly string[],
): Promise<void> {
  await tx.ceresMediaLink.deleteMany({ where: { targetType, targetId, purpose } });
  await writeMediaLinksInTx(tx, targetType, targetId, purpose, mediaIds);
}

// Single-target read — used for edit-time "what's already attached" (preserving an untouched
// array on a partial edit) and for single-row response serialization.
export async function singleTargetLinkIds(
  targetType: CeresMediaTargetType,
  targetId: string,
  purpose: string,
): Promise<string[]> {
  const rows = await prisma.ceresMediaLink.findMany({
    where: { targetType, targetId, purpose },
    orderBy: { sortOrder: 'asc' },
    select: { mediaId: true },
  });
  return rows.map((r) => r.mediaId);
}

// Batched read for list/detail endpoints — ONE findMany across every target id on the page,
// grouped in memory (no N+1). Each target's ids come back ordered by sortOrder.
export async function loadLinkMap(
  targetType: CeresMediaTargetType,
  targetIds: readonly string[],
  purpose: string,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = [...new Set(targetIds)];
  if (ids.length === 0) return map;
  const rows = await prisma.ceresMediaLink.findMany({
    where: { targetType, targetId: { in: ids }, purpose },
    orderBy: { sortOrder: 'asc' },
    select: { targetId: true, mediaId: true },
  });
  for (const row of rows) {
    const list = map.get(row.targetId) ?? [];
    list.push(row.mediaId);
    map.set(row.targetId, list);
  }
  return map;
}

// Array-with-fallback for a batched map: link rows when present, else the legacy singular
// column, else [].
export function idsWithFallback(map: Map<string, string[]>, targetId: string, singular: string | null): string[] {
  const linked = map.get(targetId);
  if (linked && linked.length > 0) return linked;
  return singular ? [singular] : [];
}

// Same fallback, single-target convenience (one extra query — fine off a list, avoid in loops).
export async function resolveIdsWithFallback(
  targetType: CeresMediaTargetType,
  targetId: string,
  purpose: string,
  singular: string | null,
): Promise<string[]> {
  const linked = await singleTargetLinkIds(targetType, targetId, purpose);
  return linked.length > 0 ? linked : (singular ? [singular] : []);
}
