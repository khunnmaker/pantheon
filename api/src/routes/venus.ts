import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { decodeExpressBytes, parseArmast, type ParsedVenusCustomer } from '../venus/parseArmast.js';

// Venus — 360° customer CRM. Stage A+B: backend foundation only (Express customer-master
// import). See docs/VENUS_BRIEF.md. Track-and-tell only; this file has no sales data / no
// analytics yet — just the customer dimension the rest of Venus builds on.
//
// Import is supervisor-only (mirrors Vulcan/Juno: imports/config = supervisor). Reading
// the customer list is open to supervisor + agents (Venus is explicitly the first
// non-Minerva deity agents can enter — md/messenger stay excluded per VENUS_BRIEF.md §3).

const READ_ROLES = new Set(['supervisor', 'employee']); // md/messenger excluded (Ceres-only)
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // real ARMAST export is ~6.6MB

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

  // Everything below requires login; GET routes are open to supervisor + agents (md and
  // messenger are excluded — see READ_ROLES above).
  app.addHook('onRequest', requireAuth);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.agent || !READ_ROLES.has(req.agent.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

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
