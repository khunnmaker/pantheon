import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireApp, requireAuth, requireRole } from '../auth/middleware.js';
import type { Role } from '../auth/jwt.js';
import { prisma } from '../db/prisma.js';
import {
  deleteKnowledgeEmbedding,
  embedKnowledgeArticle,
  knowledgeArticleEmbeddingText,
} from '../memory/embeddings.js';

const audienceSchema = z.enum(['everyone', 'gm_plus', 'supervisor']);
const articleStatusSchema = z.enum(['draft', 'published', 'archived']);
const articleSourceSchema = z.enum(['seed', 'distilled', 'manual']);

const createArticleBody = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(100_000),
  departmentId: z.string().trim().min(1).max(100),
  audience: audienceSchema.default('everyone'),
  lineExposable: z.boolean().optional(),
  status: articleStatusSchema.default('draft'),
  source: articleSourceSchema.default('manual'),
  sourceQuestionId: z.string().trim().min(1).max(100).nullable().optional(),
});
const updateArticleBody = createArticleBody.partial();

const departmentBody = z.object({
  code: z.string().trim().min(1).max(50),
  nameTh: z.string().trim().min(1).max(200),
  answererAgentIds: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});

function audienceWhere(role: Role) {
  if (role === 'supervisor') return {};
  if (role === 'gm' || role === 'agm') return { audience: { in: ['everyone', 'gm_plus'] } };
  return { audience: 'everyone' };
}

export async function maliRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth);
  app.addHook('onRequest', requireApp('mali'));
  const supervisorOnly = { preHandler: [requireRole('supervisor')] };

  app.get('/api/mali/articles', async (req) => {
    const includeArchived = req.agent!.role === 'supervisor' && (req.query as { all?: string }).all === '1';
    const statusWhere = req.agent!.role === 'supervisor'
      ? includeArchived ? {} : { status: { not: 'archived' } }
      : { status: 'published' };
    const articles = await prisma.knowledgeArticle.findMany({
      where: { ...audienceWhere(req.agent!.role), ...statusWhere },
      orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }],
    });
    return { articles };
  });

  app.post('/api/mali/articles', supervisorOnly, async (req, reply) => {
    const parsed = createArticleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const { lineExposable, ...data } = parsed.data;
    const article = await prisma.knowledgeArticle.create({
      data: {
        ...data,
        sourceQuestionId: data.sourceQuestionId ?? null,
        lineExposable: lineExposable ?? data.audience !== 'supervisor',
        authorAgentId: req.agent!.id,
      },
    });
    if (article.status === 'published') {
      await embedKnowledgeArticle(article.id, knowledgeArticleEmbeddingText(article));
    }
    return reply.code(201).send({ article });
  });

  app.put<{ Params: { id: string } }>('/api/mali/articles/:id', supervisorOnly, async (req, reply) => {
    const parsed = updateArticleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const existing = await prisma.knowledgeArticle.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const data = {
      ...parsed.data,
      ...(parsed.data.sourceQuestionId === undefined ? {} : { sourceQuestionId: parsed.data.sourceQuestionId }),
      ...(parsed.data.audience === 'supervisor' && parsed.data.lineExposable === undefined
        ? { lineExposable: false }
        : {}),
    };
    const article = await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data });
    if (article.status === 'published') {
      await embedKnowledgeArticle(article.id, knowledgeArticleEmbeddingText(article));
    } else if (article.status === 'archived') {
      await deleteKnowledgeEmbedding(article.id);
    }
    return { article };
  });

  app.delete<{ Params: { id: string } }>('/api/mali/articles/:id', supervisorOnly, async (req, reply) => {
    const existing = await prisma.knowledgeArticle.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const article = await prisma.knowledgeArticle.update({
      where: { id: req.params.id },
      data: { status: 'archived' },
    });
    await deleteKnowledgeEmbedding(article.id);
    return { article };
  });

  app.get('/api/mali/departments', supervisorOnly, async () => ({
    departments: await prisma.knowledgeDepartment.findMany({ orderBy: [{ code: 'asc' }] }),
  }));

  app.post('/api/mali/departments', supervisorOnly, async (req, reply) => {
    const parsed = departmentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const department = await prisma.knowledgeDepartment.create({ data: parsed.data });
    return reply.code(201).send({ department });
  });

  app.put<{ Params: { id: string } }>('/api/mali/departments/:id', supervisorOnly, async (req, reply) => {
    const parsed = departmentBody.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const existing = await prisma.knowledgeDepartment.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    return { department: await prisma.knowledgeDepartment.update({ where: { id: req.params.id }, data: parsed.data }) };
  });

  app.delete<{ Params: { id: string } }>('/api/mali/departments/:id', supervisorOnly, async (req, reply) => {
    const existing = await prisma.knowledgeDepartment.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const [articles, questions] = await Promise.all([
      prisma.knowledgeArticle.count({ where: { departmentId: req.params.id } }),
      prisma.knowledgeQuestion.count({ where: { departmentId: req.params.id } }),
    ]);
    if (articles || questions) return reply.code(409).send({ error: 'department_in_use' });
    await prisma.knowledgeDepartment.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get('/api/mali/questions', supervisorOnly, async (req) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 100;
    return {
      questions: await prisma.knowledgeQuestion.findMany({ orderBy: { askedAt: 'desc' }, take: limit }),
    };
  });
}
