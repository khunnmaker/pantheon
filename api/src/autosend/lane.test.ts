import { describe, expect, it } from 'vitest';
import { classifyDraftLane } from './lane.js';

const base = {
  messages: [{ attachmentType: 'image' }],
  imageCaptions: ['ภาพสลิปการโอนเงินจากธนาคาร'],
  draftType: 'draft',
  draftText: 'ได้รับสลิปแล้วค่ะ เดี๋ยวเจ้าหน้าที่ตรวจสอบให้นะคะ',
};

describe('classifyDraftLane', () => {
  it('tags a slip-only image burst', () => expect(classifyDraftLane(base)).toBe('slip_ack'));
  it('rejects a mixed burst', () => expect(classifyDraftLane({
    ...base,
    messages: [{ attachmentType: 'image' }, { attachmentType: null }],
    imageCaptions: ['ภาพสลิปการโอนเงินจากธนาคาร'],
  })).toBeNull());
  it('rejects Arabic digits', () => expect(classifyDraftLane({ ...base, draftText: 'ได้รับยอด 500 บาทค่ะ' })).toBeNull());
  it('rejects Thai digits', () => expect(classifyDraftLane({ ...base, draftText: 'ได้รับยอด ๕๐๐ บาทค่ะ' })).toBeNull());
  it('rejects uncertain image captions', () => expect(classifyDraftLane({ ...base, imageCaptions: ['ภาพหน้าจอโทรศัพท์'] })).toBeNull());
});
