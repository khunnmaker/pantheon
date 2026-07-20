import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Ceres Phase 1 compatibility contract', () => {
  it('keeps the migration additive and legacy requests on workflow v1', async () => {
    const sql = await readFile(
      path.join(apiRoot, 'prisma/migrations/20260726000000_ceres_staff_requests/migration.sql'),
      'utf8',
    );
    expect(sql).toContain('"workflowVersion" INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('"requestType" TEXT NOT NULL DEFAULT \'legacy_payment\'');
    expect(sql).toContain('"approvalStatus" TEXT NOT NULL DEFAULT \'legacy\'');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+"status"/i);
  });

  it('removes manual advance/refund routes while preserving live petty-cash surfaces', async () => {
    const source = await readFile(path.join(apiRoot, 'src/routes/ceres/p1.ts'), 'utf8');
    for (const route of [
      '/api/ceres/receipts', '/api/ceres/expenses', '/api/ceres/movements',
      '/api/ceres/board', '/api/ceres/close',
    ]) expect(source).toContain(route);
    expect(source).not.toContain("'/api/ceres/advances'");
    expect(source).not.toContain("'/api/ceres/refunds'");
    expect(source).toContain('/api/ceres/media');
    expect(source).toContain('negative_box_balance');
  });

  it('uses TEXT-backed request unions and preserves the existing status projection', async () => {
    const schema = await readFile(path.join(apiRoot, 'prisma/schema.prisma'), 'utf8');
    const requestModel = schema.match(/model CeresPaymentRequest \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(requestModel).toContain('status');
    expect(requestModel).toContain('@default("requested")');
    expect(requestModel).toContain('@default("legacy_payment")');
    expect(schema).not.toMatch(/enum Ceres(Request|Approval|Fulfillment|Media)/);
  });

  it('persists OCR server-side and keeps the strict threshold boundary', async () => {
    const [p1, aiReview] = await Promise.all([
      readFile(path.join(apiRoot, 'src/routes/ceres/p1.ts'), 'utf8'),
      readFile(path.join(apiRoot, 'src/ceres/requestService.ts'), 'utf8'),
    ]);
    expect(p1).toContain('saveCeresReceiptOcr(saved.uploadId, ocrFields)');
    expect(p1).toContain("ocrAmount: b.ocrAmount ?? receiptMeta?.ocrAmount ?? ''");
    expect(aiReview).toContain('num(request.amount) > env.CERES_CEO_THRESHOLD');
    expect(aiReview).not.toContain('num(request.amount) >= env.CERES_CEO_THRESHOLD');
  });
});
