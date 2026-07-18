import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

type TotalRow = {
  calls: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  estCostUsd: number;
};

type GroupRow = {
  key: string;
  calls: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  estCostUsd: number;
};

type DayRow = {
  date: string;
  calls: bigint;
  estCostUsd: number;
};

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid ISO date');

function numberOf(value: bigint | number): number {
  return Number(value);
}

function groupJson(row: GroupRow) {
  return {
    key: row.key,
    calls: numberOf(row.calls),
    inputTokens: numberOf(row.inputTokens),
    outputTokens: numberOf(row.outputTokens),
    estCostUsd: row.estCostUsd,
  };
}

export async function tokenUsageRoutes(app: FastifyInstance) {
  const gate = { preHandler: [requireAuth, requireRole('supervisor')] };

  app.get('/api/jupiter/token-usage', gate, async (req, reply) => {
    const parsed = z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
    }).safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
    }

    const now = new Date();
    const from = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = parsed.data.to ? new Date(parsed.data.to) : now;
    if (from > to) return reply.code(400).send({ error: 'invalid_window' });

    const [summaryRows, byAppRows, byFeatureRows, byModelRows, byDayRows] = await Promise.all([
      prisma.$queryRaw<TotalRow[]>`
        SELECT COUNT(*)::bigint AS calls,
               COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
               COALESCE(SUM("cacheReadTokens"), 0)::bigint AS "cacheReadTokens",
               COALESCE(SUM("cacheWriteTokens"), 0)::bigint AS "cacheWriteTokens",
               COALESCE(SUM("estCostUsd"), 0)::double precision AS "estCostUsd"
        FROM "TokenUsage"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}`,
      prisma.$queryRaw<GroupRow[]>`
        SELECT app AS key, COUNT(*)::bigint AS calls,
               COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
               COALESCE(SUM("estCostUsd"), 0)::double precision AS "estCostUsd"
        FROM "TokenUsage"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY app
        ORDER BY "estCostUsd" DESC`,
      prisma.$queryRaw<GroupRow[]>`
        SELECT feature AS key, COUNT(*)::bigint AS calls,
               COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
               COALESCE(SUM("estCostUsd"), 0)::double precision AS "estCostUsd"
        FROM "TokenUsage"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY feature
        ORDER BY "estCostUsd" DESC`,
      prisma.$queryRaw<GroupRow[]>`
        SELECT model AS key, COUNT(*)::bigint AS calls,
               COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
               COALESCE(SUM("estCostUsd"), 0)::double precision AS "estCostUsd"
        FROM "TokenUsage"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY model
        ORDER BY "estCostUsd" DESC`,
      prisma.$queryRaw<DayRow[]>`
        SELECT TO_CHAR("createdAt", 'YYYY-MM-DD') AS date,
               COUNT(*)::bigint AS calls,
               COALESCE(SUM("estCostUsd"), 0)::double precision AS "estCostUsd"
        FROM "TokenUsage"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY TO_CHAR("createdAt", 'YYYY-MM-DD')
        ORDER BY date ASC`,
    ]);

    const summary = summaryRows[0] ?? {
      calls: 0n,
      inputTokens: 0n,
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      estCostUsd: 0,
    };
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        calls: numberOf(summary.calls),
        inputTokens: numberOf(summary.inputTokens),
        outputTokens: numberOf(summary.outputTokens),
        cacheReadTokens: numberOf(summary.cacheReadTokens),
        cacheWriteTokens: numberOf(summary.cacheWriteTokens),
        estCostUsd: summary.estCostUsd,
      },
      byApp: byAppRows.map(groupJson),
      byFeature: byFeatureRows.map(groupJson),
      byModel: byModelRows.map(groupJson),
      byDay: byDayRows.map((row) => ({
        date: row.date,
        calls: numberOf(row.calls),
        estCostUsd: row.estCostUsd,
      })),
    };
  });
}
