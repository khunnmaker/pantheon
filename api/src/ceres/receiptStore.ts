import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { UPLOAD_DIR, MAX_CONTENT_BYTES } from '../line/contentStore.js';

// Ceres receipt photos (messenger phone uploads) live on the persistent volume
// under ceres/<uuid>, with a sidecar <uuid>.json of metadata — same pattern as
// line/staffUploads.ts, but images-only and with a sha256 for duplicate detection
// (the same receipt photo re-submitted twice should be catchable — see CeresExpense.receiptSha).
const CERES_DIR = path.join(UPLOAD_DIR, 'ceres');

export const UPLOAD_ID_RE = /^[A-Za-z0-9-]+$/;

export interface CeresReceiptMeta {
  contentType: string;
  sha256: string;
}

// Save a receipt photo. Only image/* is accepted (receipts are phone-camera
// photos, never arbitrary files); size capped at MAX_CONTENT_BYTES like every
// other upload path. Returns null on any validation failure.
export async function saveCeresReceipt(
  dataB64: string,
  contentType: string,
): Promise<{ uploadId: string; sha256: string } | null> {
  if (!contentType || !contentType.startsWith('image/')) return null;
  const buf = Buffer.from(dataB64, 'base64');
  if (!buf.length || buf.length > MAX_CONTENT_BYTES) return null;

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const uploadId = randomUUID();
  await fs.mkdir(CERES_DIR, { recursive: true });
  await fs.writeFile(path.join(CERES_DIR, uploadId), buf);
  const meta: CeresReceiptMeta = { contentType, sha256 };
  await fs.writeFile(path.join(CERES_DIR, `${uploadId}.json`), JSON.stringify(meta), 'utf8');
  return { uploadId, sha256 };
}

export async function readCeresReceiptMeta(uploadId: string): Promise<CeresReceiptMeta | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(CERES_DIR, `${uploadId}.json`), 'utf8')) as CeresReceiptMeta;
  } catch {
    return null;
  }
}

export async function readCeresReceiptFile(uploadId: string): Promise<Buffer | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  try {
    return await fs.readFile(path.join(CERES_DIR, uploadId));
  } catch {
    return null;
  }
}
