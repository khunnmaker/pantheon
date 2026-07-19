import { getAppdentLineClient, getLineClient, getMaliLineClient } from './client.js';
import { env } from '../env.js';

export interface SendResult {
  sent: boolean;
  dryRun: boolean;
  skipped?: boolean;
  skipReason?: 'appdent_token_unset';
  channelMsgId?: string;
  quoteToken?: string; // LINE token to later quote OUR just-sent text/image (enables self-reply)
}

type LineOutMessage =
  | { type: 'text'; text: string; quoteToken?: string }
  | { type: 'image'; originalContentUrl: string; previewImageUrl: string };

const dryRunForced = () => env.LINE_DRY_RUN === '1' || env.LINE_DRY_RUN.toLowerCase() === 'true';

// Push one or more messages. Dry-run (log only) when no access token is configured
// OR LINE_DRY_RUN is set — so the approve→send flow is testable without messaging
// real customers. Logs only structured channel/message kinds, never IDs or bodies.
async function push(
  client: ReturnType<typeof getLineClient>,
  channel: 'prominent' | 'appdent' | 'mali',
  lineUserId: string,
  messages: LineOutMessage[],
  resultIndex = 0,
): Promise<SendResult> {
  if (!client || dryRunForced()) {
    // eslint-disable-next-line no-console
    console.log({ event: 'line_push_dry_run', channel, kind: messages.map((m) => m.type).join('+') });
    return { sent: false, dryRun: true };
  }
  let res;
  try {
    // @line/bot-sdk Message union — our literals match Text/Image message shapes.
    res = await client.pushMessage({ to: lineUserId, messages: messages as never });
  } catch (err) {
    if (channel === 'appdent') {
      // Never attach the SDK error: request metadata can include destination/content.
      // eslint-disable-next-line no-console
      console.error({ event: 'owner_push_failed', kind: messages.map((m) => m.type).join('+'), reason: 'line_api_error' });
    }
    throw err;
  }
  // Pick the LINE message represented by our single DB row. For mixed text+image sends the
  // route renders that row as a picture bubble, so callers select the first image response.
  // (Cast: the installed SDK type predates quoteToken on image responses.)
  const sentMessage = res?.sentMessages?.[resultIndex] as { id?: string; quoteToken?: string } | undefined;
  return { sent: true, dryRun: false, channelMsgId: sentMessage?.id, quoteToken: sentMessage?.quoteToken };
}

// quoteToken (optional): make the customer see a real LINE quote of an earlier message.
export async function sendLineText(
  lineUserId: string,
  text: string,
  quoteToken?: string,
): Promise<SendResult> {
  return push(getLineClient(), 'prominent', lineUserId, [{ type: 'text', text, ...(quoteToken ? { quoteToken } : {}) }]);
}

export async function sendOwnerLineText(
  prominentOwnerUserId: string,
  text: string,
): Promise<SendResult> {
  const client = getAppdentLineClient();
  if (!client) {
    // eslint-disable-next-line no-console
    console.error({ event: 'owner_digest_skipped', kind: 'text', reason: 'appdent_token_unset' });
    return { sent: false, dryRun: false, skipped: true, skipReason: 'appdent_token_unset' };
  }
  const destination = env.APPDENT_OWNER_LINE_USER_ID || prominentOwnerUserId;
  return push(client, 'appdent', destination, [{ type: 'text', text }]);
}

// Mali uses the free webhook reply token first, then falls back to a push on
// the same OA if the token expired while retrieval/LLM work was running.
export async function sendMaliLineText(
  lineUserId: string,
  replyToken: string | undefined,
  text: string,
): Promise<SendResult> {
  const client = getMaliLineClient();
  if (!client || dryRunForced()) {
    // eslint-disable-next-line no-console
    console.log({ event: 'line_reply_dry_run', channel: 'mali', kind: 'text' });
    return { sent: false, dryRun: true };
  }

  if (replyToken) {
    try {
      const res = await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
      const sentMessage = res?.sentMessages?.[0] as { id?: string; quoteToken?: string } | undefined;
      return {
        sent: true,
        dryRun: false,
        channelMsgId: sentMessage?.id,
        quoteToken: sentMessage?.quoteToken,
      };
    } catch {
      // Fall through: LINE reply tokens are short-lived and single-use.
    }
  }

  return push(client, 'mali', lineUserId, [{ type: 'text', text }]);
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
    const res = await push(getLineClient(), 'prominent', lineUserId, messages.slice(i, i + 5));
    first ??= res;
  }
  return first as SendResult;
}

// Text reply + optional product photo(s). LINE allows at most 5 messages per push,
// so a text + many images is sent in chunks. When images exist, return the first image's
// id/token because the corresponding DB row is rendered and later quoted as a picture.
export async function sendLineReply(
  lineUserId: string,
  text: string,
  imageUrls: string[] = [],
  quoteToken?: string,
): Promise<SendResult> {
  const messages: LineOutMessage[] = [{ type: 'text', text, ...(quoteToken ? { quoteToken } : {}) }];
  for (const url of imageUrls) {
    messages.push({ type: 'image', originalContentUrl: url, previewImageUrl: url });
  }
  let first: SendResult | undefined;
  for (let i = 0; i < messages.length; i += 5) {
    const res = await push(getLineClient(), 'prominent', lineUserId, messages.slice(i, i + 5), i === 0 && imageUrls.length ? 1 : 0);
    first ??= res;
  }
  return first as SendResult;
}
