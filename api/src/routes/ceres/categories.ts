import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCeresRole } from '../../ceres/auth.js';
import { prisma } from '../../db/prisma.js';

const trimmedLabel = z.string().trim().min(1).max(100);
const ceiling = z.string().trim().refine(
  (value) => value === '' || (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number(value) >= 0),
  'invalid_ceiling',
);

const createCategoryBody = z.object({
  name: trimmedLabel,
  group: trimmedLabel,
  ceiling: ceiling.optional().default(''),
  needsCustomerNote: z.boolean().optional().default(false),
});

const patchCategoryBody = z.object({
  name: trimmedLabel.optional(),
  group: trimmedLabel.optional(),
  ceiling: ceiling.optional(),
  needsCustomerNote: z.boolean().optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);

const moveCategoryBody = z.object({ direction: z.enum(['up', 'down']) });

function isUniqueError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

export function categoryAdminRoutes(app: FastifyInstance) {
  app.get(
    '/api/ceres/admin/categories',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async () => ({
      categories: await prisma.ceresCategory.findMany({ orderBy: { sortOrder: 'asc' } }),
    }),
  );

  app.post(
    '/api/ceres/admin/categories',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = createCategoryBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const data = parsed.data;

      if (await prisma.ceresCategory.findUnique({ where: { name: data.name }, select: { id: true } })) {
        return reply.code(409).send({ error: 'duplicate_name' });
      }

      const lastInGroup = await prisma.ceresCategory.findFirst({
        where: { group: data.group },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const lastOverall = lastInGroup ? null : await prisma.ceresCategory.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });

      try {
        const category = await prisma.ceresCategory.create({
          data: {
            name: data.name,
            group: data.group,
            ceiling: data.ceiling,
            needsCustomerNote: data.needsCustomerNote,
            sortOrder: (lastInGroup?.sortOrder ?? lastOverall?.sortOrder ?? 0) + 10,
          },
        });
        return reply.code(201).send({ category });
      } catch (error) {
        if (isUniqueError(error)) return reply.code(409).send({ error: 'duplicate_name' });
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/ceres/admin/categories/:id',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = patchCategoryBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const existing = await prisma.ceresCategory.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      if (parsed.data.name && parsed.data.name !== existing.name) {
        const duplicate = await prisma.ceresCategory.findUnique({
          where: { name: parsed.data.name },
          select: { id: true },
        });
        if (duplicate) return reply.code(409).send({ error: 'duplicate_name' });
      }

      if (parsed.data.active === false && existing.active) {
        const activeCount = await prisma.ceresCategory.count({ where: { active: true } });
        if (activeCount <= 1) return reply.code(400).send({ error: 'last_active_category' });
      }

      try {
        const category = await prisma.ceresCategory.update({
          where: { id: existing.id },
          data: parsed.data,
        });
        return { category };
      } catch (error) {
        if (isUniqueError(error)) return reply.code(409).send({ error: 'duplicate_name' });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/ceres/admin/categories/:id/move',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = moveCategoryBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const category = await prisma.$transaction(async (tx) => {
        const current = await tx.ceresCategory.findUnique({ where: { id: req.params.id } });
        if (!current) return null;

        const movingUp = parsed.data.direction === 'up';
        const adjacent = await tx.ceresCategory.findFirst({
          where: {
            group: current.group,
            sortOrder: movingUp ? { lt: current.sortOrder } : { gt: current.sortOrder },
          },
          orderBy: { sortOrder: movingUp ? 'desc' : 'asc' },
        });
        if (!adjacent) return current;

        const currentSortOrder = current.sortOrder;
        const adjacentSortOrder = adjacent.sortOrder;
        await tx.ceresCategory.update({
          where: { id: adjacent.id },
          data: { sortOrder: currentSortOrder },
        });
        return tx.ceresCategory.update({
          where: { id: current.id },
          data: { sortOrder: adjacentSortOrder },
        });
      });

      if (!category) return reply.code(404).send({ error: 'not_found' });
      return { category };
    },
  );
}
