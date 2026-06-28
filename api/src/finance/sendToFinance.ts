import { env } from '../env.js';

// POST to the finance Apps Script webhook. Never throws → caller surfaces a clean error.
async function postToSheet(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  if (!env.FINANCE_SHEET_WEBHOOK) return { ok: false, error: 'not_configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(env.FINANCE_SHEET_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.FINANCE_SHEET_SECRET, ...body }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `http_${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface FinancePayload {
  nickname: string;
  realName: string;
  amount: string;
  bank: string;
  transferAt: string;
  ref: string;
  taxInvoice: string; // ใบกำกับภาษี: name / address / tax-ID (free text)
  note: string; // หมายเหตุ
  slipUrl: string;
  sales: string;
}

// The payment row (the finance sheet). The corrected-amount AUDIT does NOT go to any sheet
// (sales could delete it) — it's logged to Minerva's DB and shown only to supervisors.
export function sendToFinance(p: FinancePayload): Promise<{ ok: boolean; error?: string }> {
  return postToSheet({ kind: 'payment', ...p });
}
