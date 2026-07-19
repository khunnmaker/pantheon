import { messagingApi } from '@line/bot-sdk';
import { env } from '../env.js';

// Lazily create the LINE Messaging API client. Returns null when no access
// token is configured (M1 dev runs without real LINE credentials).
let client: messagingApi.MessagingApiClient | null = null;
let appdentClient: messagingApi.MessagingApiClient | null = null;
let maliClient: messagingApi.MessagingApiClient | null = null;

export function getLineClient(): messagingApi.MessagingApiClient | null {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  if (!client) {
    client = new messagingApi.MessagingApiClient({
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return client;
}

// Separately cached outbound-only client for private owner notifications. This
// must never fall back to the Prominent client when appdent is unconfigured.
export function getAppdentLineClient(): messagingApi.MessagingApiClient | null {
  if (!env.APPDENT_LINE_CHANNEL_ACCESS_TOKEN) return null;
  if (!appdentClient) {
    appdentClient = new messagingApi.MessagingApiClient({
      channelAccessToken: env.APPDENT_LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return appdentClient;
}

// Separately cached client for Mali's staff-only OA. Never fall back to the
// customer channel when the Mali token is unset.
export function getMaliLineClient(): messagingApi.MessagingApiClient | null {
  if (!env.MALI_LINE_CHANNEL_ACCESS_TOKEN) return null;
  if (!maliClient) {
    maliClient = new messagingApi.MessagingApiClient({
      channelAccessToken: env.MALI_LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return maliClient;
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

// Best-effort GROUP name lookup (the OA must be a member). null if no client/name or it fails.
export async function fetchGroupName(groupId: string): Promise<string | null> {
  const c = getLineClient();
  if (!c) return null;
  try {
    const summary = await c.getGroupSummary(groupId);
    return summary.groupName ?? null;
  } catch {
    return null;
  }
}

// Best-effort profile/group picture lookup. 1-on-1 (U…) → getProfile.pictureUrl; group (C…) →
// getGroupSummary.pictureUrl; room (R…) has no picture API → null. null on no client / error.
export async function fetchPictureUrl(lineUserId: string): Promise<string | null> {
  const c = getLineClient();
  if (!c) return null;
  try {
    if (lineUserId.startsWith('C')) {
      const summary = await c.getGroupSummary(lineUserId);
      return summary.pictureUrl ?? null;
    }
    if (lineUserId.startsWith('R')) return null;
    const profile = await c.getProfile(lineUserId);
    return profile.pictureUrl ?? null;
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
