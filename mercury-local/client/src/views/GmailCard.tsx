import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Mail, MailCheck, Link2, Unlink, Info } from 'lucide-react';
import {
  getGmailStatus,
  connectGmail,
  disconnectGmail,
  type GmailStatus,
} from '../lib/api';

// Gmail connection card. Shows whether Gmail is connected (a refresh token is stored locally) and
// which account authorized. "เชื่อม Gmail" runs the loopback OAuth flow server-side (opens the
// browser to Google consent). Fails gracefully when no OAuth client JSON has been dropped in.
export default function GmailCard() {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');

  async function load() {
    try {
      const { status } = await getGmailStatus();
      setStatus(status);
    } catch {
      setError('โหลดสถานะ Gmail ไม่สำเร็จ');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function doConnect() {
    setBusy('connect');
    setError('');
    setHint('เปิดหน้าต่างยินยอมของ Google แล้ว — เข้าสู่ระบบด้วยบัญชี ' + (status?.authAccountHint ?? '') + ' แล้วอนุญาต');
    try {
      await connectGmail();
      setHint('');
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'เชื่อม Gmail ไม่สำเร็จ';
      // Distinguish "no client file" from other errors for a clearer nudge.
      if (/OAuth client not configured/i.test(msg)) {
        setError('ยังไม่ได้วางไฟล์ gmail-oauth-client.json — ดูขั้นตอนใน runbook (สร้าง OAuth client บน GCP)');
      } else {
        setError(msg);
      }
      setHint('');
    } finally {
      setBusy(null);
    }
  }

  async function doDisconnect() {
    if (!confirm('ตัดการเชื่อม Gmail และลบ token ในเครื่อง? (เพิกถอนเพิ่มเติมได้ที่บัญชี Google)')) return;
    setBusy('disconnect');
    setError('');
    try {
      await disconnectGmail();
      await load();
    } catch {
      setError('ตัดการเชื่อม Gmail ไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  const connected = status?.connected ?? false;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {connected ? (
            <MailCheck size={18} className="text-emerald-600" />
          ) : (
            <Mail size={18} className="text-slate-400" />
          )}
          <div>
            <div className="font-semibold text-sm text-slate-700">
              {connected ? 'เชื่อม Gmail แล้ว' : 'ยังไม่ได้เชื่อม Gmail'}
            </div>
            <div className="text-xs text-slate-500">
              {connected
                ? `ส่งจาก ${status?.senderName} <${status?.senderEmail}>${
                    status?.authorizedEmail ? ` · อนุญาตโดย ${status.authorizedEmail}` : ''
                  }`
                : `จะส่งจาก ${status?.senderEmail ?? 'purchasing@prominentdental.com'} (ยืนยันผ่าน ${status?.authAccountHint ?? 'khunnakritr@prominentdental.com'})`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <button
              onClick={doDisconnect}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600 disabled:opacity-50"
            >
              {busy === 'disconnect' ? <Loader2 size={13} className="animate-spin" /> : <Unlink size={13} />}
              ตัดการเชื่อม
            </button>
          ) : (
            <button
              onClick={doConnect}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy === 'connect' ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
              เชื่อม Gmail
            </button>
          )}
        </div>
      </div>

      {status && !status.clientReady && !connected && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            ยังไม่พบไฟล์ OAuth client — วาง <span className="font-mono">gmail-oauth-client.json</span> ในโฟลเดอร์ mercury-local ก่อน (ดูขั้นตอนสร้างใน runbook)
          </span>
        </div>
      )}
      {hint && (
        <div className="mt-2 flex items-center gap-1 text-xs text-amber-700">
          <Loader2 size={12} className="animate-spin" /> {hint}
        </div>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-1 text-rose-600 text-xs">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
    </div>
  );
}
