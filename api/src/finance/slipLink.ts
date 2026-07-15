import crypto from 'node:crypto';
import { env } from '../env.js';

// Stable, unguessable token for the public slip link (so finance can open the slip
// from the Google Sheet without a login). HMAC of the message id + server secret.
export function slipToken(messageId: string): string {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(`slip:${messageId}`).digest('hex').slice(0, 24);
}

// A customer PDF file message treated as a payment slip — bank apps export slips as PDFs
// (owner 2026-07-15), so the แจ้งการเงิน flow accepts them alongside image messages.
// attachmentRef (the content type from the LINE download) is checked first; the filename is
// the fallback for the rare row where the content saved but the ref update raced/failed.
export function isPdfSlip(msg: { attachmentType: string | null; attachmentRef: string | null; attachmentName: string | null }): boolean {
  return (
    msg.attachmentType === 'file' &&
    (msg.attachmentRef === 'application/pdf' || (msg.attachmentName ?? '').toLowerCase().endsWith('.pdf'))
  );
}

// Any customer message that can carry a slip: LINE images (the classic path) or PDF files.
export function isSlipCapable(msg: { attachmentType: string | null; attachmentRef: string | null; attachmentName: string | null }): boolean {
  return msg.attachmentType === 'image' || isPdfSlip(msg);
}

// `pdf` appends a #pdf display hint for Juno's drawer (iframe instead of <img>). A fragment
// is never sent to the server, so the tokenized route and caching are unaffected.
export function buildSlipUrl(base: string, messageId: string, pdf = false): string {
  return `${base}/content/slip/${messageId}?t=${slipToken(messageId)}${pdf ? '#pdf' : ''}`;
}
