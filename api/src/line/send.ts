import { getLineClient } from './client.js';
import { env } from '../env.js';

export interface SendResult {
  sent: boolean;
  dryRun: boolean;
  channelMsgId?: string;
}

type LineOutMessage =
  | { type: 'text'; text: string }
  | { type: 'image'; originalContentUrl: string; previewImageUrl: string };

const dryRunForced = () => env.LINE_DRY_RUN === '1' || env.LINE_DRY_RUN.toLowerCase() === 'true';

// Push one or more messages. Dry-run (log only) when no access token is configured
// OR LINE_DRY_RUN is set — so the approve→send flow is testable without messaging
// real customers. Never logs PII (masks the userId, logs only message kinds).
async function push(lineUserId: string, messages: LineOutMessage[]): Promise<SendResult> {
  const c = getLineClient();
  if (!c || dryRunForced()) {
    const masked = lineUserId.length > 6 ? `${lineUserId.slice(0, 2)}…${lineUserId.slice(-4)}` : 'U…';
    // eslint-disable-next-line no-console
    console.log(`[LINE DRY-RUN] -> ${masked} (${messages.map((m) => m.type).join('+')})`);
    return { sent: false, dryRun: true };
  }
  // @line/bot-sdk Message union — our literals match Text/Image message shapes.
  const res = await c.pushMessage({ to: lineUserId, messages: messages as never });
  const channelMsgId = res?.sentMessages?.[0]?.id;
  return { sent: true, dryRun: false, channelMsgId };
}

export async function sendLineText(lineUserId: string, text: string): Promise<SendResult> {
  return push(lineUserId, [{ type: 'text', text }]);
}

// Image(s) only — no text bubble (LINE rejects empty text). For an instant photo send.
export async function sendLineImages(lineUserId: string, imageUrls: string[]): Promise<SendResult> {
  const messages: LineOutMessage[] = imageUrls.map((url) => ({
    type: 'image',
    originalContentUrl: url,
    previewImageUrl: url,
  }));
  if (!messages.length) return { sent: false, dryRun: true };
  let first: SendResult | undefined;
  for (let i = 0; i < messages.length; i += 5) {
    const res = await push(lineUserId, messages.slice(i, i + 5));
    first ??= res;
  }
  return first as SendResult;
}

// Text reply + optional product photo(s). LINE allows at most 5 messages per push,
// so a text + many images is sent in chunks; returns the first push's result.
export async function sendLineReply(
  lineUserId: string,
  text: string,
  imageUrls: string[] = [],
): Promise<SendResult> {
  const messages: LineOutMessage[] = [{ type: 'text', text }];
  for (const url of imageUrls) {
    messages.push({ type: 'image', originalContentUrl: url, previewImageUrl: url });
  }
  let first: SendResult | undefined;
  for (let i = 0; i < messages.length; i += 5) {
    const res = await push(lineUserId, messages.slice(i, i + 5));
    first ??= res;
  }
  return first as SendResult;
}
