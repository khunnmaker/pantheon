import { useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  Check,
  Mail,
  Send,
  Eye,
  X,
  Paperclip,
  CloudOff,
} from 'lucide-react';
import {
  getPoEmail,
  dryRunPoEmail,
  sendPoEmail,
  type ComposedEmail,
  type MailStatus,
  type RenderedMessage,
  type EmailOverrides,
  type PurchaseOrder,
} from '../lib/api';

// Review-then-send modal. Loads the prefilled (editable) email for a PO, lets the owner review +
// edit To/CC/subject/body, offers a DRY-RUN (renders the exact outgoing message with no send), and
// a SEND (explicit click → SMTP). There is NO auto-send path: send only fires on the button.
export default function SendEmailModal({
  po,
  onClose,
  onSent,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onSent: () => void;
}) {
  const [composed, setComposed] = useState<ComposedEmail | null>(null);
  const [mail, setMail] = useState<MailStatus | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // Editable fields.
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const [preview, setPreview] = useState<RenderedMessage | null>(null);
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState('');
  const [sentMsg, setSentMsg] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { composed, mail } = await getPoEmail(po.id);
        if (!alive) return;
        setComposed(composed);
        setMail(mail);
        setTo(composed.to);
        setCc(composed.cc.join(', '));
        setSubject(composed.subject);
        setBody(composed.body);
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : 'โหลดอีเมลไม่สำเร็จ');
      }
    })();
    return () => {
      alive = false;
    };
  }, [po.id]);

  const overrides = (): EmailOverrides => ({
    to: to.trim(),
    cc: cc
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    subject: subject.trim(),
    body,
  });

  async function doPreview() {
    setBusy('preview');
    setError('');
    setSentMsg('');
    try {
      const { rendered } = await dryRunPoEmail(po.id, overrides());
      setPreview(rendered);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'สร้างตัวอย่างไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  async function doSend() {
    if (!confirm('ส่งอีเมลใบสั่งซื้อนี้ไปยังผู้ขายจริง?')) return;
    setBusy('send');
    setError('');
    setSentMsg('');
    try {
      const r = await sendPoEmail(po.id, overrides());
      setSentMsg(`ส่งแล้ว (id ${r.messageId})${r.markedOrdered ? ` · ทำเครื่องหมายสั่งแล้ว ${r.markedOrdered} คำขอ` : ''}`);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ส่งอีเมลไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  const notConfigured = mail && !mail.configured;
  const noPdf = composed && !composed.attachmentFound;
  const alreadySent = composed?.alreadySent ?? false;
  const canSend = !!composed && !!mail?.configured && !noPdf && !alreadySent && !!to.trim() && busy === null && !sentMsg;

  const inputCls =
    'w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400';
  const lbl = 'block text-xs font-semibold text-slate-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2 font-semibold text-slate-700">
            <Mail size={18} className="text-orange-600" />
            ตรวจแล้วส่งอีเมลใบสั่งซื้อ · {po.poNumber ?? po.id}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {loadErr && (
            <div className="flex items-center gap-1 text-rose-600 text-sm">
              <AlertTriangle size={14} /> {loadErr}
            </div>
          )}

          {/* From — fixed, not editable (verified alias). */}
          <div className="text-xs text-slate-500 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2">
            ส่งจาก:{' '}
            <span className="font-semibold text-slate-700">
              {mail ? `${mail.senderName} <${mail.senderEmail}>` : 'purchasing@prominentdental.com'}
            </span>{' '}
            (ยืนยันสิทธิ์ผ่านบัญชี {mail?.authAccountHint ?? 'khunnakritr@prominentdental.com'})
          </div>

          {/* SMTP-not-configured warning */}
          {notConfigured && (
            <div className="flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <CloudOff size={15} /> ยังไม่ได้ตั้งค่า SMTP — ใส่ App Password ใน .mercury-smtp.json แล้วรีสตาร์ตแอปก่อนจึงจะส่งได้ (ยังพรีวิว/dry-run ได้)
            </div>
          )}
          {noPdf && (
            <div className="flex items-center gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertTriangle size={15} /> ยังไม่ได้สร้าง PDF — กด &quot;สร้าง PDF&quot; ก่อนจึงจะแนบและส่งได้
            </div>
          )}
          {alreadySent && (
            <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <Check size={15} /> ใบสั่งซื้อนี้ถูกส่งไปแล้ว
            </div>
          )}

          {composed && (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>ถึง (To)</label>
                  <input value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={lbl}>สำเนา (CC) — คั่นด้วย ,</label>
                  <input value={cc} onChange={(e) => setCc(e.target.value)} className={inputCls} />
                </div>
              </div>
              <div>
                <label className={lbl}>หัวข้อ (Subject)</label>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={lbl}>ข้อความ (Body)</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={9}
                  className={`${inputCls} font-mono text-xs leading-relaxed resize-y`}
                />
              </div>

              {/* Attachment */}
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Paperclip size={13} />
                {composed.attachmentFound ? (
                  <span>
                    แนบ: <span className="font-mono">{composed.attachmentName}</span> ·{' '}
                    {(composed.attachmentBytes / 1024).toFixed(1)} KB
                  </span>
                ) : (
                  <span className="text-rose-600">ยังไม่มีไฟล์แนบ (ต้องสร้าง PDF)</span>
                )}
              </div>
            </>
          )}

          {/* Dry-run preview */}
          {preview && (
            <div className="border border-slate-200 rounded-lg bg-slate-50 p-3 text-xs">
              <div className="font-semibold text-slate-600 mb-1 flex items-center gap-1">
                <Eye size={13} /> ตัวอย่างข้อความจริง (dry-run — ยังไม่ส่ง)
              </div>
              <div className="font-mono whitespace-pre-wrap text-slate-700 space-y-0.5">
                <div>From: {preview.from}</div>
                <div>To: {preview.to}</div>
                {preview.cc.length > 0 && <div>Cc: {preview.cc.join(', ')}</div>}
                <div>Subject: {preview.subject}</div>
                <div>
                  Attachment: {preview.attachmentName} ({(preview.attachmentBytes / 1024).toFixed(1)} KB
                  {preview.attachmentFound ? '' : ' — MISSING'})
                </div>
                <div className="border-t border-slate-200 mt-1 pt-1">{preview.body}</div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-sm">
              <AlertTriangle size={14} /> {error}
            </div>
          )}
          {sentMsg && (
            <div className="flex items-center gap-1 text-emerald-700 text-sm">
              <Check size={14} /> {sentMsg}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-100">
          <button
            onClick={doPreview}
            disabled={busy !== null || !composed}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'preview' ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />}
            พรีวิว (dry-run)
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-slate-500 hover:text-slate-700 text-sm"
            >
              ปิด
            </button>
            <button
              onClick={doSend}
              disabled={!canSend}
              title={canSend ? 'ส่งอีเมลจริงไปยังผู้ขาย' : 'ต้องตั้งค่า SMTP + มี PDF + มีผู้รับ'}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              ส่งอีเมล
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
