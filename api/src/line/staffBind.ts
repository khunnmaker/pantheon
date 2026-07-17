import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { sendLineText } from './send.js';

const BIND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STAFF_BIND_RE = /^(APOLLO|CERES)-([A-Z0-9]{8})$/;

export type StaffBindForm = 'apollo' | 'ceres';

export function parseStaffBindCommand(text: string): { form: StaffBindForm; code: string } | null {
  const match = STAFF_BIND_RE.exec(text);
  if (!match) return null;
  return { form: match[1] === 'APOLLO' ? 'apollo' : 'ceres', code: match[2] };
}

export async function staffLineBindStatus(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { lineUserId: true, lineBindCode: true },
  });
  return { bound: !!agent?.lineUserId, code: agent?.lineBindCode ?? null };
}

export async function createStaffLineBindCode(agentId: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = Array.from(randomBytes(8), (byte) => BIND_ALPHABET[byte % BIND_ALPHABET.length]).join('');
    try {
      await prisma.agent.update({ where: { id: agentId }, data: { lineBindCode: code } });
      return { bound: false, code };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    }
  }
  throw new Error('unable_to_generate_line_bind_code');
}

// Returns false for ordinary customer text so the webhook can continue through its
// unchanged ingestion path. Binding is deliberately restricted by the caller to a
// one-to-one LINE user event.
export async function handleStaffBindCommand(text: string, lineUserId: string): Promise<boolean> {
  const bind = parseStaffBindCommand(text);
  if (!bind) return false;

  const agent = await prisma.agent.findUnique({
    where: { lineBindCode: bind.code },
    select: { id: true, name: true },
  });
  const already = await prisma.agent.findUnique({ where: { lineUserId }, select: { id: true } });
  if (!agent) {
    await sendLineText(lineUserId, 'รหัสผูก LINE ไม่ถูกต้องหรือหมดอายุแล้ว');
  } else if (already && already.id !== agent.id) {
    await sendLineText(lineUserId, 'LINE นี้ผูกกับบัญชีพนักงานอื่นแล้ว กรุณาติดต่อหัวหน้า');
  } else {
    await prisma.agent.update({ where: { id: agent.id }, data: { lineUserId, lineBindCode: null } });
    await sendLineText(lineUserId, `ผูก LINE กับบัญชีพนักงานสำเร็จแล้ว (${agent.name})`);
  }
  return true;
}
