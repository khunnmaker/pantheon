import { validateSignature } from '@line/bot-sdk';
import { env } from '../env.js';

// Verify LINE's X-Line-Signature (HMAC-SHA256 of the raw body with the channel
// secret). Returns false if the secret/signature is missing — fail closed.
export function verifyLineSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  channelSecret: string = env.LINE_CHANNEL_SECRET,
): boolean {
  if (!signature || !channelSecret) return false;
  try {
    return validateSignature(rawBody, channelSecret, signature);
  } catch {
    return false;
  }
}
