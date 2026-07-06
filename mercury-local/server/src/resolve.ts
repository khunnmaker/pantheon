// Alias resolution — the core secret step. Resolve each pending request's cloud itemId against
// the LOCAL SecretMap, producing either a resolved PO line (real identity) or a flagged reason it
// could not be resolved. NOTHING here ever goes back to the cloud. See docs/MERCURY_BRIEF.md §3.
//
// Resolution rules (from the task brief):
//  1. SecretMap row exists for cloudItemId → REAL identity: realName, vendor, realSku, unitCost,
//     currency, classification (normal|special), photoRef.
//  2. Else if the cloud item is ORDINARY (isSecret=false, has vulcanSku) → fall back to the cloud
//     displayName + vulcanSku (no secret needed). Vendor is UNKNOWN → flag "needs mapping".
//  3. Secret item (isSecret=true) with NO SecretMap → flag "unmapped secret — cannot resolve".
//  4. Any other unresolvable case (e.g. missing item join) → flag, never silently dropped.
import type { PendingRequest, SecretMap, Vendor } from '@prisma/client';

export type UnresolvedReason =
  | 'needs_mapping' // ordinary item, no SecretMap → vendor unknown, owner should map it
  | 'unmapped_secret' // secret item, no SecretMap → cannot resolve, owner must add a SecretMap
  | 'unknown'; // defensive: item join missing / bad data

export interface ResolvedLine {
  cloudItemId: string;
  cloudRequestId: string;
  realName: string;
  realSku: string;
  qty: string;
  unitCost: string;
  currency: string;
  classification: 'normal' | 'special';
  photoRef: string | null;
  vendorId: string;
  vendorName: string;
}

export interface UnresolvedLine {
  cloudItemId: string;
  cloudRequestId: string;
  reason: UnresolvedReason;
  displayName: string; // cloud alias/display (non-secret) — safe to show the owner
  qty: string;
  vulcanSku: string | null;
}

export interface ResolveResult {
  resolved: ResolvedLine[];
  unresolved: UnresolvedLine[];
}

type SecretMapWithVendor = SecretMap & { vendor: Vendor };

const asClassification = (c: string): 'normal' | 'special' =>
  c === 'special' ? 'special' : 'normal';

// Resolve a batch of pending requests against a SecretMap lookup (keyed by cloudItemId).
export function resolvePending(
  pending: PendingRequest[],
  secretMaps: SecretMapWithVendor[],
): ResolveResult {
  const byCloudItem = new Map(secretMaps.map((m) => [m.cloudItemId, m]));
  const resolved: ResolvedLine[] = [];
  const unresolved: UnresolvedLine[] = [];

  for (const pr of pending) {
    const map = byCloudItem.get(pr.itemId);
    if (map) {
      // Rule 1 — real identity from the local SecretMap.
      resolved.push({
        cloudItemId: pr.itemId,
        cloudRequestId: pr.cloudRequestId,
        realName: map.realName,
        realSku: map.realSku,
        qty: pr.qty,
        unitCost: map.unitCost,
        currency: map.currency || 'THB',
        classification: asClassification(map.classification),
        photoRef: map.photoRef,
        vendorId: map.vendorId,
        vendorName: map.vendor?.name ?? '(unknown vendor)',
      });
      continue;
    }
    // No SecretMap. Branch on whether the cloud item is secret.
    if (pr.itemIsSecret) {
      // Rule 3 — secret item with no map: cannot resolve. Owner must add a SecretMap row.
      unresolved.push({
        cloudItemId: pr.itemId,
        cloudRequestId: pr.cloudRequestId,
        reason: 'unmapped_secret',
        displayName: pr.itemDisplayName,
        qty: pr.qty,
        vulcanSku: pr.itemVulcanSku,
      });
    } else if (pr.itemVulcanSku) {
      // Rule 2 — ordinary item, fall back to cloud display + vulcanSku, but vendor unknown.
      unresolved.push({
        cloudItemId: pr.itemId,
        cloudRequestId: pr.cloudRequestId,
        reason: 'needs_mapping',
        displayName: pr.itemDisplayName,
        qty: pr.qty,
        vulcanSku: pr.itemVulcanSku,
      });
    } else {
      // Rule 4 — anything else (ordinary but no SKU, or missing join): flag, never drop.
      unresolved.push({
        cloudItemId: pr.itemId,
        cloudRequestId: pr.cloudRequestId,
        reason: 'unknown',
        displayName: pr.itemDisplayName || pr.itemId,
        qty: pr.qty,
        vulcanSku: pr.itemVulcanSku,
      });
    }
  }
  return { resolved, unresolved };
}

// Group resolved lines by vendorId → one PO draft per vendor.
export function groupByVendor(resolved: ResolvedLine[]): Map<string, ResolvedLine[]> {
  const groups = new Map<string, ResolvedLine[]>();
  for (const line of resolved) {
    const arr = groups.get(line.vendorId);
    if (arr) arr.push(line);
    else groups.set(line.vendorId, [line]);
  }
  return groups;
}
