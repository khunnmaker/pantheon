import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { readStaffUploadFile, readStaffUploadMeta } from '../line/staffUploads.js';
import { callClaudeWithImage, llmAvailable } from './anthropic.js';

export interface CaptionStaffUploadDeps {
  available: () => boolean;
  readMeta: typeof readStaffUploadMeta;
  readFile: typeof readStaffUploadFile;
  maxBytes: number;
  describe: (image: { base64: string; mediaType: string }) => Promise<string>;
  update: (messageId: string, aiCaption: string) => Promise<unknown>;
}

const defaultDeps: CaptionStaffUploadDeps = {
  available: llmAvailable,
  readMeta: readStaffUploadMeta,
  readFile: readStaffUploadFile,
  maxBytes: env.DRAFT_IMAGE_MAX_BYTES,
  describe: (image) => callClaudeWithImage(
    'บรรยายภาพนี้เป็นภาษาไทยหนึ่งประโยคสั้น ๆ โดยระบุชื่อสินค้า เอกสาร หรือสิ่งที่มองเห็นให้ชัดเจนและเป็นรูปธรรม',
    'ตอบเฉพาะคำบรรยายภาพภาษาไทยหนึ่งประโยค ไม่ต้องมีคำนำหรือเครื่องหมายคำพูด',
    image,
    120,
  ),
  update: (messageId, aiCaption) => prisma.message.update({ where: { id: messageId }, data: { aiCaption } }),
};

export async function captionStaffUpload(
  messageId: string,
  uploadId: string,
  deps: CaptionStaffUploadDeps = defaultDeps,
): Promise<void> {
  try {
    if (!deps.available()) return;
    const meta = await deps.readMeta(uploadId);
    if (!meta || meta.kind !== 'image') return;
    const bytes = await deps.readFile(uploadId);
    if (!bytes?.length || bytes.length > deps.maxBytes) return;
    const caption = (await deps.describe({
      base64: bytes.toString('base64'),
      mediaType: meta.contentType,
    })).trim().slice(0, 200);
    if (caption) await deps.update(messageId, caption);
  } catch {
    // Staff sends already succeeded; captioning is best-effort only.
  }
}
