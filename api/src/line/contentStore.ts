import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import { fetchMessageContent } from './client.js';

// Images are saved on disk, named by the DB message id; the content-type is kept
// on Message.attachmentRef. (LINE only retains message content briefly, so we
// download it once on receipt rather than proxying live.) In production UPLOAD_DIR
// points at a mounted persistent volume so photos survive redeploys.
export const UPLOAD_DIR = env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');

export async function saveImageContent(
  dbMessageId: string,
  lineMessageId: string,
): Promise<string | null> {
  const content = await fetchMessageContent(lineMessageId);
  if (!content) return null;
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
