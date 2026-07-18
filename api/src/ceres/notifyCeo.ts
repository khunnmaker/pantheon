import { getProminentOwnerLineUserId } from '../line/owner.js';
import { sendOwnerLineText } from '../line/send.js';

// Push a LINE alert to the CEO when a P2/P3 payment request escalates, so the GM isn't
// blocked for hours waiting on the web UI (CERES_BRIEF §10 Q4). No-op when unconfigured;
// a LINE failure must never affect the request flow (fail-open for notification only —
// the request itself is already correctly gated regardless of whether this send works).
export async function notifyCeoEscalation(
  req: { payee: string; amount: string; entity: string; requestedByName: string },
  reasoning: string,
): Promise<void> {
  const ceoLineUserId = getProminentOwnerLineUserId();
  if (!ceoLineUserId) {
    // eslint-disable-next-line no-console
    console.error({ event: 'owner_digest_skipped', kind: 'ceres_escalation', reason: 'owner_id_unset' });
    return;
  }
  try {
    const text = `⚠️ Ceres รออนุมัติ: ${req.payee} ฿${req.amount} (${req.entity})\nโดย ${req.requestedByName}\n${reasoning}\nเปิด Ceres เพื่ออนุมัติ/ปฏิเสธ`;
    const result = await sendOwnerLineText(ceoLineUserId, text);
    if (result.skipped) {
      // eslint-disable-next-line no-console
      console.error({ event: 'owner_digest_skipped', kind: 'ceres_escalation', reason: result.skipReason });
    }
  } catch {
    // eslint-disable-next-line no-console
    console.error({ event: 'owner_push_failed', kind: 'ceres_escalation', reason: 'line_api_error' });
    // Notification is best-effort only — never let a LINE failure affect the request flow.
  }
}
