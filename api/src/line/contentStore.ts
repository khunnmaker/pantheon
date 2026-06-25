import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import { fetchMessageContent } from './client.js';

// Images are saved on disk, named by the DB message id; the content-type is kept
// on Message.attachmentRef. (LINE only retains message content briefly, so we
// download it once on receipt rather than proxying live.) In production UPLOAD_DIR
// points at a mounted persistent volume so photos survive redeploys.
export const UPLOAD_DIR = env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');

// Cap on downloaded LINE content so a huge file can't exhaust memory/disk.
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024; // 25 MB

// Download a customer's message content (image/video/audio/file) from LINE and
// store it on disk by DB message id. Returns the content-type, or null if there's
// no content, the fetch failed, or it exceeds the size cap.
export async function saveLineContent(
  dbMessageId: string,
  lineMessageId: string,
): Promise<string | null> {
  const content = await fetchMessageContent(lineMessageId);
  if (!content) return null;
  if (content.buffer.length > MAX_CONTENT_BYTES) return null;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, dbMessageId), content.buffer);
  return content.contentType;
}

export async function readImageContent(dbMessageId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(UPLOAD_DIR, dbMessageId));
  } catch {
    return null;
  }
}
