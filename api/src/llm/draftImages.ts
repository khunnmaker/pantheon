export interface BurstImageMessage {
  id: string;
  text: string;
  attachmentType: string | null;
  attachmentRef: string | null;
}

export interface AttachedDraftImage {
  messageId: string;
  base64: string;
  mediaType: string;
}

export function renderBurstQuestion(messages: Pick<BurstImageMessage, 'text'>[], fallbackText: string): string {
  return messages.length > 1
    ? messages.map((message, index) => `${index + 1}. ${message.text}`).join('\n')
    : fallbackText;
}

// Read every image in the unanswered burst, then keep the most recent eligible
// images while preserving oldest-first order for the model.
export async function collectBurstImages(
  messages: BurstImageMessage[],
  readContent: (messageId: string) => Promise<Buffer | null>,
  maxImages: number,
  maxBytes: number,
): Promise<AttachedDraftImage[]> {
  const imageRows = messages.filter((message) => message.attachmentType === 'image');
  const read = await Promise.all(imageRows.map(async (message) => ({ message, buffer: await readContent(message.id) })));
  return read
    .filter((item): item is { message: BurstImageMessage; buffer: Buffer } =>
      !!item.buffer && item.buffer.length <= maxBytes)
    .slice(-maxImages)
    .map(({ message, buffer }) => ({
      messageId: message.id,
      base64: buffer.toString('base64'),
      mediaType: message.attachmentRef || 'image/jpeg',
    }));
}
