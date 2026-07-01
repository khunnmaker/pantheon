import type { Customer, Message, Session } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { fetchDisplayName, fetchGroupName } from './client.js';

export interface IngestInput {
  lineUserId: string;
  text: string;
  channelMsgId?: string;
  attachmentType?: string; // image | sticker | video | audio | file | location
  attachmentRef?: string; // image content-type, or "packageId/stickerId" for stickers
}

export interface IngestResult {
  customer: Customer;
  session: Session;
  message: Message;
  isNewCustomer: boolean;
}

// Upsert the customer, attach to an open session, and store the inbound text.
// NB: never sends a reply — drafting/sending is M2.
export async function ingestCustomerText(input: IngestInput): Promise<IngestResult> {
  const { lineUserId, text, channelMsgId, attachmentType, attachmentRef } = input;

  let customer = await prisma.customer.findUnique({ where: { lineUserId } });
  const isNewCustomer = !customer;

  if (!customer) {
    // Group/room conversations are keyed by their C…/R… id (not a user id): fetch the group
    // name for those (fall back to a label); 1-on-1s use the sender's profile name.
    const displayName = lineUserId.startsWith('C')
      ? ((await fetchGroupName(lineUserId)) ?? 'กลุ่มลูกค้า')
      : lineUserId.startsWith('R')
        ? 'ห้องแชท'
        : ((await fetchDisplayName(lineUserId)) ?? undefined);
    customer = await prisma.customer.create({
      data: { lineUserId, displayName: displayName ?? undefined },
    });
  } else {
    // A new message reactivates a previously-ended chat (returns to the queue).
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: { lastSeen: new Date(), active: true },
    });
  }

  // Reuse the customer's open session, or start a new one. (Idle-based session
  // end + summary lands in M3.)
  let session = await prisma.session.findFirst({
    where: { customerId: customer.id, status: 'open' },
    orderBy: { startedAt: 'desc' },
  });
  if (!session) {
    session = await prisma.session.create({ data: { customerId: customer.id } });
  }

  const message = await prisma.message.create({
    data: {
      customerId: customer.id,
      sessionId: session.id,
      role: 'customer',
      text,
      channelMsgId,
      attachmentType,
      attachmentRef,
    },
  });

  return { customer, session, message, isNewCustomer };
}
