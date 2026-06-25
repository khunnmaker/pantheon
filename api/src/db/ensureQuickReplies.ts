import { prisma } from './prisma.js';
import { QUICK_REPLIES } from '../quickReplies/quickReplyData.js';

// Seed the starter quick-reply templates on first boot (empty table only), like
// ensureSeeded. The team edits them in the console afterwards — never clobbered.
export async function ensureQuickReplies(): Promise<void> {
  try {
    if (!QUICK_REPLIES.length) return;
    if ((await prisma.quickReply.count()) > 0) return;
    await prisma.quickReply.createMany({
      data: QUICK_REPLIES.map((q, i) => ({ label: q.label, body: q.body, sortOrder: i })),
    });
    // eslint-disable-next-line no-console
    console.log(`[quickReplies] seeded ${QUICK_REPLIES.length} templates`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[quickReplies] seed failed', err);
  }
}
