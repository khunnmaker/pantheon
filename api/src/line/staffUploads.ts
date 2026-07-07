import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOAD_DIR, MAX_CONTENT_BYTES } from './contentStore.js';

// Staff-uploaded attachments (photos/files the team sends to a customer) live on
// the persistent volume under staff/<uuid>, with a sidecar <uuid>.json of metadata.
// Served PUBLICLY (LINE fetches images; customers download files) — ids are random
// UUIDs, so the path is unguessable.
const STAFF_DIR = path.join(UPLOAD_DIR, 'staff');

export const UPLOAD_ID_RE = /^[A-Za-z0-9-]+$/;

export interface StaffUploadMeta {
  fileName: string;
  contentType: string;
  kind: 'image' | 'file';
}

// Only these RASTER image types are ever treated as inline-renderable. NOTE the deliberate
// exclusion of image/svg+xml — an SVG is executable markup, so serving one inline is stored XSS
// on the api origin. Anything not on this list (incl. svg) is stored as a downloadable 'file'.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Confirm the bytes really are one of the allowed rasters (magic numbers), so a spoofed
// content-type can't smuggle script-bearing content in under an "image/png" label.
function looksLikeRaster(b: Buffer): boolean {
  if (b.length < 12) return false;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const gif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  const webp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return png || jpg || gif || webp;
}

export async function saveStaffUpload(
  dataB64: string,
  fileName: string,
  contentType: string,
): Promise<{ uploadId: string; kind: 'image' | 'file' } | null> {
  const buf = Buffer.from(dataB64, 'base64');
  if (!buf.length || buf.length > MAX_CONTENT_BYTES) return null;
  // Inline only for an allowlisted raster whose magic bytes match; everything else downloads.
  const kind: 'image' | 'file' = INLINE_IMAGE_TYPES.has(contentType) && looksLikeRaster(buf) ? 'image' : 'file';
  const uploadId = randomUUID();
  await fs.mkdir(STAFF_DIR, { recursive: true });
  await fs.writeFile(path.join(STAFF_DIR, uploadId), buf);
  const meta: StaffUploadMeta = {
    fileName: fileName || 'file',
    contentType: contentType || 'application/octet-stream',
    kind,
  };
  await fs.writeFile(path.join(STAFF_DIR, `${uploadId}.json`), JSON.stringify(meta), 'utf8');
  return { uploadId, kind };
}

export async function readStaffUploadMeta(uploadId: string): Promise<StaffUploadMeta | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(STAFF_DIR, `${uploadId}.json`), 'utf8')) as StaffUploadMeta;
  } catch {
    return null;
  }
}

export async function readStaffUploadFile(uploadId: string): Promise<Buffer | null> {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  try {
    return await fs.readFile(path.join(STAFF_DIR, uploadId));
  } catch {
    return null;
  }
}
