import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Bot, User, LogOut, Clock, Inbox, Wifi, WifiOff, Loader2, ShieldCheck, MessageSquare,
  Send, Check, CheckCircle2, RefreshCw, Brain, GraduationCap, Wand2, Pencil, AlertTriangle, Search,
  Download, Paperclip, X,
} from 'lucide-react';
import {
  getQueue, getCustomers, getCustomer, searchCustomers, clearSession, regenerateDraft, rewriteText, sendReply, setNickname,
  uploadAttachment, getLearned, promoteLearned, rejectLearned, endSession, API_URL, getToken,
  type Agent, type CustomerLite, type CustomerDetail, type Message, type DraftType, type LearnedAnswer,
} from './lib/api';
import { getSocket, disconnectSocket } from './lib/socket';

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
const nameOf = (c: CustomerLite) => c.nickname || c.displayName || c.lineUserId;

const TYPE_META: Record<DraftType, { label: string; cls: string }> = {
  draft: { label: 'ร่างพร้อมส่ง', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  needs_human: { label: 'ต้องให้คนตอบ', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  out_of_scope: { label: 'นอกขอบเขต', cls: 'bg-slate-100 text-slate-600 border-slate-300' },
};

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
  if (kind === 'image') return <img src={url} alt="รูปจากลูกค้า" className="max-w-[220px] max-h-[260px] rounded-lg block" />;
  if (kind === 'video') return <video src={url} controls className="max-w-[260px] max-h-[300px] rounded-lg block" />;
  if (kind === 'audio') return <audio src={url} controls className="max-w-[260px]" />;
  return (
    <a href={url} download={fileName ?? 'file'} className="inline-flex items-center gap-1.5 text-sm text-teal-700 underline break-all">
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
        <img src={`${API_URL}/content/upload/${m.attachmentRef}`} alt="รูปที่ส่ง"
          className="max-w-[220px] max-h-[260px] rounded-lg block"
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
        <img src={`${API_URL}/content/product/${m.attachmentRef}`} alt="รูปสินค้า"
          className="max-w-[200px] max-h-[200px] rounded-lg bg-white block"
          onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      </div>
    );
  return <>{m.text}</>;
}

export default function Console({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [view, setView] = useState<'console' | 'learning'>('console');
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [waitingIds, setWaitingIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [connected, setConnected] = useState(false);

  const [editText, setEditText] = useState('');
  const [sending, setSending] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [nickEdit, setNickEdit] = useState<string | null>(null);
  const [rewriteNote, setRewriteNote] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<CustomerLite[] | null>(null);
  const [ending, setEnding] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [selectedProductSku, setSelectedProductSku] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ uploadId: string; kind: string; fileName: string; previewUrl: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const [learned, setLearned] = useState<LearnedAnswer[]>([]);

  const selectedRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshLists = useCallback(async () => {
    const [{ customers: cs }, { queue }] = await Promise.all([getCustomers(), getQueue()]);
    setCustomers(cs);
    setWaitingIds(new Set(queue.map((q) => q.customer.id)));
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const d = await getCustomer(id);
      setDetail(d);
      setEditText(d.pendingDraft?.draftText ?? '');
      setNeedsConfirm(false);
      setRewriteNote(null);
      setSelectedProductSku(d.pendingProduct?.photoSku ? d.pendingProduct.sku : null);
      setUpload(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const refreshLearned = useCallback(async () => {
    const { learned: l } = await getLearned('pending');
    setLearned(l);
  }, []);

  // initial load + live socket
  useEffect(() => {
    refreshLists().catch(() => undefined);
    refreshLearned().catch(() => undefined);
    const socket = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: Error) => {
      setConnected(false);
      if (err.message === 'unauthorized') logout();
    };
    const onMessage = (payload: { customer: CustomerLite }) => {
      refreshLists().catch(() => undefined);
      if (selectedRef.current === payload.customer.id) loadDetail(payload.customer.id).catch(() => undefined);
    };
    const onDraft = (payload: { customerId?: string; messageId: string }) => {
      // Refresh the open conversation when its draft arrives/updates.
      if (selectedRef.current && (payload.customerId === selectedRef.current || !payload.customerId)) {
        loadDetail(selectedRef.current).catch(() => undefined);
      }
    };
    const onConversation = (payload: { customerId: string; ended?: boolean }) => {
      refreshLists().catch(() => undefined);
      if (selectedRef.current === payload.customerId) {
        if (payload.ended) {
          setSelectedId(null); // another staff ended this chat — close it here too
          setDetail(null);
        } else {
          loadDetail(payload.customerId).catch(() => undefined);
        }
      }
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('message:new', onMessage);
    socket.on('draft:new', onDraft);
    socket.on('conversation:update', onConversation);
    if (socket.connected) setConnected(true);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('message:new', onMessage);
      socket.off('draft:new', onDraft);
      socket.off('conversation:update', onConversation);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLists, loadDetail, refreshLearned]);

  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId) loadDetail(selectedId).catch(() => undefined);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length]);

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
    setToast(msg);
    setTimeout(() => setToast(''), 2600);
  }

  function logout() {
    disconnectSocket();
    clearSession();
    onLogout();
  }

  async function approve() {
    const draft = detail?.pendingDraft;
    const msgId = detail?.pendingMessageId;
    if (!draft || !msgId || !editText.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await sendReply(msgId, editText.trim(), needsConfirm, selectedProductSku ?? undefined, upload?.uploadId);
      if ('needsConfirm' in res) {
        setNeedsConfirm(true);
        setError('คำตอบมีตัวเลข — โปรดตรวจสอบแล้วกด "ยืนยันส่ง" อีกครั้ง');
        return;
      }
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

  // Polish the agent's current text (grammar/wording) without changing meaning/numbers.
  async function rewrite() {
    if (!editText.trim() || rewriting || sending) return;
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

  // Staff upload a photo/file to attach to the reply.
  async function onPickFile(file?: File) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setError('ไฟล์ใหญ่เกิน 25MB'); return; }
    setUploading(true);
    setError('');
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(new Error('read failed'));
        r.readAsDataURL(file);
      });
      const b64 = dataUrl.split(',')[1] ?? '';
      const out = await uploadAttachment(b64, file.name, file.type || 'application/octet-stream');
      setUpload({ uploadId: out.uploadId, kind: out.kind, fileName: out.fileName, previewUrl: file.type.startsWith('image/') ? dataUrl : '' });
      setSelectedProductSku(null); // a staff upload replaces a catalog photo choice
    } catch (err) {
      setError('อัปโหลดไม่สำเร็จ: ' + (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function regenerate() {
    const msgId = detail?.pendingMessageId;
    if (!msgId || sending) return;
    setSending(true);
    setError('');
    try {
      await regenerateDraft(msgId);
      if (selectedId) await loadDetail(selectedId);
      flashToast('ร่างใหม่แล้ว');
    } catch (e) {
      setError('ร่างใหม่ไม่สำเร็จ: ' + (e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function saveNick() {
    if (nickEdit === null || !selectedId) return;
    const val = nickEdit;
    setNickEdit(null);
    try {
      await setNickname(selectedId, val);
      await loadDetail(selectedId);
      await refreshLists();
    } catch {
      setError('ตั้งชื่อเล่นไม่สำเร็จ');
    }
  }

  async function endChat() {
    if (!selectedId || ending) return;
    setEnding(true);
    try {
      const res = await endSession(selectedId);
      flashToast(res.summary ? 'จบแชทแล้ว — เก็บความจำและนำออกจากคิวแล้ว ✓' : 'จบแชทแล้ว — นำออกจากคิวแล้ว');
      setSelectedId(null); // close + remove the ended chat from the queue
      setDetail(null);
      await refreshLists();
    } catch {
      setError('จบแชทไม่สำเร็จ');
    } finally {
      setEnding(false);
    }
  }

  async function promote(id: string) {
    await promoteLearned(id).catch(() => undefined);
    await refreshLearned();
    flashToast('เพิ่มเข้า KB แล้ว — AI จะใช้ครั้งต่อไป');
  }
  async function reject(id: string) {
    await rejectLearned(id).catch(() => undefined);
    await refreshLearned();
  }

  const draft = detail?.pendingDraft ?? null;
  const displayList = searchResults ?? customers;

  return (
    <div className="min-h-screen bg-slate-100 p-3 sm:p-5 font-sans text-slate-800">
      <div className="max-w-6xl mx-auto">
        {toast && <div className="mb-3 text-sm bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-3 py-2 flex items-center gap-2"><Check size={15} /> {toast}</div>}
        <div className="grid md:grid-cols-[300px_1fr] gap-4 h-[calc(100vh-2.5rem)]">
          {/* LEFT: icon bar (top) + queue (bottom) */}
          <div className="flex flex-col gap-3 min-h-0">
            {/* icon bar */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex items-center gap-1 px-2 py-2 shrink-0">
              <div className="text-teal-700 px-1" title="Minerva"><Bot size={22} /></div>
              <button onClick={() => setView('console')} title="คอนโซล"
                className={'p-2 rounded-xl ' + (view === 'console' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-100')}><MessageSquare size={19} /></button>
              <button onClick={() => setView('learning')} title="การเรียนรู้"
                className={'relative p-2 rounded-xl ' + (view === 'learning' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-100')}>
                <GraduationCap size={19} />
                {learned.length > 0 && <span className="absolute -top-0.5 -right-0.5 text-[10px] bg-amber-400 text-white rounded-full px-1 leading-tight">{learned.length}</span>}
              </button>
              <div className="flex-1" />
              <span title={connected ? 'เชื่อมต่อสด' : 'ออฟไลน์'} className={'px-1 ' + (connected ? 'text-emerald-600' : 'text-slate-300')}>
                {connected ? <Wifi size={17} /> : <WifiOff size={17} />}
              </span>
              <span title={agent.name + (agent.role === 'supervisor' ? ' (หัวหน้า)' : '')}
                className="relative w-8 h-8 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                {agent.name.replace(/^คุณ/, '').charAt(0)}
                {agent.role === 'supervisor' && <span className="absolute -bottom-1 -right-1 bg-white rounded-full text-teal-600 flex"><ShieldCheck size={12} /></span>}
              </span>
              <button onClick={logout} title="ออกจากระบบ" className="p-2 rounded-xl text-slate-400 hover:text-rose-500 hover:bg-slate-100"><LogOut size={17} /></button>
            </div>
            {/* queue */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col flex-1 min-h-0">
              <div className="px-4 py-3 bg-teal-700 text-white rounded-t-2xl font-semibold flex items-center gap-2">
                <Inbox size={18} /> คิวลูกค้า
                <span className="ml-auto text-xs bg-teal-800 px-2 py-0.5 rounded-full">{waitingIds.size} รอตอบ</span>
              </div>
              <div className="px-2 pt-2 shrink-0">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="ค้นหาชื่อเล่น / ชื่อลูกค้า…"
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400" />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {searchResults !== null && searchResults.length > 0 && (
                  <div className="px-1 pb-1 text-[11px] text-slate-400">ผลค้นหา {searchResults.length} ราย (รวมแชทที่จบแล้ว)</div>
                )}
                {displayList.length === 0 && (
                  <div className="text-slate-400 text-sm text-center py-10 px-3">
                    {searchResults !== null ? 'ไม่พบลูกค้าที่ตรงกับคำค้นหา' : (
                      <>ยังไม่มีข้อความจากลูกค้า<br /><span className="text-xs">เมื่อมีข้อความเข้า LINE จะปรากฏที่นี่แบบเรียลไทม์</span></>
                    )}
                  </div>
                )}
                {displayList.map((c) => {
                  const waiting = waitingIds.has(c.id);
                  const active = selectedId === c.id;
                  return (
                    <button key={c.id} onClick={() => setSelectedId(c.id)}
                      className={'w-full text-left px-3 py-2 rounded-xl border transition ' + (active ? 'bg-teal-50 border-teal-300' : 'bg-white border-slate-100 hover:bg-slate-50')}>
                      <div className="flex items-center gap-2">
                        <span className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center shrink-0"><User size={15} /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className="font-medium text-sm truncate">{nameOf(c)}</span>
                            {waiting && <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="รอตอบ" />}
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-1"><Clock size={10} /> {fmtTime(c.lastSeen)}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* RIGHT: conversation (or learning) */}
          <div className="min-h-0 overflow-y-auto">
            {view === 'learning' ? (
              <LearningView learned={learned} isSupervisor={agent.role === 'supervisor'} onPromote={promote} onReject={reject} />
            ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full">
              <div className="px-4 py-3 bg-green-600 text-white rounded-t-2xl font-semibold flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <MessageSquare size={18} className="shrink-0" />
                  {nickEdit !== null ? (
                    <input autoFocus value={nickEdit} onChange={(e) => setNickEdit(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveNick(); if (e.key === 'Escape') setNickEdit(null); }}
                      onBlur={saveNick} placeholder="ตั้งชื่อเล่น…"
                      className="text-slate-800 bg-white text-sm rounded-md px-2 py-0.5 w-40 outline-none" />
                  ) : (
                    <>
                      <span className="truncate">{detail ? nameOf(detail.customer) : 'บทสนทนา'}</span>
                      {detail && <button onClick={() => setNickEdit(detail.customer.nickname ?? '')} title="ตั้งชื่อเล่น" className="opacity-80 hover:opacity-100 shrink-0"><Pencil size={13} /></button>}
                    </>
                  )}
                </div>
                {detail && <span className="text-xs font-normal shrink-0">ถาม {detail.stats.questions} · ตอบ {detail.stats.replies}</span>}
              </div>

              {!selectedId ? (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm p-6 text-center">
                  <Inbox size={36} className="mb-3 text-slate-300" /> เลือกลูกค้าจากคิวด้านซ้ายเพื่อดูบทสนทนาและร่างคำตอบ
                </div>
              ) : (
                <>
                  {detail && (
                    <div className="border-b border-slate-100 bg-slate-50">
                      <div className="px-4 py-2 text-xs text-slate-500 flex items-center gap-2">
                        <b className="text-slate-700">{nameOf(detail.customer)}</b>
                        <span>· LINE: {detail.customer.lineUserId}</span>
                        <button onClick={endChat} disabled={ending}
                          className="ml-auto text-[11px] px-2 py-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-600 flex items-center gap-1 disabled:opacity-50"
                          title="จบบทสนทนาแล้วสรุปความจำระยะยาว">
                          {ending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} จบแชท
                        </button>
                      </div>
                      {detail.memory?.summary && (
                        <div className="mx-4 mb-2 text-[11px] text-teal-800 bg-teal-50 border border-teal-200 rounded-lg p-2">
                          <span className="font-bold flex items-center gap-1 mb-0.5"><Brain size={12} /> ความจำระยะยาว</span>
                          {detail.memory.summary}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-green-50">
                    {loadingDetail && !detail && <div className="flex justify-center py-8 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>}
                    {detail?.messages.map((m: Message) => (
                      <div key={m.id} className={m.role === 'customer' ? 'flex justify-start' : 'flex justify-end'}>
                        <div className={'max-w-[78%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ' +
                          (m.role === 'customer' ? 'bg-white border border-slate-200 rounded-tl-sm' : 'bg-teal-600 text-white rounded-tr-sm')}>
                          <MessageBody m={m} />
                          <div className={'text-[10px] mt-0.5 ' + (m.role === 'customer' ? 'text-slate-400' : 'text-teal-100')}>{fmtTime(m.createdAt)}</div>
                        </div>
                      </div>
                    ))}
                    <div ref={endRef} />
                  </div>

                  {/* draft composer */}
                  {draft ? (
                    <div className="border-t border-slate-200 p-3 space-y-2 bg-white">
                      <div>
                        <span className={'text-xs font-semibold px-2 py-1 rounded-full border ' + TYPE_META[draft.type].cls}>{TYPE_META[draft.type].label}</span>
                      </div>
                      {draft.note && <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2 border border-slate-200">{draft.note}</div>}
                      {detail?.productCandidates && detail.productCandidates.length > 0 && (
                        <div className="bg-teal-50 border border-teal-200 rounded-xl p-2 space-y-1.5">
                          <div className="text-[11px] text-teal-700 font-medium">
                            {detail.productCandidates.length === 1
                              ? 'รูปสินค้าจากแคตตาล็อก (กดเพื่อแนบ/ไม่แนบ):'
                              : 'เลือกรูปสินค้าที่จะแนบ (กดเลือก 1 รูป):'}
                          </div>
                          <div className="flex gap-2 overflow-x-auto pb-1">
                            {detail.productCandidates.map((p) => {
                              const sel = selectedProductSku === p.sku;
                              return (
                                <button key={p.sku} type="button"
                                  onClick={() => setSelectedProductSku(sel ? null : p.sku)}
                                  title={[p.nameEn, p.nameTh].filter(Boolean).join(' / ')}
                                  className={'shrink-0 w-[88px] rounded-lg border p-1 text-left transition ' + (sel ? 'border-teal-500 ring-2 ring-teal-400 bg-white' : 'border-teal-100 bg-white/60 hover:border-teal-300')}>
                                  <div className="relative h-[68px] flex items-center justify-center bg-white rounded">
                                    {p.photoSku && <img src={`${API_URL}/content/product/${p.photoSku}`} alt=""
                                      className="max-w-full max-h-full object-contain"
                                      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />}
                                    {sel && <span className="absolute top-0.5 right-0.5 bg-teal-600 text-white rounded-full p-0.5 flex"><Check size={11} /></span>}
                                  </div>
                                  <div className="text-[10px] mt-1 leading-tight">
                                    <div className="font-semibold text-teal-800 truncate">{[p.nameEn, p.nameTh].filter(Boolean).join(' / ') || p.sku}</div>
                                    <div className="text-teal-600">{p.price > 0 ? `${p.price.toLocaleString()} บาท` : '—'}</div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                          <div className="text-[11px] text-teal-700">
                            {selectedProductSku ? '✓ จะแนบรูปที่เลือกไปกับคำตอบ' : 'ยังไม่เลือกรูป — จะส่งเฉพาะข้อความ'}
                          </div>
                        </div>
                      )}
                      <textarea value={editText} onChange={(e) => { setEditText(e.target.value); setNeedsConfirm(false); setRewriteNote(null); }} rows={3}
                        className="w-full p-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 resize-none" placeholder="พิมพ์/แก้คำตอบก่อนส่ง…" />
                      {rewriteNote && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 flex items-start gap-1.5">
                          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                          <span><span className="font-semibold">หมายเหตุจาก AI</span> (ไม่ส่งให้ลูกค้า): {rewriteNote}</span>
                        </div>
                      )}
                      {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}
                      {upload && (
                        <div className="flex items-center gap-2 bg-teal-50 border border-teal-200 rounded-lg pl-1 pr-2 py-1 text-xs w-fit">
                          {upload.previewUrl
                            ? <img src={upload.previewUrl} alt="" className="w-8 h-8 object-cover rounded" />
                            : <Paperclip size={14} className="text-teal-700" />}
                          <span className="truncate max-w-[180px] text-teal-800">{upload.fileName}</span>
                          <button type="button" onClick={() => setUpload(null)} className="text-slate-400 hover:text-rose-500"><X size={14} /></button>
                        </div>
                      )}
                      <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-2">
                        <input ref={fileRef} type="file" className="hidden"
                          onChange={(e) => { void onPickFile(e.target.files?.[0] ?? undefined); e.currentTarget.value = ''; }} />
                        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || sending || rewriting}
                          title="แนบรูป/ไฟล์" aria-label="แนบรูป/ไฟล์"
                          className="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center disabled:opacity-50">
                          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
                        </button>
                        <button onClick={approve} disabled={sending || rewriting || !editText.trim()}
                          title={needsConfirm ? 'ยืนยันส่ง (คำตอบมีตัวเลข)' : 'อนุมัติและส่งให้ลูกค้า'}
                          className={'min-w-0 px-2 py-2 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 ' + (needsConfirm ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700')}>
                          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />} <span className="truncate">{needsConfirm ? 'ยืนยันส่ง' : 'อนุมัติ & ส่ง'}</span>
                        </button>
                        <button onClick={rewrite} disabled={rewriting || sending || !editText.trim()}
                          title="ให้ AI ช่วยแก้ไวยากรณ์และเรียบเรียงข้อความที่คุณพิมพ์ใหม่ (ไม่เปลี่ยนความหมายหรือตัวเลข)"
                          className="min-w-0 px-2 py-2 rounded-xl bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
                          {rewriting ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} <span className="truncate">เรียบเรียงใหม่</span>
                        </button>
                        <button onClick={regenerate} disabled={sending || rewriting}
                          title="ให้ AI ร่างคำตอบใหม่จาก KB (ทิ้งข้อความที่แก้)"
                          className="min-w-0 px-2 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
                          <RefreshCw size={15} /> <span className="truncate">ร่างใหม่</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 py-3 border-t border-slate-200 text-xs text-slate-400 text-center">
                      {detail && detail.messages.length > 0 ? 'ลูกค้าได้รับคำตอบล่าสุดแล้ว — รอคำถามใหม่' : 'รอคำถามจากลูกค้า…'}
                    </div>
                  )}
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

function LearningView({ learned, isSupervisor, onPromote, onReject }: {
  learned: LearnedAnswer[];
  isSupervisor: boolean;
  onPromote: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-bold text-slate-700 flex items-center gap-2"><Brain size={18} className="text-teal-600" /> คลังการเรียนรู้ — คำตอบที่พนักงานแก้</span>
        <span className="text-xs text-slate-500">รออนุมัติ: <b className="text-teal-700">{learned.length}</b></span>
      </div>
      {!isSupervisor && <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-3">เฉพาะหัวหน้าเท่านั้นที่อนุมัติเข้า KB ได้ (คุณดูได้อย่างเดียว)</div>}
      {learned.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">ยังไม่มี — เมื่อพนักงานแก้ร่างของ AI แล้วส่ง ระบบจะเก็บคำตอบไว้ที่นี่เพื่อให้หัวหน้าอนุมัติเข้า KB</p>
      ) : (
        <div className="space-y-2">
          {learned.map((rec) => (
            <div key={rec.id} className="border border-slate-200 rounded-xl p-3 text-sm">
              <div className="text-slate-500 text-xs mb-2">ถาม: <span className="text-slate-700">{rec.customerQuestion}</span></div>
              <div className="grid sm:grid-cols-2 gap-2 mb-2">
                <div className="bg-slate-50 rounded-lg p-2 text-xs text-slate-500"><b className="text-slate-400">ร่างเดิมของ AI:</b><br />{rec.aiDraft || '—'}</div>
                <div className="bg-emerald-50 rounded-lg p-2 text-xs text-emerald-800"><b className="text-emerald-600">คำตอบที่พนักงานปรับ:</b><br />{rec.finalAnswer}</div>
              </div>
              {isSupervisor && (
                <div className="flex gap-2">
                  <button onClick={() => onPromote(rec.id)} className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white flex items-center gap-1"><Check size={13} /> เพิ่มเข้า KB (สอน AI)</button>
                  <button onClick={() => onReject(rec.id)} className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600">ไม่ใช้</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
