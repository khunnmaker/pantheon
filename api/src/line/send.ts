import { getLineClient } from './client.js';
import { env } from '../env.js';

export interface SendResult {
  sent: boolean;
  dryRun: boolean;
  channelMsgId?: string;
}

const dryRunForced = () => env.LINE_DRY_RUN === '1' || env.LINE_DRY_RUN.toLowerCase() === 'true';

// Push a text reply to a customer. Dry-run (log only) when no access token is
// configured OR LINE_DRY_RUN is set — so the approve→send flow is testable
// without messaging real customers.
export async function sendLineText(lineUserId: string, text: string): Promise<SendResult> {
  const c = getLineClient();
  if (!c || dryRunForced()) {
    // Don't log PII: mask the LINE userId and log only the reply length, not text.
    const masked = lineUserId.length > 6 ? `${lineUserId.slice(0, 2)}…${lineUserId.slice(-4)}` : 'U…';
    // eslint-disable-next-line no-console
    console.log(`[LINE DRY-RUN] -> ${masked} (${text.length} chars)`);
    return { sent: false, dryRun: true };
  }
  const res = await c.pushMessage({ to: lineUserId, messages: [{ type: 'text', text }] });
  // pushMessage returns sentMessages[] with ids on success
  const channelMsgId = res?.sentMessages?.[0]?.id;
  return { sent: true, dryRun: false, channelMsgId };
}
