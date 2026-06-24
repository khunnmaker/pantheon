import type { Customer, Message, Session } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { fetchDisplayName } from './client.js';

export interface IngestInput {
  lineUserId: string;
  text: string;
  channelMsgId?: string;
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
  const { lineUserId, text, channelMsgId } = input;

  let customer = await prisma.customer.findUnique({ where: { lineUserId } });
  const isNewCustomer = !customer;

  if (!customer) {
    const displayName = await fetchDisplayName(lineUserId);
    customer = await prisma.customer.create({
      data: { lineUserId, displayName: displayName ?? undefined },
    });
  } else {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: { lastSeen: new Date() },
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
    },
  });

  return { customer, session, message, isNewCustomer };
}
