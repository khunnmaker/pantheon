// PO orchestration — the pull→resolve→build-PO→PDF pipeline, wiring cloud.ts + resolve.ts + pdf.ts
// against the local DB. NOTHING here sends email (that's chunk 2c). See docs/MERCURY_BRIEF.md §5/§6.
import './env.js';
import { prisma } from './db.js';
import { cloudPull, cloudAdjustStock, cloudReceiveRequest, CloudError } from './cloud.js';
import { loadConnection } from './connection.js';
import { resolvePending, groupByVendor, type ResolveResult } from './resolve.js';
import { buildPoPdf, type PdfLine } from './pdf.js';

// ── Sync: pull pending requests + items from cloud, join locally, refresh the PendingRequest shadow.
export async function syncPending(
  baseUrl: string,
  token: string,
): Promise<{ synced: number; pruned: number }> {
  const { requests, items } = await cloudPull(baseUrl, token);
  // Index items by id for the join. The cloud request may also carry .item inline; prefer the
  // items list, fall back to the inline join.
  const itemById = new Map(items.map((it) => [it.id, it]));

  // Only keep pending requests (defensive — the cloud filter already does this).
  const pending = requests.filter((r) => r.status === 'pending');

  let synced = 0;
  for (const r of pending) {
    const item = itemById.get(r.itemId) ?? r.item ?? null;
    await prisma.pendingRequest.upsert({
      where: { cloudRequestId: r.id },
      create: {
        cloudRequestId: r.id,
        itemId: r.itemId,
        qty: r.qty ?? '',
        note: r.note ?? '',
        requestedById: r.requestedById ?? null,
        status: r.status,
        itemDisplayName: item?.displayName ?? '',
        itemIsSecret: item?.isSecret ?? false,
        itemVestaSku: item?.vestaSku ?? null,
        cloudCreatedAt: r.createdAt ?? '',
      },
      update: {
        itemId: r.itemId,
        qty: r.qty ?? '',
        note: r.note ?? '',
        requestedById: r.requestedById ?? null,
        status: r.status,
        itemDisplayName: item?.displayName ?? '',
        itemIsSecret: item?.isSecret ?? false,
        itemVestaSku: item?.vestaSku ?? null,
        cloudCreatedAt: r.createdAt ?? '',
      },
    });
    synced++;
  }

  // Prune local shadows whose cloud request is no longer pending (ordered/received/cancelled or
  // deleted) — keep the shadow in step with the cloud, but never touch built POs.
  const stillPendingIds = new Set(pending.map((r) => r.id));
  const localShadows = await prisma.pendingRequest.findMany({ select: { id: true, cloudRequestId: true } });
  const stale = localShadows.filter((s) => !stillPendingIds.has(s.cloudRequestId)).map((s) => s.id);
  let pruned = 0;
  if (stale.length) {
    const del = await prisma.pendingRequest.deleteMany({ where: { id: { in: stale } } });
    pruned = del.count;
  }
  return { synced, pruned };
}

// ── Resolve the current shadow against the local SecretMap (read-only preview). ──────────────
export async function resolveShadow(): Promise<ResolveResult> {
  const [pending, secretMaps] = await Promise.all([
    prisma.pendingRequest.findMany({ where: { status: 'pending' } }),
    prisma.secretMap.findMany({ include: { vendor: true } }),
  ]);
  return resolvePending(pending, secretMaps);
}

// ── Build PO drafts from the current pending shadow: resolve → group by vendor → create draft POs.
// Returns the created draft POs plus the unresolved list (surfaced, never dropped).
export async function buildPosFromPending(): Promise<{
  created: { id: string; vendorId: string; vendorName: string; poNumber: string; lineCount: number }[];
  unresolvedCount: number;
}> {
  const { resolved, unresolved } = await resolveShadow();
  const groups = groupByVendor(resolved);
  const vendors = await prisma.vendor.findMany();
  const vendorById = new Map(vendors.map((v) => [v.id, v]));

  const created: {
    id: string;
    vendorId: string;
    vendorName: string;
    poNumber: string;
    lineCount: number;
  }[] = [];

  // A simple date-stamped PO number sequence, unique-ish per build.
  const stamp = new Date();
  const datePart = stamp.toISOString().slice(0, 10).replace(/-/g, '');
  let seq = 1;

  for (const [vendorId, lines] of groups) {
    const vendor = vendorById.get(vendorId);
    const poNumber = `PO-${datePart}-${String(seq).padStart(3, '0')}`;
    seq++;
    const po = await prisma.purchaseOrder.create({
      data: {
        vendorId,
        poNumber,
        status: 'draft',
        lines: {
          create: lines.map((l) => ({
            cloudItemId: l.cloudItemId,
            cloudRequestId: l.cloudRequestId,
            realName: l.realName,
            realSku: l.realSku,
            qty: l.qty,
            unit: '',
            unitCost: l.unitCost,
            currency: l.currency,
            classification: l.classification,
            photoRef: l.photoRef,
          })),
        },
      },
    });
    created.push({
      id: po.id,
      vendorId,
      vendorName: vendor?.name ?? '(unknown vendor)',
      poNumber,
      lineCount: lines.length,
    });
  }
  return { created, unresolvedCount: unresolved.length };
}

// ── Secret goods-receipt (Phase 3, LOCAL-side) ───────────────────────────────────────────────
// A SECRET item's real SKU lives ONLY in the local SecretMap, so ITS Vesta stock bump must happen
// from here (the cloud cannot resolve it by design). Flow for one cloud MercuryRequest:
//   1. resolve realSku from the local SecretMap (keyed by the request's cloud itemId),
//   2. call the cloud Vesta stock-adjust endpoint to bump Product.stock by qty (audit reason
//      "Mercury secret goods-receipt") — this is the ONLY moment realSku touches the cloud, as a
//      transient adjust CALL; it is NEVER written onto a MercuryItem/MercuryRequest row,
//   3. mark the cloud MercuryRequest 'received' (STATUS ONLY — no SKU),
//   4. reflect it in the local shadow.
// The cloud calls are injectable so the whole flow is provable offline with mocks (no network).
export interface SecretReceiptOutcome {
  cloudRequestId: string;
  realSku: string;
  qty: number;
  toQty: number; // resulting Vesta stock after the bump
}

export async function receiveSecret(
  cloudRequestId: string,
  qty: number,
  deps?: {
    adjust?: typeof cloudAdjustStock;
    receive?: typeof cloudReceiveRequest;
  },
): Promise<SecretReceiptOutcome> {
  if (!Number.isInteger(qty) || qty <= 0) throw new CloudError('qty must be a positive integer', 400);

  const shadow = await prisma.pendingRequest.findUnique({ where: { cloudRequestId } });
  if (!shadow) throw new CloudError('unknown local request — sync first', 404);

  // Resolve the real SKU from the LOCAL SecretMap. This value NEVER goes onto a cloud row.
  const secret = await prisma.secretMap.findUnique({ where: { cloudItemId: shadow.itemId } });
  if (!secret) throw new CloudError('no SecretMap for this item — add the mapping first', 409);
  const realSku = secret.realSku.trim();
  if (!realSku) throw new CloudError('SecretMap has no realSku — set it first', 409);

  const conn = loadConnection();
  if (!conn) throw new CloudError('not connected — set up the cloud connection first', 409);

  const adjust = deps?.adjust ?? cloudAdjustStock;
  const receive = deps?.receive ?? cloudReceiveRequest;

  // 1+2. Bump Vesta stock for the REAL sku via the cloud adjust endpoint (realSku only leaves as a
  // transient call). Do this FIRST so a failure here doesn't leave the request marked received with
  // no stock movement.
  const { toQty } = await adjust(
    conn.baseUrl,
    conn.token,
    realSku,
    qty,
    'Mercury secret goods-receipt',
  );

  // 3. Mark the cloud MercuryRequest received (STATUS ONLY — the cloud row still has no SKU).
  await receive(conn.baseUrl, conn.token, cloudRequestId, String(qty));

  // 4. Reflect locally (prune-friendly: the next sync drops non-pending shadows).
  await prisma.pendingRequest.updateMany({
    where: { cloudRequestId },
    data: { status: 'received' },
  });

  return { cloudRequestId, realSku, qty, toQty };
}

// ── Generate the PDF for a draft PO. Saves to PurchaseOrder.pdfPath and returns the path. ─────
export async function generatePoPdf(poId: string): Promise<string> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { vendor: true, lines: true },
  });
  if (!po) throw new Error('po_not_found');
  if (!po.vendor) throw new Error('po_has_no_vendor');

  const pdfLines: PdfLine[] = po.lines.map((l) => ({
    realName: l.realName,
    qty: l.qty,
    unit: l.unit,
    classification: (l.classification === 'special' ? 'special' : 'normal') as 'normal' | 'special',
    photoRef: l.photoRef,
  }));

  const path = await buildPoPdf({
    vendor: {
      name: po.vendor.name,
      email: po.vendor.email,
      ccList: po.vendor.ccList,
      contactName: po.vendor.contactName,
      isTaiwan: po.vendor.isTaiwan,
      terms: po.vendor.terms,
    },
    poNumber: po.poNumber ?? po.id,
    date: po.createdAt,
    lines: pdfLines,
  });

  await prisma.purchaseOrder.update({ where: { id: poId }, data: { pdfPath: path } });
  return path;
}
