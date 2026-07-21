import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), executeRaw: vi.fn() }));

vi.mock('../env.js', () => ({ env: { VOYAGE_API_KEY: '' } }));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
    tokenUsage: { create: vi.fn() },
  },
}));

import { retrieveRelevantKnowledge } from './embeddings.js';

function renderSqlPart(value: unknown): string {
  if (!value || typeof value !== 'object') return '?';
  const sql = value as { strings?: readonly string[]; values?: readonly unknown[] };
  if (!sql.strings || !sql.values) return '?';
  return sql.strings.map((part, index) => part + (index < sql.values!.length ? renderSqlPart(sql.values![index]) : '')).join('');
}

function renderedQuery(): string {
  const [strings, ...values] = mocks.queryRaw.mock.calls[0] as [readonly string[], ...unknown[]];
  return strings.map((part, index) => part + (index < values.length ? renderSqlPart(values[index]) : '')).join('');
}

describe('retrieveRelevantKnowledge SQL scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([]);
  });

  it('puts staff audience and LINE exposure restrictions inside the retrieval SQL', async () => {
    await retrieveRelevantKnowledge([0.1], 'staff', 'line', 6);

    const sql = renderedQuery();
    expect(sql).toContain("ka.audience = 'everyone'");
    expect(sql).not.toContain('gm_plus');
    expect(sql).toContain('ka."lineExposable" = true');
    expect(sql).toContain("ka.status = 'published'");
  });

  it('does not restrict the audience for supervisor retrieval', async () => {
    await retrieveRelevantKnowledge([0.1], 'supervisor', 'web', 6);

    const sql = renderedQuery();
    expect(sql).not.toContain('AND ka.audience');
    expect(sql).not.toContain('AND ka."lineExposable"');
  });

  it.each(['gm', 'central'] as const)('allows everyone and gm_plus for %s retrieval', async (role) => {
    await retrieveRelevantKnowledge([0.1], role, 'web', 6);

    const sql = renderedQuery();
    expect(sql).toContain("ka.audience IN ('everyone', 'gm_plus')");
    expect(sql).not.toContain("ka.audience = 'supervisor'");
    expect(sql).not.toContain('AND ka."lineExposable"');
  });

  it('adds LINE exposure restriction to gm_plus-capable retrieval', async () => {
    await retrieveRelevantKnowledge([0.1], 'gm', 'line', 6);

    const sql = renderedQuery();
    expect(sql).toContain("ka.audience IN ('everyone', 'gm_plus')");
    expect(sql).toContain('ka."lineExposable" = true');
  });
});
