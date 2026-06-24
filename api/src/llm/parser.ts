export type DraftType = 'draft' | 'needs_human' | 'out_of_scope';

export interface DraftResult {
  type: DraftType;
  draft: string;
  used_kb: string[];
  note: string;
}

// Safe default whenever the model output can't be trusted — route to a human.
export const SAFE_DEFAULT: DraftResult = {
  type: 'needs_human',
  draft: '',
  used_kb: [],
  note: 'ตอบอัตโนมัติไม่สำเร็จ — ขอให้เจ้าหน้าที่ตรวจสอบและตอบ',
};

// Strip ```json fences, parse, validate shape. Never throws — falls back to SAFE_DEFAULT.
export function parseDraft(raw: string): DraftResult {
  try {
    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;

    const type = obj.type;
    if (type !== 'draft' && type !== 'needs_human' && type !== 'out_of_scope') {
      return SAFE_DEFAULT;
    }

    const draft = typeof obj.draft === 'string' ? obj.draft : '';
    const note = typeof obj.note === 'string' ? obj.note : '';
    const used_kb = Array.isArray(obj.used_kb)
      ? obj.used_kb.filter((x): x is string => typeof x === 'string')
      : [];

    return { type, draft, used_kb, note };
  } catch {
    return SAFE_DEFAULT;
  }
}
