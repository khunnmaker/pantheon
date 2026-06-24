import { messagingApi } from '@line/bot-sdk';
import { env } from '../env.js';

// Lazily create the LINE Messaging API client. Returns null when no access
// token is configured (M1 dev runs without real LINE credentials).
let client: messagingApi.MessagingApiClient | null = null;

export function getLineClient(): messagingApi.MessagingApiClient | null {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  if (!client) {
    client = new messagingApi.MessagingApiClient({
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return client;
}

// Best-effort display-name lookup; null if no client or the call fails.
export async function fetchDisplayName(lineUserId: string): Promise<string | null> {
  const c = getLineClient();
  if (!c) return null;
  try {
    const profile = await c.getProfile(lineUserId);
    return profile.displayName ?? null;
  } catch {
    return null;
  }
}

// Download the binary content of an image/file message via the LINE content API.
// Returns null if no token or the fetch fails.
export async function fetchMessageContent(
  lineMessageId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${lineMessageId}/content`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') || 'application/octet-stream' };
  } catch {
    return null;
  }
}
