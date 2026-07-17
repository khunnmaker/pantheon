import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), sendLineText: vi.fn() }));

vi.mock('../src/db/prisma.js', () => ({
  prisma: { agent: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock('../src/line/send.js', () => ({ sendLineText: mocks.sendLineText }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: any) => {
    req.agent = { id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'employee', apps: ['ceres'], authVersion: 0 };
  },
}));

import { handleStaffBindCommand, parseStaffBindCommand } from '../src/line/staffBind.js';
import { staffLineRoutes } from '../src/routes/staffLine.js';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({ id: 'staff-1' });
  mocks.sendLineText.mockResolvedValue(undefined);
});

describe('suite staff LINE binding', () => {
  it('accepts both the preserved Apollo command and the suite/Ceres command', async () => {
    expect(parseStaffBindCommand('APOLLO-ABCDEFGH')).toEqual({ form: 'apollo', code: 'ABCDEFGH' });
    expect(parseStaffBindCommand('CERES-23456789')).toEqual({ form: 'ceres', code: '23456789' });
    expect(parseStaffBindCommand('CERES-ABCDEFG')).toBeNull();

    for (const command of ['APOLLO-ABCDEFGH', 'CERES-23456789']) {
      mocks.findUnique.mockResolvedValueOnce({ id: 'staff-1', name: 'Staff' }).mockResolvedValueOnce(null);
      await expect(handleStaffBindCommand(command, 'U-line')).resolves.toBe(true);
    }
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: 'staff-1' }, data: { lineUserId: 'U-line', lineBindCode: null },
    });
  });

  it('serves GET/POST at the suite route and keeps Apollo endpoints as shared aliases', async () => {
    const app = Fastify();
    await app.register(staffLineRoutes);
    mocks.findUnique.mockResolvedValue({ lineUserId: null, lineBindCode: 'ABCDEFGH' });
    expect((await app.inject({ method: 'GET', url: '/api/staff/line-bind' })).json())
      .toEqual({ bound: false, code: 'ABCDEFGH' });
    mocks.update.mockResolvedValue({ id: 'staff-1' });
    const posted = await app.inject({ method: 'POST', url: '/api/staff/line-bind' });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({ bound: false, code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/) });
    await app.close();

    const apolloSource = await readFile(path.join(apiRoot, 'src/routes/apollo.ts'), 'utf8');
    expect(apolloSource).toContain("'/api/apollo/line-bind'");
    expect(apolloSource).toContain('staffLineBindStatus(req.agent!.id)');
    expect(apolloSource).toContain('createStaffLineBindCode(req.agent!.id)');
  });

  it('falls through without replying for ordinary or hostile text', async () => {
    await expect(handleStaffBindCommand('hello', 'U-line')).resolves.toBe(false);
    await expect(handleStaffBindCommand(`CERES-${'A'.repeat(100_000)}\n<script>alert(1)</script>`, 'U-line'))
      .resolves.toBe(false);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.sendLineText).not.toHaveBeenCalled();
  });

  it('consumes a valid-shaped unknown code and sends the existing error reply', async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(handleStaffBindCommand('CERES-ABCDEFGH', 'U-line')).resolves.toBe(true);
    expect(mocks.sendLineText).toHaveBeenCalledTimes(1);
    expect(mocks.sendLineText).toHaveBeenCalledWith('U-line', expect.any(String));
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
