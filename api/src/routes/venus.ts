import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole, requireApp } from '../auth/middleware.js';
import { decodeExpressBytes, parseArmast, type ParsedVenusCustomer } from '../venus/parseArmast.js';
import { parseOesoc, type ParsedOesocDoc } from '../venus/parseOesoc.js';
import { recomputeStats } from '../venus/stats.js';

// Venus — 360° customer CRM. Stage A+B: backend foundation only (Express customer-master
// import). See docs/VENUS_BRIEF.md. Track-and-tell only; this file has no sales data / no
// analytics yet — just the customer dimension the rest of Venus builds on.
//
// Import is supervisor-only (mirrors Vulcan/Juno: imports/config = supervisor). Reading
// the customer list is per-grant: requireApp('venus') — supervisor always passes, md is
// excluded (md → ceres only), employees need 'venus' in their Agent.apps (owner-granted via
// Jupiter's admin UI). Suite-consistent with Vulcan/Juno/Ceres per the owner's access call.

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // real ARMAST export is ~6.6MB
const MAX_SALES_UPLOAD_BYTES = 16 * 1024 * 1024; // real OESOC export is ~13MB

// Lowercase + strip everything but alnum/Thai, so "Cก002" / "cก002" / "cก-002" all match
// the same stored searchKey — same convention as the SKU dash-insensitive search.
function toSearchKey(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-z฀-๿]/g, '');
}

// In-memory staging for previewed imports (same pattern as stock.ts / juno.ts bank
// import): the supervisor previews, eyeballs the diff, then applies the EXACT parsed set.
// Lost on restart (harmless — just re-upload). Small + short-lived.
interface StagedImport {
  fileName: string;
  customers: ParsedVenusCustomer[];
  unresolved: number;
  unresolvedSamples: string[];
  at: number;
}
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, StagedImport>();
function stash(s: StagedImport): string {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.at > PREVIEW_TTL_MS) previews.delete(k);
  while (previews.size >= 10) previews.delete(previews.keys().next().value as string);
  const token = randomUUID();
  previews.set(token, s);
  return token;
}

// In-memory staging for previewed SALES imports (separate map from customer imports —
// distinct shape, and we don't want a sales upload to evict a pending customer preview
// or vice versa). Same preview→apply contract: TTL + capped slot count, lost on restart.
interface StagedSalesImport {
  fileName: string;
  docs: ParsedOesocDoc[];
  distinctCodes: number;
  voids: number;
  unresolved: number;
  unresolvedSamples: string[];
  at: number;
}
const SALES_PREVIEW_TTL_MS = 30 * 60 * 1000;
const salesPreviews = new Map<string, StagedSalesImport>();
function stashSales(s: StagedSalesImport): string {
  const now = Date.now();
  for (const [k, v] of salesPreviews) if (now - v.at > SALES_PREVIEW_TTL_MS) salesPreviews.delete(k);
  while (salesPreviews.size >= 5) salesPreviews.delete(salesPreviews.keys().next().value as string);
  const token = randomUUID();
  salesPreviews.set(token, s);
  return token;
}

function toVenusCustomerData(c: ParsedVenusCustomer) {
  return {
    code: c.code,
    searchKey: toSearchKey(c.code),
    name: c.name,
    custType: c.custType,
    repCode: c.repCode,
    zone: c.zone,
    priceType: c.priceType,
    discount: c.discount,
    address: c.address,
    contact: c.contact,
    phone: c.phone,
    acctNo: c.acctNo,
    shipBy: c.shipBy,
    creditDays: c.creditDays,
    creditLimit: c.creditLimit,
    creditTerms: c.creditTerms,
    creditTermsNorm: c.creditTermsNorm,
    note: c.note,
  };
}

export async function venusRoutes(app: FastifyInstance) {
  // POST /api/venus/import/customers { dataB64, fileName, mode: 'preview'|'apply', token? }
  // Auth runs at onRequest (before body parsing) — same reasoning as stock.ts/juno.ts: a
  // large bodyLimit route must never let an anonymous client make the server buffer+parse
  // a multi-MB payload before auth is checked.
  app.post('/api/venus/import/customers', {
    onRequest: [requireAuth, requireRole('supervisor')],
    bodyLimit: 17 * 1024 * 1024, // ARMAST export (~6.6MB) inflated ~4/3 by base64, plus headroom
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({
      mode: z.enum(['preview', 'apply']),
      dataB64: z.string().min(1).optional(),
      fileName: z.string().max(300).optional(),
      token: z.string().min(1).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });

    if (body.data.mode === 'apply') {
      const token = body.data.token;
      const staged = token ? previews.get(token) : undefined;
      if (!token || !staged || Date.now() - staged.at > PREVIEW_TTL_MS) {
        if (token) previews.delete(token);
        return reply.code(410).send({ error: 'preview_expired', detail: 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' });
      }
      previews.delete(token);

      // Upsert by code in ONE transaction so a re-import (overlapping export) is safe and
      // idempotent — never creates duplicates, never partially applies.
      let created = 0;
      let updated = 0;
      const CHUNK = 100;
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < staged.customers.length; i += CHUNK) {
          const slice = staged.customers.slice(i, i + CHUNK);
          for (const c of slice) {
            const data = toVenusCustomerData(c);
            const existing = await tx.venusCustomer.findUnique({ where: { code: c.code }, select: { code: true } });
            await tx.venusCustomer.upsert({
              where: { code: c.code },
              create: data,
              update: data,
            });
            if (existing) updated++; else created++;
          }
        }
      });

      return {
        ok: true,
        created,
        updated,
        unresolved: staged.unresolved,
        unresolvedSamples: staged.unresolvedSamples,
      };
    }

    // mode === 'preview'
    if (!body.data.dataB64) return reply.code(400).send({ error: 'missing_data' });
    if (body.data.dataB64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) return reply.code(413).send({ error: 'too_large' });
    const buf = Buffer.from(body.data.dataB64, 'base64');
    if (!buf.length) return reply.code(400).send({ error: 'empty' });
    if (buf.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: 'too_large' });

    const { text, encoding } = decodeExpressBytes(buf);
    const parsed = parseArmast(text);
    if (parsed.parsedCount === 0) {
      return reply.code(422).send({
        error: 'no_rows',
        detail: 'ไม่พบรายการลูกค้าในไฟล์ — ตรวจสอบว่าเป็นรายงานรายละเอียดลูกค้าจาก Express (ARMAST)',
      });
    }

    const codes = parsed.customers.map((c) => c.code);
    const existingCustomers = await prisma.customer.findMany({
      where: { code: { in: codes } },
      select: { code: true },
    });
    const matchedCodes = new Set(existingCustomers.filter((c) => c.code).map((c) => c.code as string));

    const typeBreakdown = parsed.typeGroups;
    const creditBreakdown: Record<string, number> = {};
    for (const c of parsed.customers) {
      creditBreakdown[c.creditTermsNorm] = (creditBreakdown[c.creditTermsNorm] ?? 0) + 1;
    }

    const token = stash({
      fileName: String(body.data.fileName ?? ''),
      customers: parsed.customers,
      unresolved: parsed.unresolved,
      unresolvedSamples: parsed.unresolvedSamples,
      at: Date.now(),
    });

    return {
      token,
      fileName: String(body.data.fileName ?? ''),
      encoding,
      pageCount: parsed.pageCount,
      parsedCount: parsed.parsedCount,
      matched: matchedCodes.size,
      unmatched: parsed.parsedCount - matchedCodes.size,
      typeBreakdown,
      creditBreakdown,
      unresolved: parsed.unresolved,
      unresolvedSamples: parsed.unresolvedSamples,
    };
  });

  // POST /api/venus/import/sales { dataB64, fileName, mode: 'preview'|'apply', token? }
  // Sales order import (Express OESOC, grouped-by-customer report) — supervisor-only,
  // same preview→apply + in-memory staging shape as /import/customers above. Auth runs at
  // onRequest for the same reason: never let an anonymous client make the server
  // buffer+parse a multi-MB payload before auth is checked.
  app.post('/api/venus/import/sales', {
    onRequest: [requireAuth, requireRole('supervisor')],
    bodyLimit: 22 * 1024 * 1024, // OESOC export (~13MB) inflated ~4/3 by base64, plus headroom
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({
      mode: z.enum(['preview', 'apply']),
      dataB64: z.string().min(1).optional(),
      fileName: z.string().max(300).optional(),
      token: z.string().min(1).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });

    if (body.data.mode === 'apply') {
      const token = body.data.token;
      const staged = token ? salesPreviews.get(token) : undefined;
      if (!token || !staged || Date.now() - staged.at > SALES_PREVIEW_TTL_MS) {
        if (token) salesPreviews.delete(token);
        return reply.code(410).send({ error: 'preview_expired', detail: 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' });
      }
      salesPreviews.delete(token);

      // Resolve customerCode -> VenusCustomer.id once up front (avoids one query per doc).
      const codes = Array.from(new Set(staged.docs.map((d) => d.customerCode)));
      const customers = await prisma.venusCustomer.findMany({
        where: { code: { in: codes } },
        select: { id: true, code: true },
      });
      const idByCode = new Map(customers.map((c) => [c.code, c.id]));
      const unmatchedCodes = codes.filter((c) => !idByCode.has(c));

      // Upsert SaleDoc by docNo (idempotent re-import), replacing that doc's SaleLines
      // each time so a re-import always reflects the latest parse — never accumulates
      // duplicate lines. Chunked transactions (same shape as the customer import) so a
      // 11k+/72k-line import doesn't hold one giant transaction open.
      let docsCreated = 0;
      let docsUpdated = 0;
      let linesWritten = 0;
      const CHUNK = 50;
      for (let i = 0; i < staged.docs.length; i += CHUNK) {
        const slice = staged.docs.slice(i, i + CHUNK);
        await prisma.$transaction(async (tx) => {
          for (const d of slice) {
            if (!d.date) continue; // no valid date to import against — should not happen post-parse
            const customerId = idByCode.get(d.customerCode) ?? null;
            const data = {
              customerCode: d.customerCode,
              customerId,
              date: d.date,
              total: String(d.total),
              docType: d.docType,
              void: d.void,
              repCode: d.repCode,
              goodsValue: String(d.goodsValue),
              vat: String(d.vat),
              delivered: d.delivered,
              reference: d.reference,
            };
            const existing = await tx.saleDoc.findUnique({ where: { docNo: d.docNo }, select: { id: true } });
            const saleDoc = await tx.saleDoc.upsert({
              where: { docNo: d.docNo },
              create: { docNo: d.docNo, ...data },
              update: data,
            });
            if (existing) docsUpdated++; else docsCreated++;

            // Replace this doc's lines wholesale (idempotent on re-import).
            await tx.saleLine.deleteMany({ where: { saleDocId: saleDoc.id } });
            if (d.lines.length) {
              await tx.saleLine.createMany({
                data: d.lines.map((l) => ({
                  saleDocId: saleDoc.id,
                  lineNo: l.lineNo,
                  sku: l.sku,
                  productId: null, // Product match resolved on read (Vulcan SKU convention), not stored here
                  qty: l.qty,
                  unitPrice: l.unitPrice === null ? '' : String(l.unitPrice),
                  amount: l.amount === null ? '' : String(l.amount),
                })),
              });
              linesWritten += d.lines.length;
            }
          }
        });
      }

      return {
        ok: true,
        docsCreated,
        docsUpdated,
        linesWritten,
        unmatchedCodes,
        unresolved: staged.unresolved,
        unresolvedSamples: staged.unresolvedSamples,
      };
    }

    // mode === 'preview'
    if (!body.data.dataB64) return reply.code(400).send({ error: 'missing_data' });
    if (body.data.dataB64.length > Math.ceil((MAX_SALES_UPLOAD_BYTES * 4) / 3) + 4) {
      return reply.code(413).send({ error: 'too_large' });
    }
    const buf = Buffer.from(body.data.dataB64, 'base64');
    if (!buf.length) return reply.code(400).send({ error: 'empty' });
    if (buf.length > MAX_SALES_UPLOAD_BYTES) return reply.code(413).send({ error: 'too_large' });

    const { text, encoding } = decodeExpressBytes(buf);
    const parsed = parseOesoc(text);
    if (parsed.docs.length === 0) {
      return reply.code(422).send({
        error: 'no_rows',
        detail: 'ไม่พบใบสั่งขายในไฟล์ — ตรวจสอบว่าเป็นรายงานใบสั่งขายแยกตามลูกค้าจาก Express (OESOC)',
      });
    }

    const codes = Array.from(new Set(parsed.docs.map((d) => d.customerCode)));
    const existingCustomers = await prisma.venusCustomer.findMany({
      where: { code: { in: codes } },
      select: { code: true },
    });
    const matchedCodes = new Set(existingCustomers.map((c) => c.code));
    const unmatchedCodes = codes.filter((c) => !matchedCodes.has(c));

    const token = stashSales({
      fileName: String(body.data.fileName ?? ''),
      docs: parsed.docs,
      distinctCodes: parsed.distinctCodes,
      voids: parsed.voids,
      unresolved: parsed.unresolved,
      unresolvedSamples: parsed.unresolvedSamples,
      at: Date.now(),
    });

    return {
      token,
      fileName: String(body.data.fileName ?? ''),
      encoding,
      docs: parsed.docs.length,
      lineItems: parsed.lineItems,
      distinctCodes: parsed.distinctCodes,
      matchedCodes: matchedCodes.size,
      unmatchedCodes: unmatchedCodes.length,
      unmatchedCodesSample: unmatchedCodes.slice(0, 20),
      voids: parsed.voids,
      dateSpan: parsed.dateSpan,
      selfCertify: parsed.selfCertify,
      unresolved: parsed.unresolved,
      unresolvedSamples: parsed.unresolvedSamples,
    };
  });

  // POST /api/venus/recompute — recompute the RFM/trend/reorder engine on demand
  // (supervisor-only; the same job also runs via the runnable script for a future nightly
  // scheduler). Not gated behind requireApp('venus') like the read routes below — it's a
  // write/compute action, so it belongs with the other supervisor-only routes above.
  app.post('/api/venus/recompute', {
    onRequest: [requireAuth, requireRole('supervisor')],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async () => {
    const result = await recomputeStats(prisma);
    return { ok: true, ...result };
  });

  // Everything below requires login + the 'venus' app grant (supervisor always passes; md
  // excluded; employees need the grant). requireApp implies requireAuth ran, so run both.
  app.addHook('onRequest', requireAuth);
  app.addHook('preHandler', requireApp('venus'));

  // GET /api/venus/customers?q=&limit=&offset= — search by name/code (dash-insensitive
  // via searchKey), paginated.
  app.get('/api/venus/customers', async (req) => {
    const { q, limit, offset } = req.query as { q?: string; limit?: string; offset?: string };
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const query = String(q ?? '').trim();

    const where = query
      ? {
          OR: [
            { searchKey: { contains: toSearchKey(query) } },
            { name: { contains: query, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [total, customers] = await Promise.all([
      prisma.venusCustomer.count({ where }),
      prisma.venusCustomer.findMany({
        where,
        orderBy: { name: 'asc' },
        take,
        skip,
      }),
    ]);

    return { total, customers };
  });

  // GET /api/venus/customers/:code — detail.
  app.get('/api/venus/customers/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const customer = await prisma.venusCustomer.findUnique({ where: { code } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });
    return { customer };
  });
}
