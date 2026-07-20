import crypto from 'node:crypto';
import { env } from '../env.js';

export const CERES_MEDIA_URL_TTL_SECONDS = 10 * 60;
export const CERES_EMBEDDED_MEDIA_URL_TTL_SECONDS = 60 * 60;

function hmac(value: string): string {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(value).digest('hex').slice(0, 32);
}

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The signature binds upload id + expiry. Changing either invalidates the URL.
export function ceresReceiptToken(uploadId: string, expiresAt: number): string {
  return hmac(`ceres-receipt:${uploadId}:${expiresAt}`);
}

export function ceresReceiptExpiry(nowMs = Date.now(), ttlSeconds = CERES_MEDIA_URL_TTL_SECONDS): number {
  return Math.floor(nowMs / 1000) + ttlSeconds;
}

export function ceresReceiptUrl(
  base: string,
  uploadId: string,
  nowMs = Date.now(),
  ttlSeconds = CERES_MEDIA_URL_TTL_SECONDS,
): string {
  const expires = ceresReceiptExpiry(nowMs, ttlSeconds);
  return `${base}/content/ceres-receipt/${uploadId}?expires=${expires}&t=${ceresReceiptToken(uploadId, expires)}`;
}

export function verifyCeresReceiptToken(
  uploadId: string,
  token: string | undefined,
  expiresRaw: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!token) return false;
  if (expiresRaw) {
    if (!/^\d+$/.test(expiresRaw)) return false;
    const expires = Number(expiresRaw);
    if (!Number.isSafeInteger(expires) || expires <= Math.floor(nowMs / 1000)) return false;
    return safeEqual(token, ceresReceiptToken(uploadId, expires));
  }

  return false;
}
