import { validateSignature } from '@line/bot-sdk';
import { env } from '../env.js';

// Verify LINE's X-Line-Signature (HMAC-SHA256 of the raw body with the channel
// secret). Returns false if the secret/signature is missing — fail closed.
export function verifyLineSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
): boolean {
  if (!signature || !env.LINE_CHANNEL_SECRET) return false;
  try {
    return validateSignature(rawBody, env.LINE_CHANNEL_SECRET, signature);
  } catch {
    return false;
  }
}
