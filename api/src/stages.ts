// Sales-pipeline stages. The AI suggests one from the conversation; staff confirm.
// Order matters for display; not enforced as a strict sequence (a repeat customer can
// jump straight to สั่งซื้อ). "ปิด" = closed/won (sale complete), "ยกเลิก" = lost/abandoned.
export const STAGES = ['ถาม', 'สั่งซื้อ', 'ส่ง', 'ดูแล', 'ปิด', 'ยกเลิก'] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(s: unknown): s is Stage {
  return typeof s === 'string' && (STAGES as readonly string[]).includes(s);
}
