export const SLIP_ACK_LANE = 'slip_ack';
const DIGIT_RE = /[0-9๐-๙]/u;
const SLIP_CAPTION_RE = /(สลิป|หลักฐานการโอน|payment\s*slip|bank\s*transfer|transfer\s*slip)/iu;

export type LaneMessage = { attachmentType: string | null };

export function containsAnyDigit(text: string): boolean {
  return DIGIT_RE.test(text);
}

// A lane is assigned only when every unanswered item is an image, every image was explicitly
// captioned as a payment slip by the existing vision pass, and the final answer is sendable/safe.
export function classifyDraftLane(input: {
  messages: LaneMessage[];
  imageCaptions: string[];
  draftType: string;
  draftText: string;
}): string | null {
  if (input.draftType !== 'draft' || !input.draftText.trim() || containsAnyDigit(input.draftText)) return null;
  if (input.messages.length === 0 || !input.messages.every((message) => message.attachmentType === 'image')) return null;
  if (input.imageCaptions.length !== input.messages.length) return null;
  if (!input.imageCaptions.every((caption) => SLIP_CAPTION_RE.test(caption))) return null;
  return SLIP_ACK_LANE;
}
