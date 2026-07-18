import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindMany: vi.fn(),
  taskCount: vi.fn(),
  taskFindUnique: vi.fn(),
  eventFindMany: vi.fn(),
  sendLineText: vi.fn(),
  sendOwnerLineText: vi.fn(),
}));

vi.mock('../src/db/prisma.js', () => ({ prisma: {
  agent: { findMany: mocks.agentFindMany },
  apolloTask: { count: mocks.taskCount, findUnique: mocks.taskFindUnique },
  apolloEvent: { findMany: mocks.eventFindMany },
} }));
vi.mock('../src/line/owner.js', () => ({ getProminentOwnerLineUserId: () => 'U-owner-prominent' }));
vi.mock('../src/line/send.js', () => ({
  sendLineText: mocks.sendLineText,
  sendOwnerLineText: mocks.sendOwnerLineText,
}));
vi.mock('../src/apollo/calendarQuery.js', () => ({
  eventDateRangeWhere: vi.fn(() => ({})),
  recurringEventRangeWhere: vi.fn(() => ({})),
}));
vi.mock('../src/apollo/digest.js', () => ({
  APOLLO_URL: 'https://apollo.example.test',
  buildDigestLines: (name: string) => [`digest for ${name}`],
  digestEventsForDay: () => [],
}));

import { notifyApolloAssignment, sendApolloMorningDigests } from '../src/apollo/notify.js';

const agent = (id: string, name: string, lineUserId: string) => ({
  id,
  name,
  lineUserId,
  apolloAssignedTasks: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentFindMany.mockResolvedValue([
    agent('owner-agent', 'Owner', 'U-owner-prominent'),
    agent('staff-agent', 'Staff', 'U-staff'),
  ]);
  mocks.taskCount.mockResolvedValue(0);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.sendLineText.mockResolvedValue({ sent: true, dryRun: false });
  mocks.sendOwnerLineText.mockResolvedValue({ sent: true, dryRun: false });
});

describe('Apollo owner routing', () => {
  it('sends the owner morning digest through appdent and staff through Prominent', async () => {
    await expect(sendApolloMorningDigests()).resolves.toBe(2);
    expect(mocks.sendOwnerLineText).toHaveBeenCalledWith('U-owner-prominent', 'digest for Owner');
    expect(mocks.sendLineText).toHaveBeenCalledWith('U-staff', 'digest for Staff');
  });

  it('continues staff sends and does not count an owner skip', async () => {
    mocks.sendOwnerLineText.mockResolvedValue({
      sent: false,
      dryRun: false,
      skipped: true,
      skipReason: 'appdent_token_unset',
    });
    await expect(sendApolloMorningDigests()).resolves.toBe(1);
    expect(mocks.sendLineText).toHaveBeenCalledWith('U-staff', 'digest for Staff');
  });

  it('continues staff sends and does not count an owner push failure', async () => {
    mocks.sendOwnerLineText.mockRejectedValue(new Error('appdent unavailable'));
    await expect(sendApolloMorningDigests()).resolves.toBe(1);
    expect(mocks.sendLineText).toHaveBeenCalledWith('U-staff', 'digest for Staff');
  });

  it('warns without recipient IDs when no Agent row matches the owner', async () => {
    mocks.agentFindMany.mockResolvedValue([agent('staff-agent', 'Staff', 'U-staff')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sendApolloMorningDigests()).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith({
      event: 'owner_digest_skipped',
      kind: 'apollo_morning',
      reason: 'owner_agent_not_found',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('U-staff');
    warn.mockRestore();
  });

  it('routes owner assignments through appdent and staff assignments through Prominent', async () => {
    const task = (lineUserId: string) => ({
      id: 'task-1',
      title: 'Task',
      dueDate: new Date('2026-07-18T00:00:00.000Z'),
      project: { name: 'Project' },
      assignee: { lineUserId },
    });
    mocks.taskFindUnique.mockResolvedValueOnce(task('U-owner-prominent'));
    await notifyApolloAssignment('task-1');
    expect(mocks.sendOwnerLineText).toHaveBeenCalledOnce();
    expect(mocks.sendLineText).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.taskFindUnique.mockResolvedValueOnce(task('U-staff'));
    await notifyApolloAssignment('task-1');
    expect(mocks.sendLineText).toHaveBeenCalledOnce();
    expect(mocks.sendOwnerLineText).not.toHaveBeenCalled();
  });
});
