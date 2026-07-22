import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole, requireApp } from '../auth/middleware.js';
import { decodeExpressBytes, parseArmast, type ParsedVenusCustomer } from '../venus/parseArmast.js';
import { parseOesoc, type ParsedOesocDoc } from '../venus/parseOesoc.js';
import { recomputeStats, type ReorderDueItem } from '../venus/stats.js';
import { generateAllCards } from '../venus/cards.js';
import { askNextPendingVisit, linkVisitToCustomer } from '../venus/visits.js';

// Venus — 360° customer CRM. Stage A+B: backend foundation only (Express customer-master
// import). See docs/VENUS_BRIEF.md. Track-and-tell only; this file has no sales data / no
// analytics yet — just the customer dimension the rest of Venus builds on.
//
// Import is supervisor-only (mirrors Vesta/Juno: imports/config = supervisor). Reading
// the customer list is per-grant: requireApp('venus') — supervisor always passes, gm is
// excluded (the gm implicit app set does not include Venus), central/staff need 'venus' in their
// Agent.apps (owner-granted via Jupiter's admin UI). Suite-consistent with Vesta/Juno/Ceres.

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // real ARMAST export is ~6.6MB
const MAX_SALES_UPLOAD_BYTES = 16 * 1024 * 1024; // real OESOC export is ~13MB

// Precaution #1 (การชำระเงิน, VENUS_BRIEF.md §7): Juno's Payment data only starts 2026-07,
// so a customer's payment history is thin for months. Below this many Payment rows, show
// "ข้อมูลยังน้อย" instead of a confident verdict rather than over-reading a tiny sample.
const PAYMENT_MIN_SAMPLE = Number(process.env.VENUS_PAYMENT_MIN_SAMPLE ?? 3);

// Lowercase + strip everything but alnum/Thai, so "Cก002" / "cก002" / "cก-002" all match
// the same stored searchKey — same convention as the SKU dash-insensitive search.
function toSearchKey(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-z฀-๿]/g, '');
}

// Same money-string convention as stats.ts / Ceres / Juno: baht amounts are stored as
// strings and parsed on read, never as float columns.
function parseMoney(s: string | null | undefined): number {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
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

      // Upsert by code, CHUNKED into bounded transactions (same shape as the sales import) —
      // a 10k-customer import must never sit in one giant transaction (Prisma's 5s default
      // would time out). Each chunk is idempotent, so re-importing / a partial retry is safe.
      // One existence-check per chunk (not per row) keeps the created/updated split cheap.
      let created = 0;
      let updated = 0;
      const CHUNK = 200;
      for (let i = 0; i < staged.customers.length; i += CHUNK) {
        const slice = staged.customers.slice(i, i + CHUNK);
        const sliceCodes = slice.map((c) => c.code);
        const existing = new Set(
          (await prisma.venusCustomer.findMany({ where: { code: { in: sliceCodes } }, select: { code: true } })).map((r) => r.code),
        );
        // Array form batches the chunk's upserts into one round-trip; 200 ops run well
        // under Prisma's default transaction timeout (the whole point of chunking).
        await prisma.$transaction(
          slice.map((c) => {
            const data = toVenusCustomerData(c);
            return prisma.venusCustomer.upsert({ where: { code: c.code }, create: data, update: data });
          }),
        );
        for (const c of slice) { if (existing.has(c.code)) updated++; else created++; }
      }

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
      const CHUNK = 100;
      for (let i = 0; i < staged.docs.length; i += CHUNK) {
        const slice = staged.docs.slice(i, i + CHUNK);
        // Prefetch which docNos already exist (one query/chunk) for the created/updated split,
        // instead of a findUnique per doc inside the transaction.
        const sliceDocNos = slice.map((d) => d.docNo);
        const existingDocNos = new Set(
          (await prisma.saleDoc.findMany({ where: { docNo: { in: sliceDocNos } }, select: { docNo: true } })).map((r) => r.docNo),
        );
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
            const saleDoc = await tx.saleDoc.upsert({
              where: { docNo: d.docNo },
              create: { docNo: d.docNo, ...data },
              update: data,
            });
            if (existingDocNos.has(d.docNo)) docsUpdated++; else docsCreated++;

            // Replace this doc's lines wholesale (idempotent on re-import).
            await tx.saleLine.deleteMany({ where: { saleDocId: saleDoc.id } });
            if (d.lines.length) {
              await tx.saleLine.createMany({
                data: d.lines.map((l) => ({
                  saleDocId: saleDoc.id,
                  lineNo: l.lineNo,
                  sku: l.sku,
                  name: l.name || null, // product name as printed on the report
                  unit: l.unit || null,
                  productId: null, // Product match resolved on read (Vesta SKU convention), not stored here
                  qty: l.qty,
                  unitPrice: l.unitPrice === null ? '' : String(l.unitPrice),
                  amount: l.amount === null ? '' : String(l.amount),
                })),
              });
              linesWritten += d.lines.length;
            }
          }
        }, { timeout: 60000 }); // bounded chunk; 60s headroom so network latency can't trip the 5s default
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

  // POST /api/venus/generate-cards { limit? } — supervisor-only. Generate AI suggestion
  // cards for the top-value flagged customers (BOUNDED so it stays a sync request — the
  // full base of ~2k is best done via the scheduled weekly job, not one HTTP call). Each
  // card is one LLM call; fail-soft (no ANTHROPIC_API_KEY → 0 written, no error).
  app.post('/api/venus/generate-cards', {
    onRequest: [requireAuth, requireRole('supervisor')],
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req) => {
    const parsed = z.object({
      limit: z.number().int().min(1).max(100).optional(),
      full: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    const full = parsed.success ? parsed.data.full ?? false : false;

    if (full) {
      // Validate the key + model on a tiny SYNC sample first — a bad key/model then returns
      // immediately (started:false + the skip counts) instead of silently doing nothing in
      // the background. If the sample writes cards, kick off the whole base in the background
      // (a ~2k-customer run is far too long to hold one HTTP request open) and return started.
      const sample = await generateAllCards(prisma, { limit: 3 });
      if (sample.written === 0) return { ok: true, started: false, ...sample };
      void generateAllCards(prisma).catch((err) => app.log.error({ err }, 'venus full card run failed'));
      return { ok: true, started: true, candidates: sample.candidates };
    }

    const limit = parsed.success ? parsed.data.limit ?? 15 : 15;
    const result = await generateAllCards(prisma, { limit });
    return { ok: true, started: false, ...result };
  });

  // Everything below requires login + the 'venus' app grant (supervisor always passes; gm
  // excluded; staff need the grant). requireApp implies requireAuth ran, so run both.
  app.addHook('onRequest', requireAuth);
  app.addHook('preHandler', requireApp('venus'));

  // GET /api/venus/customers?q=&limit=&offset=&segment= — search by name/code
  // (dash-insensitive via searchKey), paginated. Left-joins CustomerStats (Prisma has no
  // relation between VenusCustomer and CustomerStats — they're linked only by the shared
  // `code`/`customerCode` string, same soft-link reasoning as SaleDoc — so the join is done
  // in application code: fetch the page of customers, then fetch stats for just those
  // codes) so each row can show a segment chip + `m` without an extra round trip per row.
  // `?segment=` filters to customers whose CustomerStats.segment matches exactly.
  app.get('/api/venus/customers', async (req) => {
    const { q, limit, offset, segment } = req.query as {
      q?: string; limit?: string; offset?: string; segment?: string;
    };
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const query = String(q ?? '').trim();
    const segmentFilter = String(segment ?? '').trim();

    const where: Record<string, unknown> = query
      ? {
          OR: [
            { searchKey: { contains: toSearchKey(query) } },
            { name: { contains: query, mode: 'insensitive' as const } },
          ],
        }
      : {};

    if (segmentFilter) {
      // CustomerStats has no relation field on VenusCustomer, so filter by first resolving
      // which codes carry that segment, then intersecting with the code column.
      const codesInSegment = await prisma.customerStats.findMany({
        where: { segment: segmentFilter },
        select: { customerCode: true },
      });
      where.code = { in: codesInSegment.map((s) => s.customerCode) };
    }

    const [total, customers] = await Promise.all([
      prisma.venusCustomer.count({ where }),
      prisma.venusCustomer.findMany({
        where,
        orderBy: { name: 'asc' },
        take,
        skip,
      }),
    ]);

    const stats = customers.length
      ? await prisma.customerStats.findMany({
          where: { customerCode: { in: customers.map((c) => c.code) } },
          select: { customerCode: true, segment: true, m: true },
        })
      : [];
    const statsByCode = new Map(stats.map((s) => [s.customerCode, s]));

    return {
      total,
      customers: customers.map((c) => ({
        ...c,
        segment: statsByCode.get(c.code)?.segment ?? null,
        m: statsByCode.get(c.code)?.m ?? null,
      })),
    };
  });

  // Visit reports and follow-up queue. These inherit the suite-wide Venus hooks above;
  // no supervisor-only surface is introduced.
  app.get('/api/venus/visits', async (req) => {
    const query = z.object({
      customerCode: z.string().optional(),
      status: z.enum(['matched', 'awaiting_match', 'skipped']).optional(),
      recent: z.enum(['0', '1']).optional(),
    }).safeParse(req.query ?? {});
    const filters = query.success ? query.data : {};
    return prisma.venusVisit.findMany({
      where: {
        ...(filters.customerCode ? { customerCode: filters.customerCode } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: [{ visitAt: 'desc' }, { createdAt: 'desc' }],
      take: filters.recent === '1' ? 20 : 200,
      include: { actionItems: { orderBy: { createdAt: 'asc' } } },
    });
  });

  app.post('/api/venus/visits/:id/link', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ customerCode: z.string().min(1).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const customer = await prisma.venusCustomer.findUnique({
      where: { code: body.data.customerCode },
      select: { code: true },
    });
    if (!customer) return reply.code(404).send({ error: 'customer_not_found' });
    try {
      const linked = await linkVisitToCustomer(id, customer.code, 'manual');
      if (linked.wasPendingHead) await askNextPendingVisit(linked.groupId);
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && err.message === 'visit_not_found') {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    }
  });

  app.get('/api/venus/action-items', async (req) => {
    const { open } = req.query as { open?: string };
    return prisma.venusActionItem.findMany({
      where: open === '1' ? { done: false } : {},
      orderBy: [{ needsOwner: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: { visit: { select: { visitAt: true, repName: true, summary: true } } },
    });
  });

  app.post('/api/venus/action-items/:id/done', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ done: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const done = body.data.done ?? true;
    const result = await prisma.venusActionItem.updateMany({
      where: { id },
      data: {
        done,
        doneAt: done ? new Date() : null,
        doneBy: done ? (req.agent?.name ?? null) : null,
      },
    });
    if (!result.count) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, done };
  });

  // GET /api/venus/dashboard — management lens (VENUS_BRIEF.md §8): data-coverage banner,
  // segment distribution, at-risk list (ranked by M — "lose the biggest first"), top
  // movers, and the opportunity queue (reorder-due customers). Pure reads over
  // CustomerStats; nothing here recomputes — that's POST /api/venus/recompute.
  app.get('/api/venus/dashboard', async () => {
    const [totalCustomers, totalWithSales, segmentGroups, coverage] = await Promise.all([
      prisma.venusCustomer.count(),
      prisma.customerStats.count(),
      prisma.customerStats.groupBy({ by: ['segment'], _count: { _all: true } }),
      prisma.saleDoc.aggregate({ where: { void: false }, _min: { date: true }, _max: { date: true } }),
    ]);

    const segmentCounts: Record<string, number> = {};
    for (const g of segmentGroups) {
      if (g.segment) segmentCounts[g.segment] = g._count._all;
    }

    // At-risk: segment='เสี่ยงหาย' ordered by M desc — the brief's "lose the biggest first".
    const atRiskRows = await prisma.customerStats.findMany({
      where: { segment: 'เสี่ยงหาย' },
      orderBy: { m: 'desc' },
      take: 50,
      select: { customerCode: true, m: true, f: true, rfmScore: true, trendPct: true, trendDir: true },
    });
    const atRiskCustomers = await prisma.venusCustomer.findMany({
      where: { code: { in: atRiskRows.map((r) => r.customerCode) } },
      select: { code: true, name: true },
    });
    const nameByCode = new Map(atRiskCustomers.map((c) => [c.code, c.name]));
    const atRisk = atRiskRows.map((r) => ({
      code: r.customerCode,
      name: nameByCode.get(r.customerCode) ?? '',
      m: r.m ?? 0,
      f: r.f ?? 0,
      rfmScore: r.rfmScore,
      trendPct: r.trendPct ?? 0,
      trendDir: r.trendDir ?? 'flat',
    }));

    // Top movers: only customers with meaningful prior-window activity (trendOrders != 0
    // alone isn't enough signal — require some current or previous revenue via trendPct
    // being non-trivial, i.e. exclude the "0 -> 0" / brand-new-with-no-baseline noise by
    // requiring f >= 1, which CustomerStats rows already guarantee, plus a non-zero trend).
    const moversUp = await prisma.customerStats.findMany({
      where: { trendDir: 'up', trendPct: { gt: 0 } },
      orderBy: { trendPct: 'desc' },
      take: 10,
      select: { customerCode: true, m: true, trendPct: true, trendDir: true, trendOrders: true },
    });
    const moversDown = await prisma.customerStats.findMany({
      where: { trendDir: 'down', trendPct: { lt: 0 } },
      orderBy: { trendPct: 'asc' },
      take: 10,
      select: { customerCode: true, m: true, trendPct: true, trendDir: true, trendOrders: true },
    });
    const moverCodes = [...moversUp, ...moversDown].map((r) => r.customerCode);
    const moverCustomers = moverCodes.length
      ? await prisma.venusCustomer.findMany({ where: { code: { in: moverCodes } }, select: { code: true, name: true } })
      : [];
    const moverNameByCode = new Map(moverCustomers.map((c) => [c.code, c.name]));
    const toMover = (r: (typeof moversUp)[number]) => ({
      code: r.customerCode,
      name: moverNameByCode.get(r.customerCode) ?? '',
      m: r.m ?? 0,
      trendPct: r.trendPct ?? 0,
      trendDir: r.trendDir ?? 'flat',
      trendOrders: r.trendOrders ?? 0,
    });

    // Opportunity queue: customers with a non-empty reorderDue JSON array. Prisma cannot
    // filter "JSON array non-empty" portably, so pull segment-agnostic candidates (anyone
    // with a reorderDue value that isn't SQL NULL) and filter/flatten in application code —
    // the CustomerStats table is per-customer (thousands of rows, not millions), so this is
    // a cheap in-memory pass, not a scan concern.
    const withReorder = await prisma.customerStats.findMany({
      where: { reorderDue: { not: Prisma.JsonNull } },
      select: { customerCode: true, reorderDue: true },
    });
    const reorderCustomers = withReorder.filter(
      (r) => Array.isArray(r.reorderDue) && (r.reorderDue as unknown[]).length > 0,
    );
    const oppCustomers = reorderCustomers.length
      ? await prisma.venusCustomer.findMany({
          where: { code: { in: reorderCustomers.map((r) => r.customerCode) } },
          select: { code: true, name: true },
        })
      : [];
    const oppNameByCode = new Map(oppCustomers.map((c) => [c.code, c.name]));
    const opportunityQueue = reorderCustomers
      .map((r) => {
        const items = r.reorderDue as unknown as ReorderDueItem[];
        const mostOverdue = items.reduce((max, it) => (it.dueSinceDays > max ? it.dueSinceDays : max), 0);
        return {
          code: r.customerCode,
          name: oppNameByCode.get(r.customerCode) ?? '',
          reorderDue: items,
          mostOverdue,
        };
      })
      .sort((a, b) => b.mostOverdue - a.mostOverdue);

    return {
      coverage: { from: coverage._min.date, to: coverage._max.date },
      segmentCounts,
      totalCustomers,
      totalWithSales,
      atRisk,
      topMovers: { up: moversUp.map(toMover), down: moversDown.map(toMover) },
      opportunityQueue,
    };
  });

  // GET /api/venus/customers/:code — enriched rep-lens detail: customer master data +
  // CustomerStats (RFM/trend/reorder) + recent purchase timeline + a per-product cycle
  // summary + the (Phase-1-only-so-far) precautions slot.
  app.get('/api/venus/customers/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const customer = await prisma.venusCustomer.findUnique({ where: { code } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });

    const stats = await prisma.customerStats.findUnique({ where: { customerCode: code } });

    const docs = await prisma.saleDoc.findMany({
      where: { customerCode: code },
      orderBy: { date: 'desc' },
      take: 50,
      include: { lines: true },
    });

    const skus = Array.from(new Set(docs.flatMap((d) => d.lines.map((l) => l.sku)).filter((s): s is string => !!s)));
    const products = skus.length
      ? await prisma.product.findMany({ where: { sku: { in: skus } }, select: { sku: true, nameEn: true, nameTh: true } })
      : [];
    const productBySku = new Map(products.map((p) => [p.sku, p]));

    const purchases = docs.map((d) => ({
      docNo: d.docNo,
      date: d.date,
      total: parseMoney(d.total),
      docType: d.docType,
      void: d.void,
      lines: d.lines.map((l) => ({
        sku: l.sku,
        // the line's own printed name is the source of truth; fall back to the Product
        // catalog only when a line predates name-capture.
        name: l.name || (l.sku ? productBySku.get(l.sku)?.nameTh || productBySku.get(l.sku)?.nameEn || null : null),
        qty: l.qty,
        unit: l.unit,
        amount: parseMoney(l.amount),
      })),
    }));

    // Per-product cycle summary: every SKU bought >=1 time (across ALL non-void docs
    // returned above — the recent-50 window, same scope as `purchases`), with reorder
    // status pulled from stats.reorderDue when that SKU is flagged there.
    const reorderBySku = new Map(
      (Array.isArray(stats?.reorderDue) ? (stats!.reorderDue as unknown as ReorderDueItem[]) : []).map((r) => [r.sku, r]),
    );
    interface Cycle { sku: string; name: string | null; count: number; lastPurchase: Date; totalQty: number }
    const cyclesBySku = new Map<string, Cycle>();
    for (const d of docs) {
      if (d.void) continue;
      for (const l of d.lines) {
        if (!l.sku) continue;
        const existing = cyclesBySku.get(l.sku);
        if (existing) {
          existing.count += 1;
          existing.totalQty += l.qty;
          if (d.date > existing.lastPurchase) existing.lastPurchase = d.date;
        } else {
          cyclesBySku.set(l.sku, {
            sku: l.sku,
            name: l.name || productBySku.get(l.sku)?.nameTh || productBySku.get(l.sku)?.nameEn || null,
            count: 1,
            totalQty: l.qty,
            lastPurchase: d.date,
          });
        }
      }
    }
    const productCycles = Array.from(cyclesBySku.values())
      .map((c) => {
        const due = reorderBySku.get(c.sku);
        return {
          sku: c.sku,
          name: c.name,
          count: c.count,
          totalQty: c.totalQty,
          lastPurchase: c.lastPurchase,
          reorderStatus: due ? ('due' as const) : ('ok' as const),
          reorderDue: due ?? null,
        };
      })
      .sort((a, b) => b.lastPurchase.getTime() - a.lastPurchase.getTime());

    // Precaution #1 (การชำระเงิน): join Juno's Payment by customerCode — a compact factual
    // summary only (count / flagged / most recent), never a "confident verdict" beyond what
    // the sample supports. Juno data starts 2026-07, so most customers will be thin for
    // months; below PAYMENT_MIN_SAMPLE rows, say so explicitly rather than reading tea leaves.
    const payments = await prisma.payment.findMany({
      where: { customerCode: code },
      orderBy: { createdAt: 'desc' },
      select: { flagged: true, createdAt: true },
    });
    let paymentPrecaution: string | null = null;
    if (payments.length === 0) {
      paymentPrecaution = null; // no Juno history at all — nothing to say yet
    } else if (payments.length < PAYMENT_MIN_SAMPLE) {
      paymentPrecaution = `ข้อมูลยังน้อย (${payments.length} รายการ)`;
    } else {
      const flaggedCount = payments.filter((p) => p.flagged).length;
      const latest = payments[0].createdAt;
      paymentPrecaution = `มี ${payments.length} รายการชำระ, flagged ${flaggedCount} รายการ (ล่าสุด ${latest.toLocaleDateString('th-TH')})`;
    }

    // Precaution #2 (เสี่ยงหาย): the RFM at-risk/lost segments, surfaced WITH evidence — the
    // segment chip alone doesn't say why. Evidence = real computed numbers only (stats.r =
    // days since last purchase; the typical cadence, when knowable, comes from the shortest
    // known reorder cycle in reorderDue — never invented). Null when not at-risk/lost.
    let churnPrecaution: string | null = null;
    if (stats && (stats.segment === 'เสี่ยงหาย' || stats.segment === 'หายไปแล้ว') && stats.r != null) {
      const reorderItems = Array.isArray(stats.reorderDue) ? (stats.reorderDue as unknown as ReorderDueItem[]) : [];
      const knownCadence = reorderItems.length
        ? Math.round(Math.min(...reorderItems.map((r) => r.medianGapDays)))
        : null;
      churnPrecaution = knownCadence != null
        ? `หายไป ${stats.r} วัน ทั้งที่เคยซื้อทุก ${knownCadence} วัน`
        : `หายไป ${stats.r} วัน (เคยซื้อ ${stats.f ?? 0} ครั้งในช่วงข้อมูล)`;
    }

    const note = await prisma.venusNote.findUnique({ where: { customerCode: code } });

    // AI suggestion card (VENUS_BRIEF.md §7, Phase 3 stage 2) — READ-ONLY here: this route
    // never generates a card, it only serves whatever the weekly batch (venus-generate-cards.ts
    // / api/src/venus/cards.ts) already wrote. Null when no card exists yet (no active signal,
    // or the LLM wasn't available at generation time) — the UI treats that as "nothing extra to
    // show", not an error.
    const card = await prisma.venusCard.findUnique({
      where: { customerCode: code },
      select: { text: true, createdAt: true },
    });

    const precautions = {
      credit: customer.creditDays != null
        ? `เครดิต ${customer.creditDays} วัน${customer.creditTermsNorm ? ` (${customer.creditTermsNorm})` : ''}`
        : customer.creditTermsNorm === 'CASH' ? 'เงินสด' : null,
      payment: paymentPrecaution,
      churn: churnPrecaution,
      complaints: null as string | null, // Phase 3 stage 2: AI-tagged from LINE history — separate build
      note: note ? { text: note.text, authorName: note.authorName, updatedAt: note.updatedAt } : null,
    };

    return {
      customer,
      stats,
      purchases,
      productCycles,
      precautions,
      aiCard: card ? { text: card.text, createdAt: card.createdAt } : null,
    };
  });

  // PUT /api/venus/customers/:code/note — upsert the manual pinned ข้อควรระวัง note
  // (VENUS_BRIEF.md §7 precaution #4). Shared-pool: any logged-in Venus user may write
  // (same requireApp('venus') gate as the reads above, not supervisor-only — this is a
  // team note, not an import/config action). Empty text clears the note entirely.
  app.put('/api/venus/customers/:code/note', async (req, reply) => {
    const { code } = req.params as { code: string };
    const body = z.object({ text: z.string().max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });

    const customer = await prisma.venusCustomer.findUnique({ where: { code }, select: { code: true } });
    if (!customer) return reply.code(404).send({ error: 'not_found' });

    const text = body.data.text.trim();
    const authorName = req.agent?.name ?? null;

    if (!text) {
      await prisma.venusNote.deleteMany({ where: { customerCode: code } });
      return { ok: true, note: null };
    }

    const saved = await prisma.venusNote.upsert({
      where: { customerCode: code },
      create: { customerCode: code, text, authorName },
      update: { text, authorName },
    });

    return { ok: true, note: { text: saved.text, authorName: saved.authorName, updatedAt: saved.updatedAt } };
  });
}
