import { useEffect, useRef, useState, useCallback } from 'react';
import {
  User, LogOut, Clock, Inbox, Loader2, ShieldCheck, MessageSquare,
  Send, Check, CheckCircle2, RefreshCw, Brain, GraduationCap, Wand2, Pencil, AlertTriangle, Search,
  Download, Paperclip, Camera, Banknote, X, ChevronDown, ChevronUp, Crown, Pin, CornerUpLeft, Volume2, VolumeX,
  ExternalLink, Eye, ArrowLeft, Sparkles,
  Eraser,
} from 'lucide-react';
import {
  getQueue, getCustomers, getCustomer, searchCustomers, logout as logoutSuite, regenerateDraft, rewriteText, sendReply, setNickname, setCategory, setStage, STAGES,
  pinCustomer, unpinCustomer,
  uploadAttachment, getLearned, getLearnedMetrics, promoteLearned, rejectLearned, flagLearned, resolveLearned, endSession, API_URL, flatSku, getToken,
  getFinanceAudits, resolveFinanceAudit, type FinanceAudit,
  getQuickReplies, addQuickReply, deleteQuickReply, sendQuickReply, sendMessage, sendPhotoNow, searchCatalog, addProductToDraft, readSlip, sendToFinance,
  draftNow, clearDrafts,
  type Agent, type CustomerLite, type CustomerDetail, type Message, type LearnedAnswer, type LearnedMetrics, type PendingProduct, type QuickReply,
} from './lib/api';
import { getSocket, disconnectSocket } from './lib/socket';
import AppSwitcher from './AppSwitcher';

// Portal-back link uses the canonical Pantheon domain unless build-time env overrides it.
const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? 'https://pantheon.prominentdental.com';

// LINE OA account id for the per-customer OA Manager deep-link. The read-sync chip's link uses
// the OA-native oaChatId (from the extension), so chat.line.biz/{oa}/chat/{oaChatId} now resolves.
const LINE_OA_ID = (import.meta.env.VITE_LINE_OA_ID as string | undefined) ?? 'Uaaa328e6464049ed51e23b78c2184456';

// "x นาทีที่แล้ว" for a synced-at timestamp; falls back to HH:MM for older syncs / bad input.
// Interpret the OA read marker ("Read 20:48" / "อ่านแล้ว 20:48") as an absolute moment — the
// most recent occurrence of that wall-clock time at or before the sync observation (staff run
// in the same Asia/Bangkok TZ LINE displays) — and compare it with our LATEST outgoing message.
// If we sent something newer than the read point, the customer hasn't read it yet (as of the
// last sync; it updates the next time the chat is opened in the OA Manager).
function oaReadState(
  readLabel: string | null,
  readSeenAt: string | null,
  messages: Array<{ role: string; createdAt: string }>,
): { unread: boolean; readTime: string } | null {
  if (!readLabel) return null;
  const m = readLabel.match(/(\d{1,2}):(\d{2})/);
  const readTime = m ? m[0] : readLabel;
  const seen = readSeenAt ? new Date(readSeenAt) : null;
  if (!m || !seen || Number.isNaN(seen.getTime())) return { unread: false, readTime };
  const readUpTo = new Date(seen);
  readUpTo.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 59, 999); // end of the marker minute
  if (readUpTo.getTime() > seen.getTime()) readUpTo.setDate(readUpTo.getDate() - 1);
  let latestOut = 0;
  for (const msg of messages) {
    if (msg.role !== 'agent') continue;
    const t = new Date(msg.createdAt).getTime();
    if (t > latestOut) latestOut = t;
  }
  // 90s tolerance for clock skew between LINE's marker time and our server timestamps.
  return { unread: latestOut > readUpTo.getTime() + 90_000, readTime };
}

function syncAgo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'เมื่อสักครู่';
  if (min < 60) return `${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ชม.ที่แล้ว`;
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

// Read a File as a base64 data URL (for upload).
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

function fmtTime(t?: string) {
  if (!t) return '';
  try {
    const d = new Date(t);
    return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Compact author + truncated text of a message, for a quoted-reply snippet / the "reply-to" bar.
// Attachment-aware: a picture (or other non-text attachment) has no useful m.text, so name the
// attachment instead — an image uses its AI caption when available. Sticker (already readable as
// "[สติกเกอร์] …") and plain text fall through to the existing m.text behavior.
function quoteSnippet(m: Message | undefined): { author: string; text: string } {
  if (!m) return { author: '', text: 'ข้อความที่ตอบกลับ' };
  const author = m.role === 'customer' ? 'ลูกค้า' : m.agentName ? m.agentName : 'ทีมงาน';
  const attachmentLabel = (() => {
    switch (m.attachmentType) {
      case 'image': return m.aiCaption ? `รูปภาพ: ${m.aiCaption}` : 'รูปภาพ';
      case 'product': return 'รูปสินค้า';
      case 'file': return m.attachmentName ? `ไฟล์: ${m.attachmentName}` : 'ไฟล์';
      case 'video': return 'วิดีโอ';
      case 'audio': return 'เสียง';
      case 'location': return 'ตำแหน่งที่ตั้ง';
      default: return null;
    }
  })();
  const raw = (attachmentLabel ?? m.text ?? '').replace(/\s+/g, ' ').trim();
  const text = raw.length > 60 ? raw.slice(0, 60) + '…' : raw || 'ข้อความ';
  return { author, text };
}
const nameOf = (c: CustomerLite) => {
  const base = c.nickname || c.displayName || c.lineUserId;
  return c.code ? `${c.code} ${base}` : base;
};
const CATEGORIES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'Lab'];

// Customer avatar: the LINE profile/group picture when present, else the generic person icon
// in the grey circle. A broken/expired picture url falls back to the icon via onError. Sizes
// the circle + icon from `size` (px) so it works in the list (32) and the header (28).
function Avatar({ src, size = 32, className = '' }: { src?: string | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  // Reset the error state when the url changes (opening a different chat / lazy-backfill arriving).
  useEffect(() => { setBroken(false); }, [src]);
  const style = { width: size, height: size };
  if (src && !broken) {
    return (
      <img src={src} alt="" style={style} onError={() => setBroken(true)}
        className={'rounded-full object-cover bg-slate-200 shrink-0 ' + className} />
    );
  }
  return (
    <span style={style}
      className={'rounded-full bg-slate-200 text-slate-600 flex items-center justify-center shrink-0 ' + className}>
      <User size={Math.round(size * 0.47)} />
    </span>
  );
}

// A stored attachment (image/video/audio/file) fetched with the JWT (the content
// endpoint stays auth-protected) and shown via an object URL: image/video/audio
// inline, files as a download link.
function AuthedAttachment({ messageId, kind, fileName }: { messageId: string; kind: string; fileName?: string | null }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let obj = '';
    setFailed(false);
    setUrl('');
    fetch(`${API_URL}/api/messages/${messageId}/content`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no content'))))
      .then((b) => { obj = URL.createObjectURL(b); setUrl(obj); })
      .catch(() => setFailed(true));
    return () => { if (obj) URL.revokeObjectURL(obj); };
  }, [messageId]);
  if (failed)
    return <span className="text-xs text-slate-400">{kind === 'file' && fileName ? `${fileName} — ` : ''}โหลดไฟล์ไม่ได้ (อาจหมดอายุ)</span>;
  if (!url) return <span className="text-xs text-slate-400">กำลังโหลด…</span>;
  if (kind === 'image') return <img src={url} alt="รูปจากลูกค้า" data-zoom className="max-w-[220px] max-h-[260px] rounded-lg block cursor-zoom-in" />;
  if (kind === 'video') return <video src={url} controls className="max-w-[260px] max-h-[300px] rounded-lg block" />;
  if (kind === 'audio') return <audio src={url} controls className="max-w-[260px]" />;
  return (
    <a href={url} download={fileName ?? 'file'} className="inline-flex items-center gap-1.5 text-sm text-sky-700 underline break-all">
      <Download size={14} className="shrink-0" /> {fileName ?? 'ดาวน์โหลดไฟล์'}
    </a>
  );
}

function StickerImage({ refStr }: { refStr: string }) {
  const [failed, setFailed] = useState(false);
  const stickerId = refStr.split('/')[1];
  if (!stickerId || failed) return <span>[สติกเกอร์]</span>;
  return (
    <img
      src={`https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`}
      alt="สติกเกอร์"
      className="w-24 h-24 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function MessageBody({ m }: { m: Message }) {
  const agentUp = m.role === 'agent'; // staff-sent uploads are served publicly
  if (m.attachmentType === 'image')
    return agentUp ? (
      <div className="space-y-1.5">
        {m.text && <div>{m.text}</div>}
        <img src={`${API_URL}/content/upload/${m.attachmentRef}`} alt="รูปที่ส่ง" data-zoom
          className="max-w-[220px] max-h-[260px] rounded-lg block cursor-zoom-in"
          onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      </div>
    ) : (
      <AuthedAttachment messageId={m.id} kind="image" />
    );
  if (m.attachmentType === 'video') return <AuthedAttachment messageId={m.id} kind="video" />;
  if (m.attachmentType === 'audio') return <AuthedAttachment messageId={m.id} kind="audio" />;
  if (m.attachmentType === 'file')
    return agentUp ? (
      <div className="space-y-1.5">
        {m.text && <div>{m.text}</div>}
        <a href={`${API_URL}/content/upload/${m.attachmentRef}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm underline break-all">
          <Download size={14} className="shrink-0" /> {m.attachmentName ?? 'ไฟล์'}
        </a>
      </div>
    ) : (
      <AuthedAttachment messageId={m.id} kind="file" fileName={m.attachmentName} />
    );
  if (m.attachmentType === 'sticker') return <StickerImage refStr={m.attachmentRef ?? ''} />;
  // Agent reply that included a catalog product photo — show text + the photo.
  if (m.attachmentType === 'product' && m.attachmentRef)
    return (
      <div className="space-y-1.5">
        {m.text && <div>{m.text}</div>}
        <div className="flex flex-wrap gap-1.5">
          {m.attachmentRef.split(',').filter(Boolean).map((sku) => (
            <img key={sku} src={`${API_URL}/content/product/${sku}`} alt="รูปสินค้า" data-zoom
              className="max-w-[150px] max-h-[150px] rounded-lg bg-white block cursor-zoom-in"
              onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          ))}
        </div>
      </div>
    );
  return <>{m.text}</>;
}

// A horizontal strip of selectable product photos (shared by the direct-match and
// cross-sell rows). Multi-select; selected items get a ✓ and a ring.
function PhotoStrip({ direct, cross, selected, onToggle }: {
  direct: PendingProduct[];
  cross: PendingProduct[];
  selected: string[];
  onToggle: (sku: string) => void;
}) {
  if (!direct.length && !cross.length) return null;
  const thumb = (p: PendingProduct, isCross: boolean) => {
    const sel = selected.includes(p.sku);
    return (
      <button key={p.sku} type="button" onClick={() => onToggle(p.sku)}
        title={(isCross ? '💡 มักซื้อคู่กัน — ' : '') + ([p.nameEn, p.nameTh].filter(Boolean).join(' / ')) +
          (p.stock != null ? `\nคงเหลือ ${p.stock.toLocaleString()} ชิ้น${p.stockAt ? ' (ณ ' + new Date(p.stockAt).toLocaleDateString('th-TH') + ')' : ''}` : '')}
        className={'shrink-0 w-[88px] rounded-lg border p-1 text-left transition ' + (sel ? 'border-sky-500 ring-2 ring-sky-400 bg-white' : 'border-sky-100 bg-white/60 hover:border-sky-300')}>
        <div className="relative h-[68px] flex items-center justify-center bg-white rounded">
          {p.photoSku
            ? <img src={`${API_URL}/content/product/${p.photoSku}`} alt=""
                className="max-w-full max-h-full object-contain"
                onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            : <span className="text-[9px] text-slate-400 text-center leading-tight px-1">ไม่มีรูป</span>}
          {isCross && <span className="absolute top-0.5 left-0.5 text-[11px] leading-none">💡</span>}
          {sel && <span className="absolute top-0.5 right-0.5 bg-sky-600 text-white rounded-full p-0.5 flex"><Check size={11} /></span>}
        </div>
        <div className="text-[10px] mt-1 leading-tight">
          <div className="font-semibold text-sky-800 truncate">{[p.nameEn, p.nameTh].filter(Boolean).join(' / ') || flatSku(p.sku)}</div>
          <div className="text-sky-600">{p.price > 0 ? `${p.price.toLocaleString()} บาท` : '—'}</div>
          {p.stock != null ? (() => {
            const out = p.stock <= 0;
            // Low = Vesta reorderPoint reached (preferred); fall back to the ≤5 heuristic
            // when no reorder point is configured for this SKU.
            const lowFlag = !out && (p.low ?? (p.reorderPoint == null && p.stock <= 5));
            const stale = p.stockAt ? Date.now() - new Date(p.stockAt).getTime() > 3 * 86400000 : false;
            return (
              <>
                <div className={'mt-0.5 rounded px-1 py-0.5 text-center text-[10px] font-bold ' +
                  (out ? 'bg-rose-100 text-rose-700' : lowFlag ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700')}>
                  {out ? 'หมด' : `${lowFlag ? 'ใกล้หมด · ' : ''}คงเหลือ ${p.stock.toLocaleString()}`}
                </div>
                {p.stockAt && (
                  <div className={'text-center text-[8px] ' + (stale ? 'text-amber-600' : 'text-slate-400')}>
                    ณ {new Date(p.stockAt).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })}
                  </div>
                )}
              </>
            );
          })() : (
            <div className="mt-0.5 text-center text-[9px] text-slate-400">ไม่มีข้อมูลสต็อก</div>
          )}
        </div>
      </button>
    );
  };
  return (
    <div className="bg-sky-50 border border-sky-200 rounded-xl p-2">
      <div className="flex gap-2 overflow-x-auto pb-1 items-stretch">
        {direct.map((p) => thumb(p, false))}
        {direct.length > 0 && cross.length > 0 && (
          <div className="shrink-0 self-stretch w-px bg-sky-300 mx-1" />
        )}
        {cross.map((p) => thumb(p, true))}
      </div>
    </div>
  );
}

// The "ส่งข้อความสำเร็จรูป" (quick-reply) button + its dropdown popover — list of saved
// templates (click sends immediately to the customer) plus an add/manage panel. Shared by
// the pending-question composer and the already-answered composer so the two stay identical.
function QuickReplyMenu({
  quickReplies, qrOpen, setQrOpen, qrSending, quickSend,
  qrManage, setQrManage, qrLabel, setQrLabel, qrBody, setQrBody, qrSaving, saveQuickReply, removeQuickReply,
}: {
  quickReplies: QuickReply[];
  qrOpen: boolean;
  setQrOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  qrSending: boolean;
  quickSend: (q: QuickReply) => void;
  qrManage: boolean;
  setQrManage: (v: boolean | ((prev: boolean) => boolean)) => void;
  qrLabel: string;
  setQrLabel: (v: string) => void;
  qrBody: string;
  setQrBody: (v: string) => void;
  qrSaving: boolean;
  saveQuickReply: () => void;
  removeQuickReply: (id: string) => void;
}) {
  return (
    <div className="relative">
      <button type="button" onClick={() => setQrOpen((v) => !v)} disabled={qrSending}
        title="ส่งข้อความสำเร็จรูป" aria-label="ส่งข้อความสำเร็จรูป"
        className="w-full h-full px-2 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center gap-0.5 disabled:opacity-50">
        {qrSending ? <Loader2 size={15} className="animate-spin" /> : <MessageSquare size={15} />}
        <ChevronDown size={11} />
      </button>
      {qrOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setQrOpen(false)} />
          <div className="absolute bottom-full mb-1 left-0 z-30 w-64 max-h-80 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg p-1">
            <div className="px-2 py-1 text-[10px] text-slate-400">กดเพื่อส่งให้ลูกค้าทันที</div>
            {quickReplies.map((q) => (
              <div key={q.id} className="flex items-center gap-1">
                <button type="button" onClick={() => quickSend(q)} disabled={qrSending}
                  className="flex-1 text-left text-xs px-2 py-1.5 rounded-lg hover:bg-sky-50 text-slate-700 truncate disabled:opacity-50" title={q.body}>
                  {q.label}
                </button>
                {qrManage && <button type="button" onClick={() => removeQuickReply(q.id)} title="ลบ" className="text-rose-400 hover:text-rose-600 px-1"><X size={12} /></button>}
              </div>
            ))}
            <div className="border-t border-slate-100 mt-1 pt-1">
              <button type="button" onClick={() => setQrManage((v) => !v)}
                className="w-full text-left text-[11px] text-slate-500 px-2 py-1 hover:bg-slate-50 rounded flex items-center gap-1">
                <Pencil size={11} /> {qrManage ? 'เสร็จสิ้น' : 'แก้ไข / เพิ่มรายการ'}
              </button>
              {qrManage && (
                <div className="flex flex-col gap-1 p-1">
                  <input value={qrLabel} onChange={(e) => setQrLabel(e.target.value)} placeholder="ชื่อปุ่ม"
                    className="text-xs px-2 py-1 rounded border border-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-400" />
                  <textarea value={qrBody} onChange={(e) => setQrBody(e.target.value)} rows={3} placeholder="ข้อความที่จะส่ง…"
                    className="text-xs px-2 py-1 rounded border border-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-sky-400" />
                  <button type="button" onClick={saveQuickReply} disabled={qrSaving || !qrLabel.trim() || !qrBody.trim()}
                    className="self-start text-xs px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-50">
                    {qrSaving ? 'กำลังบันทึก…' : 'เพิ่ม'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Live webcam capture for desktop (where the <input capture> attribute is ignored and
// only opens a file dialog). Streams the camera, snaps a frame to a JPEG File.
function CameraCapture({ onCapture, onClose }: { onCapture: (file: File) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr('เบราว์เซอร์นี้ไม่รองรับการเปิดกล้อง — ใช้ปุ่มแนบรูปแทนได้ค่ะ');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.muted = true;
          await videoRef.current.play().catch(() => undefined);
        }
        setReady(true);
      } catch {
        setErr('เปิดกล้องไม่ได้ — โปรดอนุญาตการใช้กล้องในเบราว์เซอร์ หรือใช้ปุ่มแนบรูปแทน');
      }
    })();
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture(new File([blob], `photo-${blob.size}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-3 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        {err ? (
          <div className="text-sm text-rose-600 p-6 text-center">{err}</div>
        ) : (
          <div className="relative bg-black rounded-xl overflow-hidden aspect-[4/3] flex items-center justify-center">
            <video ref={videoRef} playsInline className="w-full h-full object-contain" />
            {!ready && <Loader2 className="absolute text-white animate-spin" size={28} />}
          </div>
        )}
        <div className="flex justify-between items-center mt-3">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm">ยกเลิก</button>
          {!err && (
            <button type="button" onClick={snap} disabled={!ready}
              className="px-5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
              <Camera size={16} /> ถ่ายรูป
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// "แจ้งการเงิน" — confirm a payment slip's details (AI-prefilled, staff-editable) then
// forward them to the finance Google Sheet.
function FinanceModal({ messageId, onClose, onSent }: { messageId: string; onClose: () => void; onSent: (corrected: boolean) => void }) {
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [ocrAmount, setOcrAmount] = useState(''); // server-truth amount read off the slip
  const [f, setF] = useState({ nickname: '', code: '', realName: '', amount: '', bank: '', transferAt: '', ref: '', taxInvoice: '', note: '' });
  // Slip fields the OCR filled are LOCKED (the slip is the source of truth — staff must not
  // alter money data; a mis-read is corrected by finance against the slip image, not here).
  // A field the OCR left blank stays editable, otherwise an unreadable slip couldn't be sent.
  const [locked, setLocked] = useState({ realName: false, amount: false, bank: false, transferAt: false, ref: false });

  useEffect(() => {
    let cancelled = false;
    readSlip(messageId)
      .then((r) => {
        if (!cancelled) {
          setF((p) => ({ ...p, ...r }));
          setOcrAmount(r.amount);
          setLocked({ realName: !!r.realName, amount: !!r.amount, bank: !!r.bank, transferAt: !!r.transferAt, ref: !!r.ref });
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [messageId]);

  const amountEdited = !!ocrAmount && !!f.amount.trim() && f.amount.trim() !== ocrAmount;

  async function send() {
    if (sending || !f.amount.trim()) return;
    setSending(true); setErr('');
    try {
      const res = await sendToFinance(messageId, { amount: f.amount, bank: f.bank, transferAt: f.transferAt, ref: f.ref, nickname: f.nickname, realName: f.realName, taxInvoice: f.taxInvoice, note: f.note });
      if (res.alreadySent) { setErr('ส่งให้การเงินไปแล้ว'); onSent(false); return; }
      if (!res.ok) { setErr('ส่งให้การเงินไม่สำเร็จ: ' + (res.error ?? '')); return; }
      onSent(res.corrected ?? false);
    } catch { setErr('ส่งให้การเงินไม่สำเร็จ'); } finally { setSending(false); }
  }

  const field = (label: string, key: keyof typeof f, ph: string, readOnly = false) => (
    <label className="block">
      <span className="text-[11px] text-slate-500">{label}</span>
      <input value={f[key]} readOnly={readOnly} onChange={(e) => setF({ ...f, [key]: e.target.value })} placeholder={ph}
        className={'w-full mt-0.5 px-2 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ' + (readOnly ? 'bg-slate-50 border-slate-200 text-slate-500' : 'border-slate-300')} />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-2.5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-slate-800 flex items-center gap-1.5"><Banknote size={17} className="text-amber-600" /> แจ้งการเงิน</div>
        {loading && <div className="text-xs text-slate-400 flex items-center gap-1"><Loader2 size={13} className="animate-spin" /> กำลังอ่านสลิป…</div>}
        <div className="grid grid-cols-2 gap-2">
          {field('รหัสลูกค้า', 'code', '—', true)}
          {field('ชื่อ', 'nickname', '', true)}
          {field('ชื่อผู้โอน', 'realName', 'ชื่อผู้โอน', locked.realName)}
          {field('จำนวนเงิน', 'amount', 'เช่น 1500', locked.amount)}
          {field('บัญชีที่รับเงิน', 'bank', 'กสิกร / ไทยพาณิชย์', locked.bank)}
          {field('วันเวลาโอน', 'transferAt', '27/06/2026 14:30', locked.transferAt)}
          {field('เลขอ้างอิง', 'ref', '', locked.ref)}
        </div>
        <div className="text-[10px] text-slate-400 leading-snug">ข้อมูลที่อ่านได้จากสลิปถูกล็อกไว้ แก้ไขไม่ได้ — การเงินจะตรวจกับสลิปจริงอีกครั้ง</div>
        <label className="block">
          <span className="text-[11px] text-slate-500">ใบกำกับภาษี (ชื่อ / ที่อยู่ / เลขผู้เสียภาษี)</span>
          <textarea value={f.taxInvoice} onChange={(e) => setF({ ...f, taxInvoice: e.target.value })} rows={3}
            placeholder="ชื่อ / ที่อยู่ / เลขประจำตัวผู้เสียภาษี 13 หลัก (ถ้าลูกค้าขอ)"
            className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-slate-300 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400" />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-500">หมายเหตุ</span>
          <textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={2}
            placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
            className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-slate-300 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400" />
        </label>
        {amountEdited && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 flex items-start gap-1.5">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>ยอดถูกแก้จากที่อ่านได้ในสลิป (<b>{ocrAmount}</b>) — รายการนี้จะถูกส่งให้แอดมินตรวจสอบ</span>
          </div>
        )}
        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm">ยกเลิก</button>
          <button type="button" onClick={send} disabled={sending || !f.amount.trim()}
            className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={13} />} ส่งให้การเงิน
          </button>
        </div>
      </div>
    </div>
  );
}

// Supervisor-only corrected-amount audit view (tamper-proof; sales have no access).
function FinanceAuditView({ audits, onResolve, onRefresh }: { audits: FinanceAudit[]; onResolve: (id: string) => void; onRefresh: () => void }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 shrink-0">
        <Banknote size={18} className="text-amber-600" />
        <span className="font-semibold text-slate-800">ตรวจสอบยอด</span>
        <span className="text-xs text-slate-400">รายการที่พนักงานแก้ยอดจากสลิป ({audits.length})</span>
        <button onClick={onRefresh} className="ml-auto text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"><RefreshCw size={12} /> รีเฟรช</button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {audits.length === 0 && <div className="text-center text-slate-400 text-sm py-12">ไม่มีรายการที่ต้องตรวจสอบ ✓</div>}
        {audits.map((a) => (
          <div key={a.id} className="border border-amber-200 bg-amber-50 rounded-xl p-3">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className="font-semibold text-slate-800">{a.nickname || a.senderName || '—'}</span>
              {a.senderName && <span className="text-slate-500 text-xs">ผู้โอน: {a.senderName}</span>}
              <span className="ml-auto text-[11px] text-slate-400">{fmtTime(a.createdAt)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-4 flex-wrap text-xs">
              <span>อ่านจากสลิป <b className="text-slate-700">{a.ocrAmount}</b></span>
              <span>กรอกส่ง <b className="text-rose-700">{a.amount}</b></span>
              <span>ส่วนต่าง <b className={parseFloat(a.diff) < 0 ? 'text-rose-700' : 'text-sky-700'}>{a.diff}</b></span>
              <span className="text-slate-500">โดย {a.salesName || '—'}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <a href={a.slipUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">ดูสลิป</a>
              <button onClick={() => onResolve(a.id)} className="ml-auto text-xs px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white flex items-center gap-1"><CheckCircle2 size={12} /> ตรวจแล้ว</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Console({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [view, setView] = useState<'console' | 'learning' | 'audit'>('console');
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [waitingIds, setWaitingIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Mobile-only (< md) master-detail nav: true = the conversation pane is showing full-screen
  // in place of the queue, like the LINE app. Has no effect at md+, where both panes are
  // always shown side by side regardless of this flag.
  const [mobileShowChat, setMobileShowChat] = useState(false);
  // Mobile-only (< md) bottom-sheet state for the AI panel (long-term memory + draft composer +
  // product picker). At md+ the panel is always a normal inline column, ignoring this flag.
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Notification sound on inbound customer messages (per-browser mute, throttled).
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('minerva_sound_off') !== '1');
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastSoundRef = useRef(0);
  const playChime = useCallback(() => {
    if (!soundOnRef.current) return;
    const now = Date.now();
    if (now - lastSoundRef.current < 1500) return; // avoid a burst of dings
    lastSoundRef.current = now;
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) { ctx = new AudioContext(); audioCtxRef.current = ctx; }
      if (ctx.state === 'suspended') void ctx.resume();
      const t0 = ctx.currentTime;
      const notes: Array<[number, number]> = [[880, 0], [1174.66, 0.12]]; // A5 → D6, "ติ๊ง-ติ๊ง"
      for (const [freq, delay] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = t0 + delay;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.2);
      }
    } catch { /* audio unavailable — ignore */ }
  }, []);

  const [editText, setEditText] = useState('');
  const [sending, setSending] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [nickEdit, setNickEdit] = useState<{ code: string; nickname: string } | null>(null);
  const [rewriteNote, setRewriteNote] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<CustomerLite[] | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set()); // this agent's pinned customer ids (private)
  const [pinnedOpen, setPinnedOpen] = useState(true); // "ปักหมุด" section collapse state
  const [categoryFilters, setCategoryFilters] = useState<string[]>(() => [...CATEGORIES]); // all selected = show all
  const [catOpen, setCatOpen] = useState(false);
  const [stageFilters, setStageFilters] = useState<string[]>(() => [...STAGES]); // all selected = show all
  const [stageOpen, setStageOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [selectedProductSkus, setSelectedProductSkus] = useState<string[]>([]);
  const [selectionDirty, setSelectionDirty] = useState(false); // product selection changed since the last draft → ✨ re-drafts about it
  const [lightbox, setLightbox] = useState<string | null>(null); // enlarged image src (click a picture to zoom)
  const [upload, setUpload] = useState<{ uploadId: string; kind: string; fileName: string; previewUrl: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true); // show/hide draft note + photo picker
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [qrManage, setQrManage] = useState(false);
  const [qrLabel, setQrLabel] = useState('');
  const [qrBody, setQrBody] = useState('');
  const [qrSaving, setQrSaving] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrSending, setQrSending] = useState(false);
  const [qrConfirmId, setQrConfirmId] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [freeNeedsConfirm, setFreeNeedsConfirm] = useState(false);
  const [freeSending, setFreeSending] = useState(false);
  const [forceDrafting, setForceDrafting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null); // Message.id being LINE-quote-replied
  const [freeProducts, setFreeProducts] = useState<PendingProduct[]>([]); // catalog photos picked in the answered-state composer (no draft to attach to)
  const [freeRewriting, setFreeRewriting] = useState(false);
  const [prodSearchOpen, setProdSearchOpen] = useState(false);
  const [prodSearchQ, setProdSearchQ] = useState('');
  const [prodSearchResults, setProdSearchResults] = useState<PendingProduct[]>([]);
  const [prodSearching, setProdSearching] = useState(false);
  const [toast, setToast] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [financeMsg, setFinanceMsg] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [learned, setLearned] = useState<LearnedAnswer[]>([]);
  const [flaggedLearned, setFlaggedLearned] = useState<LearnedAnswer[]>([]);
  const [audits, setAudits] = useState<FinanceAudit[]>([]);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [learnNotice, setLearnNotice] = useState<{ kind: 'warn' | 'error'; text: string } | null>(null);

  const selectedRef = useRef<string | null>(null);
  // Tracks the customer id we already asked the OA-sync extension to auto-open, so a same-customer
  // detail reload (socket push, etc.) never re-fires the navigation — only an actual customer switch does.
  const lastAutoOpenRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshLists = useCallback(async () => {
    const [{ customers: cs, pinnedIds: pins }, { queue }] = await Promise.all([getCustomers(), getQueue()]);
    setCustomers(cs);
    setPinnedIds(new Set(pins));
    setWaitingIds(new Set(queue.map((q) => q.customer.id)));
  }, []);

  const loadDetail = useCallback(async (id: string, preserveStaffInput = false) => {
    setLoadingDetail(true);
    try {
      const d = await getCustomer(id);
      // Clear an in-progress quote-reply selection only when SWITCHING to a different customer —
      // a same-customer reload (socket push / post-send refresh) must not drop the staff's pick.
      setDetail((prev) => {
        if (prev && prev.customer.id !== d.customer.id) setReplyingTo(null);
        return d;
      });
      setEditText(d.pendingDraft?.draftText ?? '');
      setNeedsConfirm(false);
      setQrConfirmId(null);
      setRewriteNote(null);
      // Preserve the staff's photo selection across reloads (their own ร่างใหม่ AND the
      // live draft:new socket push that follows): keep any selected SKU still present in
      // the new picker; only fall back to the AI's default pick when none survive (i.e.
      // switching to a different customer, whose picker shares none of the old SKUs).
      const validSkus = new Set<string>([
        ...d.productCandidates.map((p) => p.sku),
        ...d.crossSellCandidates.map((p) => p.sku),
        ...(d.pendingProduct?.photoSku ? [d.pendingProduct.sku] : []),
      ]);
      const defaultSel = d.pendingProduct?.photoSku ? [d.pendingProduct.sku] : [];
      setSelectedProductSkus((prev) => {
        const kept = prev.filter((s) => validSkus.has(s));
        return kept.length ? kept : defaultSel;
      });
      setSelectionDirty(false); // a freshly loaded draft already reflects the current selection
      if (!preserveStaffInput) {
        setUpload(null);
        setFreeText('');
        setFreeProducts([]);
      }
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const refreshLearned = useCallback(async () => {
    const [pending, flagged] = await Promise.all([getLearned('pending'), getLearned('flagged')]);
    setLearned(pending.learned);
    setFlaggedLearned(flagged.learned);
  }, []);

  const refreshAudits = useCallback(async () => {
    if (agent.role !== 'supervisor') return;
    try { setAudits((await getFinanceAudits('open')).audits); } catch { /* ignore */ }
  }, [agent.role]);

  async function doResolveAudit(id: string) {
    try {
      await resolveFinanceAudit(id);
      setAudits((as) => as.filter((a) => a.id !== id));
      flashToast('ทำเครื่องหมายตรวจแล้ว ✓');
    } catch { setError('ทำเครื่องหมายไม่สำเร็จ'); }
  }

  useEffect(() => {
    getQuickReplies().then(({ items }) => setQuickReplies(items)).catch(() => undefined);
  }, []);

  useEffect(() => { refreshAudits().catch(() => undefined); }, [refreshAudits, view]);

  // #12: when a message lands while the console is BACKGROUNDED (or closed), the WebAudio ding is
  // silent, so staff miss it. Also raise a desktop notification (if the browser allows) and flash
  // an unread count in the tab title; both clear when the tab regains focus.
  const unreadRef = useRef(0);
  const notifyNewMessage = useCallback(() => {
    if (document.visibilityState !== 'hidden') return; // a focused tab already gets the ding
    unreadRef.current += 1;
    document.title = `(${unreadRef.current}) Minerva`;
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('Minerva · ข้อความใหม่', { body: 'ลูกค้าส่งข้อความใหม่ — แตะเพื่อเปิดคอนโซล', tag: 'minerva-new' });
      } catch { /* blocked/unsupported — the title flash still shows */ }
    }
  }, []);
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') { unreadRef.current = 0; document.title = 'Minerva'; }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // initial load + live socket
  useEffect(() => {
    refreshLists().catch(() => undefined);
    refreshLearned().catch(() => undefined);
    const socket = getSocket();
    const onConnectError = (err: Error) => {
      if (err.message === 'unauthorized') logout();
    };
    const onMessage = (payload: { customer: CustomerLite }) => {
      playChime(); // ding on any inbound customer message
      notifyNewMessage(); // + desktop notification / tab-title flash when backgrounded
      refreshLists().catch(() => undefined);
      if (selectedRef.current === payload.customer.id) loadDetail(payload.customer.id).catch(() => undefined);
    };
    const onDraft = (payload: { customerId?: string; messageId: string }) => {
      // Refresh the open conversation when its draft arrives/updates.
      if (selectedRef.current && (payload.customerId === selectedRef.current || !payload.customerId)) {
        setForceDrafting(false);
        loadDetail(selectedRef.current).catch(() => undefined);
      }
    };
    const onDraftQueued = (payload: { customerId: string; fireAt: number }) => {
      if (selectedRef.current !== payload.customerId) return;
      setDetail((d) => (d ? { ...d, draftQueued: { fireAt: payload.fireAt } } : d));
    };
    const onDraftCleared = (payload: { customerId: string }) => {
      if (selectedRef.current !== payload.customerId) return;
      setForceDrafting(false);
      loadDetail(payload.customerId, true).catch(() => undefined);
    };
    const onDraftFailed = (payload: { customerId: string }) => {
      if (selectedRef.current !== payload.customerId) return;
      setForceDrafting(false);
      flashToast('ร่างคำตอบไม่สำเร็จ');
    };
    // The 👁 read chip updates live when the extension (or another staff's console) syncs a new
    // OA read marker for the currently-open customer, without needing a manual refresh.
    const onOaRead = (payload: {
      customerId: string;
      oaRead: { oaChatId: string; readLabel: string | null; readSeenAt: string | null };
    }) => {
      if (selectedRef.current === payload.customerId) {
        setDetail((d) => (d ? { ...d, oaRead: payload.oaRead } : d));
      }
    };
    const onConversation = (payload: { customerId: string; ended?: boolean; message?: Message }) => {
      refreshLists().catch(() => undefined);
      if (selectedRef.current !== payload.customerId) return;
      if (payload.ended) {
        setSelectedId(null); // another staff ended this chat — close it here too
        setMobileShowChat(false); // mobile: return to the queue list
        setDetail(null);
      } else if (payload.message) {
        // append the new message without clobbering the open composer / draft text
        setDetail((d) =>
          d && !d.messages.some((m) => m.id === payload.message!.id)
            ? { ...d, messages: [...d.messages, payload.message!] }
            : d,
        );
      } else {
        loadDetail(payload.customerId).catch(() => undefined);
      }
    };
    socket.on('connect_error', onConnectError);
    socket.on('message:new', onMessage);
    socket.on('draft:new', onDraft);
    socket.on('draft:queued', onDraftQueued);
    socket.on('draft:cleared', onDraftCleared);
    socket.on('draft:failed', onDraftFailed);
    socket.on('conversation:update', onConversation);
    socket.on('oa:read', onOaRead);
    return () => {
      socket.off('connect_error', onConnectError);
      socket.off('message:new', onMessage);
      socket.off('draft:new', onDraft);
      socket.off('draft:queued', onDraftQueued);
      socket.off('draft:cleared', onDraftCleared);
      socket.off('draft:failed', onDraftFailed);
      socket.off('conversation:update', onConversation);
      socket.off('oa:read', onOaRead);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLists, loadDetail, refreshLearned, playChime]);

  useEffect(() => {
    selectedRef.current = selectedId;
    setForceDrafting(false);
    if (selectedId) loadDetail(selectedId).catch(() => undefined);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length]);

  // Auto-open in LINE OA: when the opened customer has a known OA read-sync chat id, ask the
  // OA-sync Chrome extension (via a same-origin postMessage a content-script bridge relays to
  // its background worker) to silently navigate a BACKGROUND chat.line.biz tab there, so the
  // passive read-sync fires without staff manually hunting for the chat. Guarded by customer id
  // (not object identity — `detail` reloads on socket events for the SAME open customer and must
  // not re-trigger) and debounced 1500ms so click-skimming through the queue never fires it. If
  // the extension isn't installed, the postMessage is simply never picked up (harmless no-op).
  useEffect(() => {
    const customerId = detail?.customer.id;
    const oaChatId = detail?.oaRead?.oaChatId;
    if (!customerId || !oaChatId) return;
    if (lastAutoOpenRef.current === customerId) return;
    if (document.visibilityState !== 'visible') return;
    lastAutoOpenRef.current = customerId;
    const t = setTimeout(() => {
      window.postMessage({ type: 'minerva-oa-open', url: `https://chat.line.biz/${LINE_OA_ID}/chat/${oaChatId}` }, window.location.origin);
    }, 1500);
    return () => clearTimeout(t);
  }, [detail?.customer.id, detail?.oaRead?.oaChatId]);

  // Debounced customer search (by nickname / LINE name) — includes ended chats.
  useEffect(() => {
    const q = searchTerm.trim();
    if (!q) { setSearchResults(null); return; }
    const t = setTimeout(() => {
      searchCustomers(q).then((r) => setSearchResults(r.customers)).catch(() => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  function flashToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }

  async function clearMinervaDrafts() {
    if (!selectedId) return;
    try {
      await clearDrafts(selectedId);
      setForceDrafting(false);
      await loadDetail(selectedId, true);
      flashToast('ล้างร่าง Minerva แล้ว');
    } catch {
      flashToast('ล้างร่าง Minerva ไม่สำเร็จ');
    }
  }

  async function forceDraftNow() {
    if (!selectedId || forceDrafting) return;
    setForceDrafting(true);
    try {
      const result = await draftNow(selectedId);
      if ('noPending' in result) {
        setForceDrafting(false);
        flashToast('ยังไม่มีข้อความใหม่จากลูกค้า');
      }
    } catch {
      setForceDrafting(false);
      flashToast('ร่างคำตอบไม่สำเร็จ');
    }
  }

  // Pin/unpin a customer chat for THIS agent (private). Optimistically flip local state,
  // then persist; revert + toast on failure.
  async function togglePin(id: string) {
    const wasPinned = pinnedIds.has(id);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (wasPinned) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      if (wasPinned) await unpinCustomer(id);
      else await pinCustomer(id);
    } catch {
      setPinnedIds((prev) => {
        const next = new Set(prev);
        if (wasPinned) next.add(id);
        else next.delete(id);
        return next;
      });
      flashToast('ปักหมุดไม่สำเร็จ');
    }
  }

  function logout() {
    disconnectSocket();
    void logoutSuite(); // clears the shared SSO cookie + local session (fire-and-forget)
    onLogout();
  }

  async function approve() {
    const draft = detail?.pendingDraft;
    const msgId = detail?.pendingMessageId;
    if (!draft || !msgId || !editText.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await sendReply(msgId, editText.trim(), needsConfirm, selectedProductSkus.length ? selectedProductSkus : undefined, upload?.uploadId, replyingTo ?? undefined);
      if ('needsConfirm' in res) {
        setNeedsConfirm(true);
        setError('คำตอบมีราคา — โปรดตรวจสอบตัวเลขแล้วกด "ยืนยันส่ง" อีกครั้ง');
        return;
      }
      if ('alreadyReplied' in res) {
        setError('ข้อความนี้ถูกตอบไปแล้ว');
        await refreshLists();
        if (selectedId) await loadDetail(selectedId);
        return;
      }
      setReplyingTo(null); // sent — clear the quote-reply selection
      flashToast(res.dryRun ? 'บันทึกแล้ว (โหมดทดสอบ — ยังไม่ส่งจริงไป LINE)' : 'ส่งคำตอบไปยังลูกค้าแล้ว ✓');
      if (res.learnedCaptured) flashToast('ส่งแล้ว — คำตอบที่แก้ถูกเก็บเข้าคลังการเรียนรู้');
      await refreshLists();
      await refreshLearned();
      if (selectedId) await loadDetail(selectedId);
    } catch (e) {
      setError('ส่งไม่สำเร็จ: ' + (e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ✨ button. If the staff changed the product selection (added/toggled products), re-draft
  // the reply ABOUT the selected products — so they can add SEVERAL products first, then press
  // once. Otherwise just polish the current text (grammar/wording) without changing meaning/numbers.
  async function rewrite() {
    if (rewriting || sending) return;
    if (selectionDirty && selectedProductSkus.length) {
      await regenerate(editText); // re-draft about the selected products, building on the agent's typed text
      return;
    }
    if (!editText.trim()) return;
    setRewriting(true);
    setError('');
    setRewriteNote(null);
    try {
      const res = await rewriteText(editText.trim());
      setEditText(res.text);
      setRewriteNote(res.note); // staff-only note — shown OUTSIDE the reply box
      setNeedsConfirm(false); // text changed — re-check numbers on send
      flashToast('เรียบเรียงใหม่แล้ว — ตรวจทานก่อนส่ง');
    } catch (e) {
      setError('เรียบเรียงใหม่ไม่สำเร็จ: ' + (e as Error).message);
    } finally {
      setRewriting(false);
    }
  }

  const toggleProductSku = (sku: string) => {
    setSelectedProductSkus((prev) => (prev.includes(sku) ? prev.filter((s) => s !== sku) : [...prev, sku]));
    setSelectionDirty(true); // selection changed → next ✨ re-drafts about it
    setUpload(null); // a catalog photo choice replaces a staff upload
  };

  // Staff upload a photo/file to ATTACH to the reply (sent together on อนุมัติ & ส่ง).
  async function onPickFile(file?: File) {
    if (!file) return;
    if (uploading) return; // the paste path bypasses the disabled buttons, so guard here too
    if (file.size > 25 * 1024 * 1024) { setError('ไฟล์ใหญ่เกิน 25MB'); return; }
    setUploading(true);
    setError('');
    try {
      const dataUrl = await fileToDataUrl(file);
      const b64 = dataUrl.split(',')[1] ?? '';
      const out = await uploadAttachment(b64, file.name, file.type || 'application/octet-stream');
      setUpload({ uploadId: out.uploadId, kind: out.kind, fileName: out.fileName, previewUrl: file.type.startsWith('image/') ? dataUrl : '' });
      setSelectedProductSkus([]); // a staff upload replaces catalog photo choices
    } catch (err) {
      setError('อัปโหลดไม่สำเร็จ: ' + (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  // Paste an image with Ctrl+V (e.g. a Snipping Tool capture) to attach it to the reply, then
  // send with the normal button. A document-level listener so it works regardless of focus; it
  // only acts on an IMAGE in the clipboard, so pasting text into a box still works as usual.
  // Gated to the visible console composer: in the Learning/Audit tabs, or behind the finance
  // modal / lightbox / camera modal, the composer isn't on screen — a stray Ctrl+V there would
  // silently upload into the hidden composer and (via onPickFile) wipe the staff's selected
  // product photos.
  const onPickFileRef = useRef(onPickFile);
  onPickFileRef.current = onPickFile;
  useEffect(() => {
    if (!selectedId || view !== 'console' || financeMsg || lightbox || cameraOpen) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const raw = it.getAsFile();
          if (raw) {
            e.preventDefault();
            const file = raw.name ? raw : new File([raw], `snip-${Date.now()}.png`, { type: raw.type || 'image/png' });
            void onPickFileRef.current(file);
          }
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [selectedId, view, financeMsg, lightbox, cameraOpen]);

  // Camera capture → upload + send the photo to the customer IMMEDIATELY (standalone,
  // no text). Does NOT queue onto the draft; the composer text is left untouched.
  async function captureAndSend(file?: File) {
    if (!file || !selectedId) return;
    if (file.size > 25 * 1024 * 1024) { setError('ไฟล์ใหญ่เกิน 25MB'); return; }
    setUploading(true);
    setError('');
    try {
      const dataUrl = await fileToDataUrl(file);
      const b64 = dataUrl.split(',')[1] ?? '';
      const out = await uploadAttachment(b64, file.name, file.type || 'image/jpeg');
      const res = await sendPhotoNow(selectedId, out.uploadId);
      flashToast(res.dryRun ? 'ถ่ายรูปแล้ว (โหมดทดสอบ — ยังไม่ส่งจริง)' : 'ส่งรูปให้ลูกค้าแล้ว ✓');
    } catch (err) {
      setError('ส่งรูปไม่สำเร็จ: ' + (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function quickSend(q: QuickReply) {
    if (!selectedId || qrSending) return;
    setQrSending(true);
    setError('');
    try {
      const res = await sendQuickReply(selectedId, q.id, qrConfirmId === q.id, replyingTo ?? undefined);
      if ('needsConfirm' in res) {
        setQrConfirmId(q.id);
        setError('ข้อความด่วนนี้มีราคา — กดอีกครั้งเพื่อยืนยันส่ง');
        return;
      }
      setQrConfirmId(null);
      setQrOpen(false);
      setReplyingTo(null); // sent — clear the quote-reply selection
      flashToast(res.dryRun ? `บันทึก "${q.label}" (โหมดทดสอบ)` : `ส่ง "${q.label}" ให้ลูกค้าแล้ว ✓`);
    } catch {
      setError('ส่งข้อความไม่สำเร็จ');
    } finally {
      setQrSending(false);
    }
  }

  // Free-form message (text and/or an attached photo/file and/or picked catalog products)
  // when there's no pending question.
  async function freeSend() {
    if (!selectedId || (!freeText.trim() && !upload && !freeProducts.length) || freeSending) return;
    setFreeSending(true);
    setError('');
    try {
      const skus = freeProducts.length ? freeProducts.map((p) => p.sku) : undefined;
      const res = await sendMessage(selectedId, freeText.trim(), upload?.uploadId, freeNeedsConfirm, skus, replyingTo ?? undefined);
      if ('needsConfirm' in res) {
        setFreeNeedsConfirm(true);
        setError('ข้อความมีราคา — โปรดตรวจสอบตัวเลขแล้วกดส่งอีกครั้งเพื่อยืนยัน');
        return;
      }
      setFreeText('');
      setUpload(null);
      setFreeProducts([]);
      setFreeNeedsConfirm(false);
      setReplyingTo(null); // sent — clear the quote-reply selection
      flashToast(res.dryRun ? 'บันทึกแล้ว (โหมดทดสอบ)' : 'ส่งข้อความให้ลูกค้าแล้ว ✓');
    } catch {
      setError('ส่งข้อความไม่สำเร็จ');
    } finally {
      setFreeSending(false);
    }
  }

  // ✨ button for the already-answered composer: pure grammar/wording polish (no draft, so
  // no regenerate-about-products behavior like the pending composer's rewrite()).
  async function freeRewrite() {
    if (freeRewriting || freeSending || !freeText.trim()) return;
    setFreeRewriting(true);
    setError('');
    setRewriteNote(null);
    try {
      const res = await rewriteText(freeText.trim());
      setFreeText(res.text);
      setRewriteNote(res.note); // staff-only note — shown OUTSIDE the reply box
      setFreeNeedsConfirm(false); // text changed — re-check numbers on send
      flashToast('เรียบเรียงใหม่แล้ว — ตรวจทานก่อนส่ง');
    } catch (e) {
      setError('เรียบเรียงใหม่ไม่สำเร็จ: ' + (e as Error).message);
    } finally {
      setFreeRewriting(false);
    }
  }

  // Add a searched product to the answered-state composer's LOCAL selection (cap 6, no
  // duplicates). No draft exists here, so this does NOT call addProductToDraft — that
  // endpoint requires a pending draft and drives keyword-learning tied to a pending question.
  function addFreeProduct(p: PendingProduct) {
    setFreeProducts((prev) => (prev.length >= 20 || prev.some((x) => x.sku === p.sku) ? prev : [...prev, p]));
  }
  function removeFreeProduct(sku: string) {
    setFreeProducts((prev) => prev.filter((p) => p.sku !== sku));
  }

  // Camera button → native camera on touch devices, webcam modal on desktop.
  function openCamera() {
    const touch = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
    if (touch) cameraRef.current?.click();
    else setCameraOpen(true);
  }

  // Split selected SKUs by which picker row they sit in: cross-sells → upsell hint;
  // direct picks → "this IS the product the customer wants" hint (the AI writes the reply
  // about them). `extra` lets a just-added product be classified before the detail reloads.
  function splitSelected(selected: string[], extra?: { sku: string; role: 'main' | 'cross' }) {
    const crossSet = new Set((detail?.crossSellCandidates ?? []).map((p) => p.sku));
    const directSet = new Set((detail?.productCandidates ?? []).map((p) => p.sku));
    if (extra) (extra.role === 'main' ? directSet : crossSet).add(extra.sku);
    return {
      suggestSkus: selected.filter((s) => crossSet.has(s)),
      mainSkus: selected.filter((s) => directSet.has(s)),
    };
  }

  // Manually add a searched product (main candidate or cross-sell) and select it — no draft
  // yet, so you can add SEVERAL first, then press ✨ to write the reply about them all. The
  // server strengthens the learning link so the AI suggests it next time.
  async function addProduct(sku: string, role: 'main' | 'cross') {
    const msgId = detail?.pendingMessageId;
    if (!msgId) return;
    try {
      await addProductToDraft(msgId, sku, role);
      if (selectedId) await loadDetail(selectedId); // reload to show it (preserves selection)
      setSelectedProductSkus((prev) => (prev.includes(sku) ? prev : [...prev, sku]));
      setSelectionDirty(true); // staff added a product → next ✨ re-drafts about the selection
      flashToast(role === 'main' ? 'เพิ่มสินค้าหลักแล้ว — กด ✨ ให้ AI เรียบเรียง' : 'เพิ่มสินค้าขายคู่แล้ว — กด ✨ ให้ AI เรียบเรียง');
    } catch {
      setError('เพิ่มสินค้าไม่สำเร็จ');
    }
  }

  // Debounced manual product search (name or SKU).
  useEffect(() => {
    const q = prodSearchQ.trim();
    if (!q) { setProdSearchResults([]); setProdSearching(false); return; }
    setProdSearching(true);
    const t = setTimeout(() => {
      searchCatalog(q)
        .then((r) => setProdSearchResults(r.products))
        .catch(() => setProdSearchResults([]))
        .finally(() => setProdSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [prodSearchQ]);

  // Clear the manual product search when switching to a different customer (so one
  // customer's search text/results don't carry over to the next).
  useEffect(() => {
    setProdSearchQ('');
    setProdSearchResults([]);
    setProdSearchOpen(false);
  }, [selectedId]);

  // Esc closes the image lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);
  async function saveQuickReply() {
    if (!qrLabel.trim() || !qrBody.trim() || qrSaving) return;
    setQrSaving(true);
    try {
      await addQuickReply(qrLabel.trim(), qrBody.trim());
      setQrLabel('');
      setQrBody('');
      const { items } = await getQuickReplies();
      setQuickReplies(items);
    } catch {
      setError('บันทึกข้อความสำเร็จรูปไม่สำเร็จ');
    } finally {
      setQrSaving(false);
    }
  }
  async function removeQuickReply(id: string) {
    setQuickReplies((qs) => qs.filter((q) => q.id !== id));
    await deleteQuickReply(id).catch(() => undefined);
  }

  // agentText is passed only by the ✨ button (build on what the staff typed); ร่างใหม่ omits
  // it for a fresh draft from conversation + selected products.
  async function regenerate(agentText?: string) {
    const msgId = detail?.pendingMessageId;
    if (!msgId || sending) return;
    setSending(true);
    setError('');
    const { suggestSkus, mainSkus } = splitSelected(selectedProductSkus);
    try {
      await regenerateDraft(msgId, suggestSkus.length ? suggestSkus : undefined, mainSkus.length ? mainSkus : undefined, agentText?.trim() || undefined);
      if (selectedId) await loadDetail(selectedId); // loadDetail preserves the selection
      flashToast(suggestSkus.length || mainSkus.length ? 'ร่างใหม่แล้ว — ใช้สินค้าที่เลือก' : 'ร่างใหม่แล้ว');
    } catch (e) {
      setError('ร่างใหม่ไม่สำเร็จ: ' + (e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function saveNick() {
    if (nickEdit === null || !selectedId) return;
    const { code, nickname } = nickEdit;
    setNickEdit(null);
    try {
      await setNickname(selectedId, nickname, code);
      await loadDetail(selectedId);
      await refreshLists();
    } catch {
      setError('บันทึกข้อมูลลูกค้าไม่สำเร็จ');
    }
  }

  async function chooseCategory(cat: string) {
    if (!selectedId) return;
    setCatOpen(false);
    try {
      await setCategory(selectedId, cat);
      setDetail((d) => (d ? { ...d, customer: { ...d.customer, category: cat || null } } : d));
      await refreshLists();
    } catch {
      setError('ตั้งหมวดหมู่ไม่สำเร็จ');
    }
  }

  async function chooseStage(stage: string) {
    if (!selectedId) return;
    setStageOpen(false);
    try {
      await setStage(selectedId, stage);
      setDetail((d) => (d ? { ...d, customer: { ...d.customer, stage: stage || null, suggestedStage: null } } : d));
      await refreshLists();
    } catch {
      setError('ตั้งขั้นตอนไม่สำเร็จ');
    }
  }

  async function endChat() {
    if (!selectedId || ending) return;
    setEnding(true);
    try {
      const res = await endSession(selectedId);
      flashToast(res.summary ? 'ตอบแล้ว — เลิกแจ้งเตือนและเก็บความจำแล้ว ✓' : 'ตอบแล้ว — เลิกแจ้งเตือนแล้ว');
      await loadDetail(selectedId); // keep the chat open; it just leaves the "waiting" queue
      await refreshLists();
    } catch {
      setError('ทำเครื่องหมายตอบแล้วไม่สำเร็จ');
    } finally {
      setEnding(false);
    }
  }

  async function promote(id: string) {
    if (promotingId) return; // ignore clicks while another promote is in flight
    setPromotingId(id);
    try {
      const res = await promoteLearned(id).catch(() => null);
      if (res && 'unavailable' in res) {
        setLearnNotice({ kind: 'error', text: 'ระบบสรุปความรู้ไม่พร้อมใช้งานชั่วคราว — รายการยังอยู่ในคิว ลองใหม่อีกครั้งค่ะ' });
        return;
      }
      if (res && 'conflict' in res) {
        flashToast('รายการนี้ถูกดำเนินการไปแล้ว');
        await refreshLearned();
        return;
      }
      await refreshLearned();
      if (res?.skipped) {
        if (res.reason === 'price_content') {
          setLearnNotice({
            kind: 'error',
            text: 'ข้อความที่สรุปยังมีราคา — ยังไม่เพิ่มเข้า KB และรายการยังอยู่ในคิว กรุณาแก้หรือส่งให้เจ้าของตรวจค่ะ',
          });
        } else {
          flashToast('คำตอบนี้เฉพาะลูกค้ารายนี้ — ไม่ได้เพิ่มเป็นความรู้ทั่วไป');
        }
      } else if (res?.kb?.answer) {
        if (res.similarTo) {
          setLearnNotice({
            kind: 'warn',
            text: `เพิ่มเข้า KB แล้ว แต่คล้ายความรู้เดิม (${res.similarTo.similarityPct}%) หมวด "${res.similarTo.category}": "${res.similarTo.answerPreview}" — โปรดตรวจสอบใน KB ว่าซ้ำ/ขัดแย้งกันไหม`,
          });
        } else if (res.dedupUnavailable) {
          flashToast('เพิ่มเข้า KB แล้ว (ข้ามการเช็คซ้ำ — ดัชนีความรู้กำลังอัปเดต)');
        } else {
          const f = res.kb.answer;
          flashToast('เพิ่มเข้า KB แล้ว (สรุปเป็นความรู้): ' + (f.length > 70 ? f.slice(0, 70) + '…' : f));
        }
      } else {
        flashToast('เพิ่มเข้า KB แล้ว — AI จะใช้ครั้งต่อไป');
      }
    } finally {
      setPromotingId(null);
    }
  }
  async function reject(id: string) {
    await rejectLearned(id).catch(() => undefined);
    await refreshLearned();
  }
  async function flag(id: string) {
    const note = window.prompt('หมายเหตุให้เจ้าของ (ไม่บังคับ)', '');
    if (note === null) return;
    setPromotingId(id);
    try {
      await flagLearned(id, note.trim() || undefined);
      await refreshLearned();
      flashToast('ย้ายไปรอเจ้าของตัดสินแล้ว 🚩');
    } catch {
      setLearnNotice({ kind: 'error', text: 'ย้ายรายการไม่สำเร็จ — กรุณาลองใหม่ค่ะ' });
    } finally {
      setPromotingId(null);
    }
  }
  async function resolve(id: string, action: 'promote' | 'reject', kbText?: string) {
    setPromotingId(id);
    try {
      const res = await resolveLearned(id, action === 'promote' ? { action, kbText: kbText ?? '' } : { action });
      if ('priceContent' in res) {
        setLearnNotice({ kind: 'error', text: 'ข้อความ KB ยังมีราคา — ลบราคา/ยอดโปรโมชั่นก่อนอนุมัติค่ะ' });
        return;
      }
      if ('conflict' in res) {
        flashToast('รายการนี้ถูกดำเนินการไปแล้ว');
      } else {
        flashToast(action === 'promote' ? 'เพิ่มข้อความที่เจ้าของอนุมัติเข้า KB แล้ว' : 'ปฏิเสธรายการแล้ว');
      }
      await refreshLearned();
    } catch {
      setLearnNotice({ kind: 'error', text: 'ดำเนินการรายการรอเจ้าของไม่สำเร็จ — กรุณาลองใหม่ค่ะ' });
    } finally {
      setPromotingId(null);
    }
  }

  const draft = detail?.pendingDraft ?? null;
  // "กำลังตอบกลับ" bar — shown above BOTH composers when a customer bubble is selected to
  // quote-reply. Resolves the author + snippet from the loaded messages; ✕ clears the selection.
  const replyingMsg = replyingTo ? detail?.messages.find((m) => m.id === replyingTo) : undefined;
  const replyBar = replyingTo ? (() => {
    const s = quoteSnippet(replyingMsg);
    return (
      <div className="flex items-center gap-2 text-[11px] bg-sky-50 border border-sky-200 rounded-lg px-2 py-1 text-slate-600">
        <CornerUpLeft size={13} className="shrink-0 text-sky-500" />
        <span className="min-w-0 truncate"><span className="font-semibold text-sky-800">กำลังตอบกลับ:</span> {s.author} · «{s.text}»</span>
        <button type="button" onClick={() => setReplyingTo(null)} title="ยกเลิกการตอบกลับ" aria-label="ยกเลิกการตอบกลับ"
          className="ml-auto shrink-0 text-slate-400 hover:text-slate-600"><X size={13} /></button>
      </div>
    );
  })() : null;
  // Both filters are "exclude" style: all selected by default; deselecting a chip hides
  // only that group's customers; unstaged/uncategorized always show. (All = everyone.)
  const displayList = searchResults ?? customers.filter((c) =>
    (c.category == null || categoryFilters.includes(c.category)) &&
    (c.stage == null || stageFilters.includes(c.stage)),
  );
  // This agent's pinned chats — from the FULL customer list so they show regardless of
  // the category/stage filters (only meaningful when NOT searching; search is a flat list).
  const pinnedList = searchResults === null ? customers.filter((c) => pinnedIds.has(c.id)) : [];

  // One customer card — reused in both the "ปักหมุด" section and the normal list.
  function renderCard(c: CustomerLite) {
    const waiting = waitingIds.has(c.id);
    const active = selectedId === c.id;
    const pinned = pinnedIds.has(c.id);
    return (
      <button key={c.id} onClick={() => { setSelectedId(c.id); setMobileShowChat(true); }}
        className={'w-full text-left px-3 py-2 rounded-xl border transition ' + (active ? 'bg-sky-50 border-sky-300' : 'bg-white border-slate-100 hover:bg-slate-50')}>
        <div className="flex items-center gap-2">
          <Avatar src={c.pictureUrl} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="font-medium text-sm truncate">{nameOf(c)}</span>
              {waiting && <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="รอตอบ" />}
              <span className="ml-auto flex items-center gap-1 shrink-0">
                {c.suggestedStage && c.suggestedStage !== c.stage && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title={'AI แนะนำ: ' + c.suggestedStage} />}
                {c.stage && <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700">{c.stage}</span>}
                {c.category && <span className="text-[9px] px-1 py-0.5 rounded bg-sky-100 text-sky-700">{c.category}</span>}
                <span role="button" tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); void togglePin(c.id); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void togglePin(c.id); } }}
                  title={pinned ? 'เลิกปักหมุด' : 'ปักหมุด'} aria-label={pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}
                  className="shrink-0 cursor-pointer">
                  <Pin size={13} className={pinned ? 'fill-sky-500 text-sky-500' : 'text-slate-300 hover:text-sky-500'} />
                </span>
              </span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1"><Clock size={10} /> {fmtTime(c.lastSeen)}</div>
          </div>
        </div>
      </button>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 p-3 sm:p-5 font-sans text-slate-800 overflow-x-hidden max-w-full">
      <div className="max-w-6xl mx-auto">
        {toast && <div className="mb-3 text-sm bg-sky-50 border border-sky-200 text-sky-700 rounded-xl px-3 py-2 flex items-center gap-2"><Check size={15} /> {toast}</div>}
        {lightbox && (
          <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out"
            onClick={() => setLightbox(null)}>
            <img src={lightbox} alt="รูปขยาย" className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
            <button type="button" onClick={() => setLightbox(null)} aria-label="ปิด"
              className="absolute top-3 right-3 text-white/80 hover:text-white"><X size={30} /></button>
          </div>
        )}
        {financeMsg && (
          <FinanceModal
            messageId={financeMsg}
            onClose={() => setFinanceMsg(null)}
            onSent={(corrected) => {
              setDetail((d) => (d ? { ...d, messages: d.messages.map((m) => (m.id === financeMsg ? { ...m, financeSentAt: new Date().toISOString() } : m)) } : d));
              setFinanceMsg(null);
              flashToast(corrected ? 'ส่งให้การเงินแล้ว — แจ้งแอดมินตรวจสอบยอด ✓' : 'ส่งให้การเงินแล้ว ✓');
            }}
          />
        )}
        <div className="grid md:grid-cols-[300px_1fr] gap-4 h-[calc(100dvh-2.5rem)]">
          {/* LEFT: icon bar (top) + queue (bottom). Hidden on mobile once a chat is open
              (mobileShowChat) so only one pane shows at a time; always shown at md+. */}
          <div className={(mobileShowChat ? 'hidden' : 'flex') + ' md:flex flex-col gap-3 min-h-0'}>
            {/* icon bar */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex items-center gap-1 px-2 py-2 shrink-0">
              <AppSwitcher agent={agent} />
              {/* Stacked mode toggle: current mode's icon large + the other mode as a small
                  corner badge; click to flip console <-> learning. Keeps the learning-count badge. */}
              <button type="button"
                onClick={() => setView((v) => (v === 'learning' ? 'console' : 'learning'))}
                title={view === 'learning' ? 'โหมดการเรียนรู้ — คลิกเพื่อสลับไปคอนโซล' : 'โหมดคอนโซล — คลิกเพื่อสลับไปการเรียนรู้'}
                className="relative p-2 rounded-xl bg-sky-600 text-white hover:bg-sky-700">
                {view === 'learning' ? <GraduationCap size={19} /> : <MessageSquare size={19} />}
                <span className="absolute -bottom-1 -left-1 bg-white rounded-full p-0.5 text-sky-600 flex shadow-sm">
                  {view === 'learning' ? <MessageSquare size={10} /> : <GraduationCap size={10} />}
                </span>
                {learned.length + flaggedLearned.length > 0 && <span className="absolute -top-0.5 -right-0.5 text-[10px] bg-amber-400 text-white rounded-full px-1 leading-tight">{learned.length + flaggedLearned.length}</span>}
              </button>
              <div className="flex-1" />
              <button type="button"
                onClick={() => setSoundOn((v) => { const nv = !v; localStorage.setItem('minerva_sound_off', nv ? '0' : '1'); return nv; })}
                title={soundOn ? 'เสียงแจ้งเตือน: เปิด (คลิกเพื่อปิด)' : 'เสียงแจ้งเตือน: ปิด (คลิกเพื่อเปิด)'}
                className={'p-2 rounded-xl hover:bg-slate-100 ' + (soundOn ? 'text-sky-600' : 'text-slate-300')}>
                {soundOn ? <Volume2 size={17} /> : <VolumeX size={17} />}
              </button>
              {PORTAL_URL && (
                <a href={PORTAL_URL} title="กลับพอร์ทัล Pantheon" className="p-2 rounded-xl text-slate-400 hover:text-violet-600 hover:bg-slate-100"><Crown size={17} /></a>
              )}
              <span title={agent.name + (agent.role === 'supervisor' ? ' (หัวหน้า)' : '')}
                className="relative w-8 h-8 rounded-full bg-sky-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                {agent.name.replace(/^คุณ/, '').charAt(0)}
                {agent.role === 'supervisor' && <span className="absolute -bottom-1 -right-1 bg-white rounded-full text-sky-600 flex"><ShieldCheck size={12} /></span>}
              </span>
              <button onClick={logout} title="ออกจากระบบ" className="p-2 rounded-xl text-slate-400 hover:text-rose-500 hover:bg-slate-100"><LogOut size={17} /></button>
            </div>
            {/* queue */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col flex-1 min-h-0">
              <div className="px-4 py-3 bg-sky-700 text-white rounded-t-2xl font-semibold flex items-center gap-2">
                <Inbox size={18} /> คิวลูกค้า
                <span className="ml-auto text-xs bg-sky-800 px-2 py-0.5 rounded-full">{waitingIds.size} รอตอบ</span>
              </div>
              <div className="px-2 pt-2 shrink-0">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="ค้นหาชื่อเล่น / ชื่อลูกค้า…"
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" />
                </div>
              </div>
              <div className="px-2 pt-2 pb-1 shrink-0 flex flex-wrap gap-1">
                <button onClick={() => setCategoryFilters((fs) => (fs.length === CATEGORIES.length ? [] : [...CATEGORIES]))}
                  className={'text-[10px] px-1.5 py-0.5 rounded-full border ' + (categoryFilters.length === CATEGORIES.length ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50')}>
                  ทั้งหมด
                </button>
                {CATEGORIES.map((cat) => (
                  <button key={cat} onClick={() => setCategoryFilters((fs) => (fs.includes(cat) ? fs.filter((f) => f !== cat) : [...fs, cat]))}
                    className={'text-[10px] px-1.5 py-0.5 rounded-full border ' + (categoryFilters.includes(cat) ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50')}>
                    {cat}
                  </button>
                ))}
              </div>
              <div className="px-2 pb-1 shrink-0 flex flex-wrap gap-1">
                <button onClick={() => setStageFilters((fs) => (fs.length === STAGES.length ? [] : [...STAGES]))}
                  className={'text-[10px] px-1.5 py-0.5 rounded-full border ' + (stageFilters.length === STAGES.length ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50')}>
                  ทั้งหมด
                </button>
                {STAGES.map((st) => (
                  <button key={st} onClick={() => setStageFilters((fs) => (fs.includes(st) ? fs.filter((f) => f !== st) : [...fs, st]))}
                    className={'text-[10px] px-1.5 py-0.5 rounded-full border ' + (stageFilters.includes(st) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50')}>
                    {st}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {searchResults !== null && searchResults.length > 0 && (
                  <div className="px-1 pb-1 text-[11px] text-slate-400">ผลค้นหา {searchResults.length} ราย (รวมแชทที่จบแล้ว)</div>
                )}
                {displayList.length === 0 && pinnedList.length === 0 && (
                  <div className="text-slate-400 text-sm text-center py-10 px-3">
                    {searchResults !== null ? 'ไม่พบลูกค้าที่ตรงกับคำค้นหา' : (
                      <>ยังไม่มีข้อความจากลูกค้า<br /><span className="text-xs">เมื่อมีข้อความเข้า LINE จะปรากฏที่นี่แบบเรียลไทม์</span></>
                    )}
                  </div>
                )}
                {/* "ปักหมุด" — this agent's pinned chats, pinned above the queue regardless of
                    answered-state or category/stage filters. Only when not searching. */}
                {searchResults === null && pinnedList.length > 0 && (
                  <div className="mb-1">
                    <button type="button" onClick={() => setPinnedOpen((v) => !v)}
                      className="w-full flex items-center gap-1 px-1 py-1 text-[11px] font-semibold text-sky-700">
                      <Pin size={12} className="fill-sky-500 text-sky-500" />
                      <span>ปักหมุด ({pinnedList.length})</span>
                      {pinnedOpen ? <ChevronUp size={12} className="ml-auto text-slate-400" /> : <ChevronDown size={12} className="ml-auto text-slate-400" />}
                    </button>
                    {pinnedOpen && <div className="space-y-1">{pinnedList.map((c) => renderCard(c))}</div>}
                    <div className="border-b border-slate-200 mt-1" />
                  </div>
                )}
                {(searchResults === null ? displayList.filter((c) => !pinnedIds.has(c.id)) : displayList).map((c) => renderCard(c))}
              </div>
            </div>
          </div>

          {/* RIGHT: conversation (or learning). Shown on mobile only once a chat is open
              (mobileShowChat); always shown at md+. */}
          <div className={(mobileShowChat ? 'block' : 'hidden') + ' md:block min-h-0 overflow-y-auto'}>
            {view === 'audit' ? (
              <FinanceAuditView audits={audits} onResolve={doResolveAudit} onRefresh={() => { void refreshAudits(); }} />
            ) : view === 'learning' ? (
              <LearningView
                learned={learned}
                flagged={flaggedLearned}
                isSupervisor={agent.role === 'supervisor'}
                onPromote={promote}
                onReject={reject}
                onFlag={flag}
                onResolve={resolve}
                promotingId={promotingId}
                notice={learnNotice}
                onDismissNotice={() => setLearnNotice(null)}
              />
            ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full">
              <div className="px-4 py-2.5 bg-sky-600 text-white rounded-t-2xl font-semibold flex items-center gap-2">
                {/* mobile-only: back to the queue list (keeps selectedId — desktop stays selected) */}
                <button type="button" onClick={() => setMobileShowChat(false)}
                  title="กลับไปที่คิว" aria-label="กลับไปที่คิว"
                  className="md:hidden shrink-0 -ml-1 p-1.5 rounded-lg text-white/90 hover:text-white hover:bg-white/10">
                  <ArrowLeft size={18} />
                </button>
                <div className="flex flex-wrap md:flex-nowrap items-center gap-x-2 gap-y-1 min-w-0 flex-1">
                  {detail
                    ? <Avatar src={detail.customer.pictureUrl} size={28} />
                    : <MessageSquare size={18} className="shrink-0" />}
                  {nickEdit !== null ? (
                    <div className="flex items-center gap-1">
                      <input autoFocus value={nickEdit.code} onChange={(e) => setNickEdit({ ...nickEdit, code: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveNick(); if (e.key === 'Escape') setNickEdit(null); }}
                        placeholder="รหัส" title="รหัสลูกค้า (Express)"
                        className="text-slate-800 bg-white text-sm rounded-md px-2 py-0.5 w-16 outline-none" />
                      <input value={nickEdit.nickname} onChange={(e) => setNickEdit({ ...nickEdit, nickname: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveNick(); if (e.key === 'Escape') setNickEdit(null); }}
                        placeholder="ชื่อลูกค้า"
                        className="text-slate-800 bg-white text-sm rounded-md px-2 py-0.5 w-36 outline-none" />
                      <button onMouseDown={(e) => e.preventDefault()} onClick={saveNick} title="บันทึก" className="text-white/90 hover:text-white shrink-0"><CheckCircle2 size={16} /></button>
                    </div>
                  ) : (
                    <>
                      <span className="shrink-0">{detail ? nameOf(detail.customer) : 'บทสนทนา'}</span>
                      {detail && <button onClick={() => setNickEdit({ code: detail.customer.code ?? '', nickname: detail.customer.nickname ?? '' })} title="แก้รหัส / ชื่อ" className="opacity-80 hover:opacity-100 shrink-0"><Pencil size={13} /></button>}
                      {detail && (
                        <div className="relative shrink-0">
                          <button type="button" onClick={() => setCatOpen((v) => !v)}
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white flex items-center gap-0.5">
                            {detail.customer.category || 'หมวด'} <ChevronDown size={10} />
                          </button>
                          {catOpen && (
                            <>
                              <div className="fixed inset-0 z-20" onClick={() => setCatOpen(false)} />
                              <div className="absolute top-full mt-1 left-0 z-30 w-24 bg-white border border-slate-200 rounded-lg shadow-lg p-1 text-slate-700">
                                {CATEGORIES.map((cat) => (
                                  <button key={cat} type="button" onClick={() => chooseCategory(cat)}
                                    className={'w-full text-left text-xs px-2 py-1 rounded hover:bg-sky-50 ' + (detail.customer.category === cat ? 'bg-sky-50 font-semibold' : '')}>
                                    {cat}
                                  </button>
                                ))}
                                <button type="button" onClick={() => chooseCategory('')}
                                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-slate-50 text-slate-400">ไม่ระบุ</button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {detail && (
                        <div className="relative shrink-0">
                          <button type="button" onClick={() => setStageOpen((v) => !v)}
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/20 hover:bg-white/30 text-white flex items-center gap-0.5">
                            {detail.customer.stage || 'ขั้นตอน'} <ChevronDown size={10} />
                          </button>
                          {stageOpen && (
                            <>
                              <div className="fixed inset-0 z-20" onClick={() => setStageOpen(false)} />
                              <div className="absolute top-full mt-1 left-0 z-30 w-28 bg-white border border-slate-200 rounded-lg shadow-lg p-1 text-slate-700">
                                {STAGES.map((st) => (
                                  <button key={st} type="button" onClick={() => chooseStage(st)}
                                    className={'w-full text-left text-xs px-2 py-1 rounded hover:bg-indigo-50 ' + (detail.customer.stage === st ? 'bg-indigo-50 font-semibold' : '')}>
                                    {st}
                                  </button>
                                ))}
                                <button type="button" onClick={() => chooseStage('')}
                                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-slate-50 text-slate-400">ไม่ระบุ</button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {detail && detail.customer.suggestedStage && detail.customer.suggestedStage !== detail.customer.stage && (
                        <button type="button" onClick={() => chooseStage(detail.customer.suggestedStage!)}
                          title="AI แนะนำขั้นตอนนี้จากบทสนทนา — กดเพื่อยืนยัน"
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-300 hover:bg-amber-200 text-amber-900 flex items-center gap-0.5 shrink-0">
                          💡 {detail.customer.suggestedStage} ✓
                        </button>
                      )}
                      {detail?.oaRead && (() => {
                        const rs = oaReadState(detail.oaRead.readLabel, detail.oaRead.readSeenAt, detail.messages);
                        return (
                          <span className="flex items-center gap-1 shrink-0">
                            {rs && (rs.unread ? (
                              <span title={`มีข้อความที่ส่งหลังจากลูกค้าอ่านล่าสุด (อ่านถึง ${rs.readTime}) — สถานะจะอัปเดตเมื่อเปิดแชทนี้ใน LINE OA อีกครั้ง`}
                                className="flex items-center gap-0.5 bg-amber-400/90 text-amber-950 text-[10px] font-medium rounded px-1.5 py-0.5">
                                <Clock size={11} /> ยังไม่อ่าน
                                {detail.oaRead.readSeenAt && <span className="opacity-70"> · ซิงก์ {syncAgo(detail.oaRead.readSeenAt)}</span>}
                              </span>
                            ) : (
                              <span title="สถานะอ่านจาก LINE OA (ซิงก์ผ่านส่วนขยาย)"
                                className="flex items-center gap-0.5 bg-white/20 text-white text-[10px] rounded px-1.5 py-0.5">
                                <Eye size={11} /> อ่านแล้ว {rs.readTime}
                                {detail.oaRead.readSeenAt && <span className="opacity-80"> · ซิงก์ {syncAgo(detail.oaRead.readSeenAt)}</span>}
                              </span>
                            ))}
                            <a href={`https://chat.line.biz/${LINE_OA_ID}/chat/${detail.oaRead.oaChatId}`}
                              target="_blank" rel="noreferrer" title="เปิดแชทนี้ใน LINE OA Manager"
                              className="opacity-80 hover:opacity-100"><ExternalLink size={12} /></a>
                          </span>
                        );
                      })()}
                      {detail && <span className="text-[11px] font-normal text-sky-100 truncate min-w-0 max-w-full">· {detail.customer.lineUserId}</span>}
                      {detail && <span className="text-[11px] font-normal text-sky-100 shrink-0">· ถาม {detail.stats.questions} · ตอบ {detail.stats.replies}</span>}
                    </>
                  )}
                </div>
                {detail && (
                  <button onClick={endChat} disabled={ending}
                    className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white flex items-center gap-1 disabled:opacity-50"
                    title="ลูกค้าได้รับคำตอบแล้ว (เช่น ตอบผ่าน LINE OA โดยตรง) — นำออกจากคิว และ AI จะตั้งต้นจากข้อความถัดไปเท่านั้น">
                    {ending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} ตอบแล้ว
                  </button>
                )}
              </div>

              {!selectedId ? (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm p-6 text-center">
                  <Inbox size={36} className="mb-3 text-slate-300" /> เลือกลูกค้าจากคิวด้านซ้ายเพื่อดูบทสนทนาและร่างคำตอบ
                </div>
              ) : (
                <>
                  <div className="flex flex-col md:flex-row flex-1 min-h-0">
                    {/* LEFT: conversation history. Stacks above the composer below md (phones); the
                        md: classes keep the desktop split-pane byte-identical. */}
                    <div className="flex flex-col flex-1 min-w-0 min-h-0 border-b md:border-b-0 md:border-r border-slate-200">
                  <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-sky-50"
                    onClick={(e) => { const img = (e.target as HTMLElement).closest('img[data-zoom]') as HTMLImageElement | null; if (img) setLightbox(img.currentSrc || img.src); }}>
                    {loadingDetail && !detail && <div className="flex justify-center py-8 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>}
                    {detail?.messages.map((m: Message) => {
                      // Quoted snippet (both directions): the message THIS bubble quote-replies to.
                      const quoted = m.quotedMessageId
                        ? detail.messages.find((q) => q.id === m.quotedMessageId)
                        : undefined;
                      const quotedSnip = m.quotedMessageId ? quoteSnippet(quoted) : null;
                      // Tap to reply: a quotable text/sticker bubble gets a real LINE quote; any
                      // bubble with an attachment (incl. pictures, ours or the customer's) is also
                      // tappable for a console-side reply linkage (no LINE quoteToken for those).
                      const canReply = !!m.quotable || !!m.attachmentType;
                      const isReplying = replyingTo === m.id;
                      return (
                      <div key={m.id} className={m.role === 'customer' ? 'flex justify-start' : 'flex justify-end'}>
                        <div onClick={canReply ? () => setReplyingTo((cur) => (cur === m.id ? null : m.id)) : undefined}
                          title={canReply ? 'แตะเพื่อตอบกลับข้อความนี้' : undefined}
                          className={'max-w-[78%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ' +
                          (m.role === 'customer' ? 'bg-white border border-slate-200 rounded-tl-sm' : 'bg-sky-600 text-white rounded-tr-sm') +
                          (canReply ? ' cursor-pointer' : '') +
                          (isReplying ? ' ring-2 ring-sky-400' : '')}>
                          {quotedSnip && (
                            <div className={'mb-1 pl-2 border-l-2 text-[11px] leading-snug ' +
                              (m.role === 'customer' ? 'border-slate-300 text-slate-500' : 'border-sky-200/70 text-sky-100/90')}>
                              <span className="font-semibold">{quotedSnip.author}</span>
                              <span className="opacity-90"> · {quotedSnip.text}</span>
                            </div>
                          )}
                          <MessageBody m={m} />
                          <div className={'text-[10px] mt-0.5 flex items-baseline justify-between gap-3 ' + (m.role === 'customer' ? 'text-slate-400' : 'text-sky-100')}>
                            <span className="flex items-center gap-1 flex-wrap">
                              {fmtTime(m.createdAt)}
                              {canReply && <CornerUpLeft size={11} className={isReplying ? 'text-sky-500' : 'text-slate-300'} />}
                              {/* แจ้งการเงิน sits inline right after the time + reply icon — customer images
                                  AND PDF file messages (bank apps export slips as PDF; the api's isSlipCapable
                                  mirrors this exact condition). */}
                              {m.role === 'customer' && (m.attachmentType === 'image' ||
                                (m.attachmentType === 'file' && (m.attachmentRef === 'application/pdf' || (m.attachmentName ?? '').toLowerCase().endsWith('.pdf')))) && (
                                m.financeSentAt
                                  ? <span className="text-sky-600 font-medium flex items-center gap-1"><CheckCircle2 size={11} /> ส่งการเงินแล้ว</span>
                                  : <button type="button" onClick={(e) => { e.stopPropagation(); setFinanceMsg(m.id); }}
                                      className="px-2 py-0.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 font-medium flex items-center gap-1">
                                      <Banknote size={12} /> แจ้งการเงิน
                                    </button>
                              )}
                            </span>
                            {m.role !== 'customer' && m.agentName && <span className="text-sky-100/80">— {m.agentName}</span>}
                          </div>
                        </div>
                      </div>
                      );
                    })}
                    <div ref={endRef} />
                  </div>
                    </div>{/* /LEFT column */}

                    {/* mobile-only ✨ trigger: opens the AI panel (memory + draft + products) as a
                        bottom-sheet drawer. Hidden once the drawer is open; irrelevant at md+. */}
                    {!aiDrawerOpen && (
                      <button type="button" onClick={() => setAiDrawerOpen(true)}
                        title="เปิดแผงร่างคำตอบ / สินค้า" aria-label="เปิดแผงร่างคำตอบ / สินค้า"
                        className="md:hidden fixed bottom-5 right-5 z-20 w-12 h-12 rounded-full bg-sky-600 hover:bg-sky-700 text-white shadow-lg flex items-center justify-center">
                        <Sparkles size={20} />
                      </button>
                    )}
                    {/* mobile-only dim backdrop behind the open drawer; tap to close */}
                    {aiDrawerOpen && (
                      <div className="fixed inset-0 bg-black/30 z-30 md:hidden" onClick={() => setAiDrawerOpen(false)} />
                    )}

                    {/* RIGHT: drafting / composer (long-term memory + AI draft + product picker).
                        Full width on phones as a hidden-by-default bottom-sheet drawer (aiDrawerOpen);
                        the md: classes restore the normal static 42%-split column on desktop. */}
                    <div className={
                      'flex flex-col w-full md:w-[42%] md:min-w-[360px] min-h-0 overflow-y-auto bg-white ' +
                      'fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] rounded-t-2xl shadow-2xl transition-transform ' +
                      (aiDrawerOpen ? 'translate-y-0 ' : 'translate-y-full ') +
                      'md:static md:inset-auto md:z-auto md:max-h-none md:rounded-none md:shadow-none md:translate-y-0 md:transition-none'
                    }>
                      {/* mobile-only drag handle + close button for the bottom-sheet drawer */}
                      <div className="md:hidden relative shrink-0 flex items-center justify-center py-2 border-b border-slate-100">
                        <div className="w-10 h-1 rounded-full bg-slate-300" />
                        <button type="button" onClick={() => setAiDrawerOpen(false)} title="ปิด" aria-label="ปิด"
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                          <X size={18} />
                        </button>
                      </div>
                  {detail?.memory?.summary && (
                    <div className="shrink-0 bg-slate-50 border-b border-slate-100 p-2">
                      <div className="text-[11px] text-sky-800 bg-sky-50 border border-sky-200 rounded-lg p-2">
                        <span className="font-bold flex items-center gap-1 mb-0.5"><Brain size={12} /> ความจำระยะยาว</span>
                        {detail.memory.summary}
                      </div>
                    </div>
                  )}

                  {/* shared photo inputs + desktop webcam modal (used by both composers) */}
                  <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={(e) => { void captureAndSend(e.target.files?.[0] ?? undefined); e.currentTarget.value = ''; }} />
                  <input ref={fileRef} type="file" className="hidden"
                    onChange={(e) => { void onPickFile(e.target.files?.[0] ?? undefined); e.currentTarget.value = ''; }} />
                  {cameraOpen && (
                    <CameraCapture
                      onCapture={(f) => { setCameraOpen(false); void captureAndSend(f); }}
                      onClose={() => setCameraOpen(false)}
                    />
                  )}

                  {/* draft composer */}
                  {draft ? (
                    <div className="border-t border-slate-200 p-3 space-y-2 bg-white flex flex-col flex-1 min-h-0">
                      <div className="flex items-start gap-2">
                        {draft.note && detailsOpen && <span className="text-xs text-slate-500 leading-relaxed pt-1">{draft.note}</span>}
                        <button type="button" onClick={() => setProdSearchOpen((v) => !v)}
                          title="ค้นหา / เพิ่มสินค้าเอง" aria-label="ค้นหา / เพิ่มสินค้าเอง"
                          className={'ml-auto shrink-0 p-1 rounded-lg hover:bg-slate-100 ' + (prodSearchOpen ? 'text-sky-600 bg-sky-50' : 'text-slate-400 hover:text-slate-600')}>
                          <Search size={16} />
                        </button>
                        <button type="button" onClick={() => setDetailsOpen((v) => !v)}
                          title={detailsOpen ? 'ซ่อนรายละเอียด (ดูบทสนทนามากขึ้น)' : 'แสดงรายละเอียด'}
                          className="shrink-0 p-1 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                          {detailsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </div>
                      {detailsOpen && (
                        <PhotoStrip
                          direct={detail?.productCandidates ?? []}
                          cross={detail?.crossSellCandidates ?? []}
                          selected={selectedProductSkus}
                          onToggle={toggleProductSku}
                        />
                      )}
                      {prodSearchOpen && (
                            <div className="space-y-1.5 border border-slate-200 rounded-xl p-2 bg-slate-50">
                              <div className="relative">
                                <input value={prodSearchQ} onChange={(e) => setProdSearchQ(e.target.value)}
                                  placeholder="พิมพ์ชื่อสินค้า หรือ SKU…"
                                  className="w-full px-2 py-1.5 pr-7 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-sky-400" />
                                {prodSearchQ && (
                                  <button type="button" onClick={() => setProdSearchQ('')} title="ล้าง" aria-label="ล้างคำค้นหา"
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                    <X size={14} />
                                  </button>
                                )}
                              </div>
                              {prodSearching && <div className="text-[11px] text-slate-400 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> กำลังค้นหา…</div>}
                              <div className="max-h-56 overflow-y-auto space-y-1">
                                {prodSearchResults.map((p) => (
                                  <div key={p.sku} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-1">
                                    {p.photoSku
                                      ? <img src={`${API_URL}/content/product/${p.photoSku}`} alt="" className="w-9 h-9 object-contain shrink-0 rounded bg-white"
                                          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                                      : <div className="w-9 h-9 shrink-0 rounded bg-slate-100 text-[8px] text-slate-400 flex items-center justify-center text-center">ไม่มีรูป</div>}
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[11px] font-medium text-slate-800 truncate">{[p.nameEn, p.nameTh].filter(Boolean).join(' / ') || flatSku(p.sku)}</div>
                                      <div className="text-[10px] text-slate-500 truncate">
                                        {flatSku(p.sku)} · {p.price > 0 ? `${p.price.toLocaleString()} บาท` : '—'}
                                        {p.stock != null && (() => {
                                          const out = p.stock <= 0;
                                          const lowFlag = !out && (p.low ?? (p.reorderPoint == null && p.stock <= 5));
                                          return <span className={out ? 'text-rose-600' : lowFlag ? 'text-amber-600' : 'text-sky-600'}> · {out ? 'หมด' : `${lowFlag ? 'ใกล้หมด ' : ''}คงเหลือ ${p.stock}`}</span>;
                                        })()}
                                      </div>
                                    </div>
                                    <button type="button" onClick={() => addProduct(p.sku, 'main')} title="เพิ่มเป็นสินค้าหลัก"
                                      className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white">หลัก</button>
                                    <button type="button" onClick={() => addProduct(p.sku, 'cross')} title="เพิ่มเป็นสินค้าขายคู่"
                                      className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 text-white">ขายคู่</button>
                                  </div>
                                ))}
                                {prodSearchQ.trim() && !prodSearching && !prodSearchResults.length && (
                                  <div className="text-[11px] text-slate-400 px-1 py-2 text-center">ไม่พบสินค้า</div>
                                )}
                              </div>
                            </div>
                      )}
                      {replyBar}
                      <textarea value={editText} onChange={(e) => { setEditText(e.target.value); setNeedsConfirm(false); setRewriteNote(null); }} rows={4}
                        className="w-full flex-1 min-h-[120px] p-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 resize-none" placeholder="พิมพ์/แก้คำตอบก่อนส่ง… (วางรูป Ctrl+V ได้)" />
                      {rewriteNote && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 flex items-start gap-1.5">
                          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                          <span><span className="font-semibold">หมายเหตุจาก AI</span> (ไม่ส่งให้ลูกค้า): {rewriteNote}</span>
                        </div>
                      )}
                      {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}
                      {upload && (
                        <div className="flex items-center gap-2 bg-sky-50 border border-sky-200 rounded-lg pl-1 pr-2 py-1 text-xs w-fit">
                          {upload.previewUrl
                            ? <img src={upload.previewUrl} alt="" className="w-8 h-8 object-cover rounded" />
                            : <Paperclip size={14} className="text-sky-700" />}
                          <span className="truncate max-w-[180px] text-sky-800">{upload.fileName}</span>
                          <button type="button" onClick={() => setUpload(null)} className="text-slate-400 hover:text-rose-500"><X size={14} /></button>
                        </div>
                      )}
                      <div className="grid grid-cols-[auto_auto_auto_auto_1fr_1fr_1fr] gap-2">
                        <button type="button" disabled={uploading || sending || rewriting} onClick={openCamera}
                          title="ถ่ายรูปแล้วส่ง" aria-label="ถ่ายรูปแล้วส่ง"
                          className="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center disabled:opacity-50">
                          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
                        </button>
                        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || sending || rewriting}
                          title="แนบรูป/ไฟล์" aria-label="แนบรูป/ไฟล์"
                          className="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center disabled:opacity-50">
                          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
                        </button>
                        <QuickReplyMenu
                          quickReplies={quickReplies} qrOpen={qrOpen} setQrOpen={setQrOpen} qrSending={qrSending} quickSend={quickSend}
                          qrManage={qrManage} setQrManage={setQrManage} qrLabel={qrLabel} setQrLabel={setQrLabel} qrBody={qrBody} setQrBody={setQrBody}
                          qrSaving={qrSaving} saveQuickReply={saveQuickReply} removeQuickReply={removeQuickReply}
                        />
                        <button type="button" onClick={clearMinervaDrafts}
                          title="ล้างร่างของ Minerva ทั้งหมด" aria-label="ล้างร่างของ Minerva ทั้งหมด"
                          className="px-2 py-2 rounded-xl bg-slate-100 hover:bg-rose-100 text-slate-600 hover:text-rose-600 flex items-center justify-center">
                          <Eraser size={16} />
                        </button>
                        <button onClick={() => regenerate()} disabled={sending || rewriting}
                          title="ร่างคำตอบใหม่จากบทสนทนา + สินค้าที่เลือก (ไม่ใช้ข้อความที่พิมพ์ในกล่อง)"
                          className="min-w-0 px-2 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
                          <RefreshCw size={17} />
                        </button>
                        <button onClick={rewrite} disabled={rewriting || sending || (!editText.trim() && !(selectionDirty && selectedProductSkus.length))}
                          title="ให้ AI ช่วยแก้ไวยากรณ์/เรียบเรียง โดยใช้ข้อความที่พิมพ์ + สินค้าที่เลือก + บทสนทนา (ถ้าเพิ่งเลือกสินค้า จะร่างใหม่โดยรวมข้อมูลสินค้าเข้ากับข้อความที่พิมพ์)"
                          className="min-w-0 px-2 py-2 rounded-xl bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
                          {rewriting ? <Loader2 size={17} className="animate-spin" /> : <Wand2 size={17} />}
                        </button>
                        <button onClick={approve} disabled={sending || rewriting || !editText.trim()}
                          title={needsConfirm ? 'ยืนยันส่ง (คำตอบมีราคา)' : 'อนุมัติและส่งให้ลูกค้า'}
                          className={'min-w-0 px-2 py-2 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 ' + (needsConfirm ? 'bg-amber-600 hover:bg-amber-700' : 'bg-sky-600 hover:bg-sky-700')}>
                          {sending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
                        </button>
                      </div>
                    </div>
                  ) : detail && detail.messages.length > 0 ? (
                    <div className="border-t border-slate-200 p-3 space-y-2 bg-white flex flex-col flex-1 min-h-0">
                      <div className="flex items-start gap-2">
                        <div className={'text-[11px] ' + ((detail.generating || forceDrafting)
                          ? 'text-indigo-600'
                          : detail.draftQueued ? 'text-amber-600' : 'text-slate-400')}>
                          {(detail.generating || forceDrafting)
                            ? '✨ Minerva กำลังร่างคำตอบ…'
                            : detail.draftQueued
                              ? '⏳ ลูกค้าส่งข้อความใหม่มา — ระบบรอข้อความเพิ่มเติมสักครู่ก่อนร่าง (กด ↻ เพื่อร่างทันที)'
                              : 'ลูกค้าได้รับคำตอบล่าสุดแล้ว — ส่งข้อความเพิ่มเติม แนบรูปสินค้า หรือใช้ ✨ ช่วยเรียบเรียงได้'}
                        </div>
                        <button type="button" onClick={() => setProdSearchOpen((v) => !v)}
                          title="ค้นหา / แนบรูปสินค้า" aria-label="ค้นหา / แนบรูปสินค้า"
                          className={'ml-auto shrink-0 p-1 rounded-lg hover:bg-slate-100 ' + (prodSearchOpen ? 'text-sky-600 bg-sky-50' : 'text-slate-400 hover:text-slate-600')}>
                          <Search size={16} />
                        </button>
                      </div>
                      {freeProducts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {freeProducts.map((p) => (
                            <div key={p.sku} className="flex items-center gap-1.5 bg-sky-50 border border-sky-200 rounded-lg pl-1 pr-1.5 py-1 text-xs">
                              {p.photoSku
                                ? <img src={`${API_URL}/content/product/${p.photoSku}`} alt="" className="w-7 h-7 object-contain rounded bg-white"
                                    onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                                : <div className="w-7 h-7 shrink-0 rounded bg-slate-100 text-[7px] text-slate-400 flex items-center justify-center text-center">ไม่มีรูป</div>}
                              <span className="truncate max-w-[120px] text-sky-800">{[p.nameEn, p.nameTh].filter(Boolean).join(' / ') || flatSku(p.sku)}</span>
                              <button type="button" onClick={() => removeFreeProduct(p.sku)} className="text-slate-400 hover:text-rose-500"><X size={13} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                      {prodSearchOpen && (
                        <div className="space-y-1.5 border border-slate-200 rounded-xl p-2 bg-slate-50">
                          <div className="relative">
                            <input value={prodSearchQ} onChange={(e) => setProdSearchQ(e.target.value)}
                              placeholder="พิมพ์ชื่อสินค้า หรือ SKU…"
                              className="w-full px-2 py-1.5 pr-7 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-sky-400" />
                            {prodSearchQ && (
                              <button type="button" onClick={() => setProdSearchQ('')} title="ล้าง" aria-label="ล้างคำค้นหา"
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                <X size={14} />
                              </button>
                            )}
                          </div>
                          {prodSearching && <div className="text-[11px] text-slate-400 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> กำลังค้นหา…</div>}
                          <div className="max-h-56 overflow-y-auto space-y-1">
                            {prodSearchResults.map((p) => (
                              <div key={p.sku} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-1">
                                {p.photoSku
                                  ? <img src={`${API_URL}/content/product/${p.photoSku}`} alt="" className="w-9 h-9 object-contain shrink-0 rounded bg-white"
                                      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                                  : <div className="w-9 h-9 shrink-0 rounded bg-slate-100 text-[8px] text-slate-400 flex items-center justify-center text-center">ไม่มีรูป</div>}
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] font-medium text-slate-800 truncate">{[p.nameEn, p.nameTh].filter(Boolean).join(' / ') || flatSku(p.sku)}</div>
                                  <div className="text-[10px] text-slate-500 truncate">
                                    {flatSku(p.sku)} · {p.price > 0 ? `${p.price.toLocaleString()} บาท` : '—'}
                                    {p.stock != null && (() => {
                                      const out = p.stock <= 0;
                                      const lowFlag = !out && (p.low ?? (p.reorderPoint == null && p.stock <= 5));
                                      return <span className={out ? 'text-rose-600' : lowFlag ? 'text-amber-600' : 'text-sky-600'}> · {out ? 'หมด' : `${lowFlag ? 'ใกล้หมด ' : ''}คงเหลือ ${p.stock}`}</span>;
                                    })()}
                                  </div>
                                </div>
                                <button type="button" onClick={() => addFreeProduct(p)} title="เลือกสินค้านี้"
                                  className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white">เลือก</button>
                              </div>
                            ))}
                            {prodSearchQ.trim() && !prodSearching && !prodSearchResults.length && (
                              <div className="text-[11px] text-slate-400 px-1 py-2 text-center">ไม่พบสินค้า</div>
                            )}
                          </div>
                        </div>
                      )}
                      {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}
                      {upload && (
                        <div className="flex items-center gap-2 bg-sky-50 border border-sky-200 rounded-lg pl-1 pr-2 py-1 text-xs w-fit">
                          {upload.previewUrl
                            ? <img src={upload.previewUrl} alt="" className="w-8 h-8 object-cover rounded" />
                            : <Paperclip size={14} className="text-sky-700" />}
                          <span className="truncate max-w-[180px] text-sky-800">{upload.fileName}</span>
                          <button type="button" onClick={() => setUpload(null)} className="text-slate-400 hover:text-rose-500"><X size={14} /></button>
                        </div>
                      )}
                      {replyBar}
                      <textarea value={freeText} onChange={(e) => { setFreeText(e.target.value); setFreeNeedsConfirm(false); setRewriteNote(null); }} rows={3}
                        className="w-full flex-1 min-h-[100px] p-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 resize-none" placeholder="พิมพ์ข้อความถึงลูกค้า… (วางรูป Ctrl+V ได้)" />
                      {rewriteNote && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 flex items-start gap-1.5">
                          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                          <span><span className="font-semibold">หมายเหตุจาก AI</span> (ไม่ส่งให้ลูกค้า): {rewriteNote}</span>
                        </div>
                      )}
                      {/* Same column template + button classes as the pending composer's row so the
                          two states look identical in size. */}
                      <div className="grid grid-cols-[auto_auto_auto_auto_1fr_1fr_1fr] gap-2">
                        <button type="button" disabled={uploading || freeSending} onClick={openCamera}
                          title="ถ่ายรูปแล้วส่งทันที" aria-label="ถ่ายรูปแล้วส่งทันที"
                          className="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center disabled:opacity-50">
                          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
                        </button>
                        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || freeSending}
                          title="แนบรูป/ไฟล์" aria-label="แนบรูป/ไฟล์"
                          className="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center disabled:opacity-50">
                          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
                        </button>
                        <QuickReplyMenu
                          quickReplies={quickReplies} qrOpen={qrOpen} setQrOpen={setQrOpen} qrSending={qrSending} quickSend={quickSend}
                          qrManage={qrManage} setQrManage={setQrManage} qrLabel={qrLabel} setQrLabel={setQrLabel} qrBody={qrBody} setQrBody={setQrBody}
                          qrSaving={qrSaving} saveQuickReply={saveQuickReply} removeQuickReply={removeQuickReply}
                        />
                        <button type="button" onClick={clearMinervaDrafts}
                          title="ล้างร่างของ Minerva ทั้งหมด" aria-label="ล้างร่างของ Minerva ทั้งหมด"
                          className="px-2 py-2 rounded-xl bg-slate-100 hover:bg-rose-100 text-slate-600 hover:text-rose-600 flex items-center justify-center">
                          <Eraser size={16} />
                        </button>
                        <button type="button" onClick={forceDraftNow}
                          disabled={freeSending || uploading || forceDrafting || detail.generating}
                          title="ร่างคำตอบใหม่ทันที — ไม่ต้องรอระบบ"
                          className="min-w-0 px-2 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
                          {(forceDrafting || detail.generating) ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />}
                        </button>
                        <button onClick={freeRewrite} disabled={freeRewriting || freeSending || !freeText.trim()}
                          title="ให้ AI ช่วยแก้ไวยากรณ์/เรียบเรียงข้อความนี้"
                          className="min-w-0 px-2 py-2 rounded-xl bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
                          {freeRewriting ? <Loader2 size={17} className="animate-spin" /> : <Wand2 size={17} />}
                        </button>
                        <button onClick={freeSend} disabled={(!freeText.trim() && !upload && !freeProducts.length) || freeSending}
                          title={freeNeedsConfirm ? 'ยืนยันส่ง (ข้อความมีราคา)' : 'ส่งข้อความให้ลูกค้า'}
                          className={'min-w-0 px-2 py-2 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 ' + (freeNeedsConfirm ? 'bg-amber-600 hover:bg-amber-700' : 'bg-sky-600 hover:bg-sky-700')}>
                          {freeSending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center p-4 border-t border-slate-200 text-xs text-slate-400 text-center">
                      รอคำถามจากลูกค้า…
                    </div>
                  )}
                    </div>{/* /RIGHT column */}
                  </div>{/* /side-by-side */}
                </>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Stage-1b dashboard: AI accuracy from /api/learned/metrics (supervisor only).
function LearningMetrics() {
  const [m, setM] = useState<LearnedMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    getLearnedMetrics().then(setM).catch(() => setM(null)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  const pct = (r: number | null) => (r == null ? '—' : Math.round(r * 100) + '%');
  const CAT_TH: Record<string, string> = { general: 'ทั่วไป', product: 'สินค้า', kb: 'คลังความรู้', price_stock: 'ราคา/สต็อก', clinical: 'คลินิก', payment: 'การชำระเงิน' };
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-bold text-slate-700 flex items-center gap-2"><GraduationCap size={18} className="text-sky-600" /> ความแม่นยำของ AI</span>
        <button onClick={load} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"><RefreshCw size={12} /> รีเฟรช</button>
      </div>
      {loading && !m ? (
        <div className="flex justify-center py-6 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>
      ) : !m || m.overall.total === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">ยังไม่มีข้อมูล — ระบบเริ่มเก็บผลทุกครั้งที่ทีมส่งคำตอบ (เริ่มนับจากนี้เป็นต้นไป)</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-end gap-4">
            <div>
              <div className="text-3xl font-bold text-sky-700 leading-none">{pct(m.overall.acceptRate)}</div>
              <div className="text-[11px] text-slate-400 mt-1">ส่งเลยโดยไม่แก้ (จากที่ AI ตอบเอง)</div>
            </div>
            <div className="text-xs text-slate-500 pb-1">
              จาก {m.overall.total} ดราฟ · ส่งเอง {m.overall.accepted} · แก้ {m.overall.edited} · ให้คนตอบ {m.overall.escalated}
              {m.overall.total > 0 && ` (${Math.round((m.overall.escalated / m.overall.total) * 100)}%)`}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-slate-500">แยกตามหมวด (อัตราส่งโดยไม่แก้)</div>
            {m.byCategory.map((c) => (
              <div key={c.category} className="flex items-center gap-2 text-xs">
                <div className="w-16 shrink-0 text-slate-600 truncate">{CAT_TH[c.category] ?? c.category}</div>
                <div className="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-sky-500 rounded-full" style={{ width: `${(c.acceptRate ?? 0) * 100}%` }} />
                </div>
                <div className="w-9 text-right text-slate-700 font-medium">{pct(c.acceptRate)}</div>
                <div className="hidden sm:block w-36 shrink-0 text-[10px] text-slate-400">ส่งเอง {c.accepted}·แก้ {c.edited}·คน {c.escalated}</div>
              </div>
            ))}
          </div>
          {m.byWeek.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-slate-500 mb-1">แนวโน้มรายสัปดาห์ (อัตราส่งโดยไม่แก้)</div>
              <div className="flex items-end gap-1 h-16">
                {m.byWeek.map((w) => (
                  <div key={w.week} className="flex-1 flex flex-col items-center justify-end" title={`สัปดาห์ ${w.week}: ${pct(w.acceptRate)} (${w.total} ดราฟ)`}>
                    <div className="w-full bg-sky-400 rounded-t" style={{ height: `${Math.max((w.acceptRate ?? 0) * 100, 3)}%` }} />
                    <div className="text-[8px] text-slate-400 mt-0.5">{w.week.slice(5)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[10px] text-slate-400 leading-snug">ส่งเลยโดยไม่แก้ = AI ถูกต้อง · แก้ = ต้องปรับก่อนส่ง · ให้คนตอบ = AI ส่งต่อให้คน (ราคา/สต็อก/คลินิก)</div>
        </div>
      )}
    </div>
  );
}

function LearningView({ learned, flagged, isSupervisor, onPromote, onReject, onFlag, onResolve, promotingId, notice, onDismissNotice }: {
  learned: LearnedAnswer[];
  flagged: LearnedAnswer[];
  isSupervisor: boolean;
  onPromote: (id: string) => void;
  onReject: (id: string) => void;
  onFlag: (id: string) => void;
  onResolve: (id: string, action: 'promote' | 'reject', kbText?: string) => void;
  promotingId: string | null;
  notice: { kind: 'warn' | 'error'; text: string } | null;
  onDismissNotice: () => void;
}) {
  const [filter, setFilter] = useState<'pending' | 'flagged'>('pending');
  const [resolutionText, setResolutionText] = useState<Record<string, string>>({});
  const busy = promotingId !== null;
  const records = filter === 'pending' ? learned : flagged;
  return (
    <div className="space-y-3">
      {notice && (
        <div
          className={`w-full rounded-xl px-3 py-2 flex items-start gap-2 text-sm border ${
            notice.kind === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}
        >
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={onDismissNotice} aria-label="ปิด" className="shrink-0 opacity-70 hover:opacity-100">
            <X size={15} />
          </button>
        </div>
      )}
      {isSupervisor && <LearningMetrics />}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-slate-700 flex items-center gap-2"><Brain size={18} className="text-sky-600" /> คลังการเรียนรู้ — คำตอบที่พนักงานแก้</span>
          <span className="text-xs text-slate-500">ทั้งหมดที่รอตรวจ: <b className="text-sky-700">{learned.length + flagged.length}</b></span>
        </div>
        <div className="flex gap-1 mb-3 border-b border-slate-200">
          <button
            type="button"
            onClick={() => setFilter('pending')}
            className={`px-3 py-2 text-xs font-medium border-b-2 ${filter === 'pending' ? 'border-sky-600 text-sky-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            รออนุมัติ ({learned.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('flagged')}
            className={`px-3 py-2 text-xs font-medium border-b-2 ${filter === 'flagged' ? 'border-amber-500 text-amber-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            🚩 รอเจ้าของ ({flagged.length})
          </button>
        </div>
        {!isSupervisor && <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-3">เฉพาะหัวหน้าเท่านั้นที่อนุมัติเข้า KB ได้ (คุณดูได้อย่างเดียว)</div>}
        {records.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {filter === 'pending' ? 'ยังไม่มีรายการรออนุมัติ' : 'ยังไม่มีรายการที่รอเจ้าของตัดสิน'}
          </p>
        ) : (
          <div className="space-y-2">
            {records.map((rec) => {
              const isPromoting = promotingId === rec.id;
              const kbText = resolutionText[rec.id] ?? rec.finalAnswer;
              return (
                <div key={rec.id} className={`border rounded-xl p-3 text-sm ${filter === 'flagged' ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}>
                  <div className="text-slate-500 text-xs mb-2">ถาม: <span className="text-slate-700">{rec.customerQuestion}</span></div>
                  <div className="grid sm:grid-cols-2 gap-2 mb-2">
                    <div className="bg-slate-50 rounded-lg p-2 text-xs text-slate-500"><b className="text-slate-400">ร่างเดิมของ AI:</b><br />{rec.aiDraft || '—'}</div>
                    <div className="bg-sky-50 rounded-lg p-2 text-xs text-sky-800"><b className="text-sky-600">คำตอบที่พนักงานปรับ:</b><br />{rec.finalAnswer}</div>
                  </div>
                  {filter === 'flagged' && rec.flagNote && (
                    <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                      <b>เหตุผลที่ส่งให้เจ้าของ:</b> {rec.flagNote}
                    </div>
                  )}
                  {isSupervisor && filter === 'pending' && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => onPromote(rec.id)}
                        disabled={busy}
                        className={`text-xs px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white flex items-center gap-1 ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        {isPromoting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} เพิ่มเข้า KB (สอน AI)
                      </button>
                      <button
                        onClick={() => onFlag(rec.id)}
                        disabled={busy}
                        className={`text-xs px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-700 ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        🚩 ส่งให้เจ้าของตัดสิน
                      </button>
                      <button
                        onClick={() => onReject(rec.id)}
                        disabled={busy}
                        className={`text-xs px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        ไม่ใช้
                      </button>
                    </div>
                  )}
                  {isSupervisor && filter === 'flagged' && (
                    <div className="space-y-2">
                      <label className="block text-xs font-medium text-slate-600">
                        ข้อความที่จะบันทึกเข้า KB (แก้เป็นถ้อยคำที่เจ้าของอนุมัติ)
                        <textarea
                          value={kbText}
                          onChange={(event) => setResolutionText((current) => ({ ...current, [rec.id]: event.target.value }))}
                          rows={3}
                          className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-400"
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => onResolve(rec.id, 'promote', kbText)}
                          disabled={busy || !kbText.trim()}
                          className={`text-xs px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white flex items-center gap-1 ${busy || !kbText.trim() ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          {isPromoting ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} เพิ่ม KB ด้วยข้อความนี้
                        </button>
                        <button
                          onClick={() => onResolve(rec.id, 'reject')}
                          disabled={busy}
                          className={`text-xs px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 ${busy ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          ปฏิเสธรายการ
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
