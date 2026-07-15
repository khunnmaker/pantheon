import { env } from '../env.js';
import { sendLineText } from '../line/send.js';

// Push a LINE alert to the CEO when a P2/P3 payment request escalates, so the GM isn't
// blocked for hours waiting on the web UI (CERES_BRIEF §10 Q4). No-op when unconfigured;
// a LINE failure must never affect the request flow (fail-open for notification only —
// the request itself is already correctly gated regardless of whether this send works).
export async function notifyCeoEscalation(
  req: { payee: string; amount: string; entity: string; requestedByName: string },
  reasoning: string,
): Promise<void> {
  // Suite-wide CEO_LINE_USER_ID, with the old Ceres-scoped name as a deprecated fallback.
  const ceoLineUserId = env.CEO_LINE_USER_ID || env.CERES_CEO_LINE_USER_ID;
  if (!ceoLineUserId) return;
  try {
    const text = `⚠️ Ceres รออนุมัติ: ${req.payee} ฿${req.amount} (${req.entity})\nโดย ${req.requestedByName}\n${reasoning}\nเปิด Ceres เพื่ออนุมัติ/ปฏิเสธ`;
    await sendLineText(ceoLineUserId, text);
  } catch {
    // Notification is best-effort only — never let a LINE failure affect the request flow.
  }
}
