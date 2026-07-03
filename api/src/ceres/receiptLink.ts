import crypto from 'node:crypto';
import { env } from '../env.js';

// Stable, unguessable token for the public receipt link (mirrors finance/slipLink.ts) —
// so a messenger's receipt photo can be fetched by uploadId without a login, but only
// with the right token. HMAC of the upload id + server secret.
export function ceresReceiptToken(uploadId: string): string {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(`ceres-receipt:${uploadId}`).digest('hex').slice(0, 32);
}

export function ceresReceiptUrl(base: string, uploadId: string): string {
  return `${base}/content/ceres-receipt/${uploadId}?t=${ceresReceiptToken(uploadId)}`;
}
