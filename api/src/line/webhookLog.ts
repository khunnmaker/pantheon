// TEMPORARY debug capture — records recent raw webhook payloads so we can verify
// whether LINE delivers operator-sent (OA Manager) messages to our webhook.
// REMOVE after the test (along with the /api/debug/webhooks route).
interface WebhookRecord {
  at: string;
  validSig: boolean;
  body: string;
}

const buffer: WebhookRecord[] = [];
const MAX = 40;

export function recordWebhook(validSig: boolean, body: string): void {
  buffer.unshift({ at: new Date().toISOString(), validSig, body: body.slice(0, 4000) });
  if (buffer.length > MAX) buffer.length = MAX;
}

export function getRecentWebhooks(): WebhookRecord[] {
  return buffer;
}
