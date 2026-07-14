import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOAD_DIR, MAX_CONTENT_BYTES } from '../line/contentStore.js';

const APOLLO_DIR = path.join(UPLOAD_DIR, 'apollo');
const UPLOAD_ID_RE = /^[A-Za-z0-9-]+$/;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function looksLikeRaster(b: Buffer): boolean {
  if (b.length < 12) return false;
  return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    || (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50);
}

export async function saveApolloAttachment(dataB64: string, contentType: string) {
  const maxB64 = Math.ceil((MAX_CONTENT_BYTES * 4) / 3) + 4;
  if (!dataB64 || dataB64.length > maxB64) return null;
  const buffer = Buffer.from(dataB64, 'base64');
  if (!buffer.length || buffer.length > MAX_CONTENT_BYTES) return null;
  const uploadId = randomUUID();
  await fs.mkdir(APOLLO_DIR, { recursive: true });
  await fs.writeFile(path.join(APOLLO_DIR, uploadId), buffer);
  const kind = INLINE_IMAGE_TYPES.has(contentType) && looksLikeRaster(buffer) ? 'image' : 'file';
  return { uploadId, kind, size: buffer.length };
}

export async function readApolloAttachment(uploadId: string): Promise<Buffer | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  try { return await fs.readFile(path.join(APOLLO_DIR, uploadId)); } catch { return null; }
}

export async function deleteApolloAttachment(uploadId: string): Promise<void> {
  if (!UPLOAD_ID_RE.test(uploadId)) return;
  await fs.unlink(path.join(APOLLO_DIR, uploadId)).catch(() => undefined);
}
