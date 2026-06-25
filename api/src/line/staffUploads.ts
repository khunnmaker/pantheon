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

export async function saveStaffUpload(
  dataB64: string,
  fileName: string,
  contentType: string,
): Promise<{ uploadId: string; kind: 'image' | 'file' } | null> {
  const buf = Buffer.from(dataB64, 'base64');
  if (!buf.length || buf.length > MAX_CONTENT_BYTES) return null;
  const kind: 'image' | 'file' = contentType.startsWith('image/') ? 'image' : 'file';
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
