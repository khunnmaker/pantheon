import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Bot, User, LogOut, Clock, Inbox, Wifi, WifiOff, Loader2, ShieldCheck, MessageSquare,
  Send, Check, CheckCircle2, RefreshCw, AlertTriangle, Brain, Database, Sparkles, GraduationCap,
} from 'lucide-react';
import {
  getQueue, getCustomers, getCustomer, clearSession, regenerateDraft, sendReply,
  getLearned, promoteLearned, rejectLearned, endSession,
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
const nameOf = (c: CustomerLite) => c.displayName || c.lineUserId;

const TYPE_META: Record<DraftType, { label: string; cls: string }> = {
  draft: { label: 'ร่างพร้อมส่ง', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
  needs_human: { label: 'ต้องให้คนตอบ', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  out_of_scope: { label: 'นอกขอบเขต', cls: 'bg-slate-100 text-slate-600 border-slate-300' },
};

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
  const [ending, setEnding] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const [learned, setLearned] = useState<LearnedAnswer[]>([]);

  const selectedRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

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
    const onConversation = (payload: { customerId: string }) => {
      refreshLists().catch(() => undefined);
      if (selectedRef.current === payload.customerId) loadDetail(payload.customerId).catch(() => undefined);
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
      const res = await sendReply(msgId, editText.trim(), needsConfirm);
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

  async function endChat() {
    if (!selectedId || ending) return;
    setEnding(true);
    try {
      const res = await endSession(selectedId);
      flashToast(res.summary ? 'จบแชทแล้ว — อัปเดตความจำระยะยาว ✓' : 'จบแชทแล้ว');
      await loadDetail(selectedId);
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
  const edited = !!draft && editText.trim() !== draft.draftText.trim();

  return (
    <div className="min-h-screen bg-slate-100 p-3 sm:p-5 font-sans text-slate-800">
      <div className="max-w-6xl mx-auto">
        {/* header */}
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-teal-700">
            <Bot size={22} />
            <h1 className="text-xl sm:text-2xl font-bold">Minerva — คอนโซลพนักงาน</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">M2</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-xl border border-slate-200 bg-white overflow-hidden text-sm">
              <button onClick={() => setView('console')} className={'px-3 py-1.5 ' + (view === 'console' ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>คอนโซล</button>
              <button onClick={() => setView('learning')} className={'px-3 py-1.5 flex items-center gap-1 ' + (view === 'learning' ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>
                <GraduationCap size={14} /> การเรียนรู้{learned.length > 0 && <span className="text-[10px] bg-amber-400 text-white rounded-full px-1.5">{learned.length}</span>}
              </button>
            </div>
            <span className={'text-xs flex items-center gap-1 px-2 py-1 rounded-lg border ' +
              (connected ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-400')}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}{connected ? 'เชื่อมต่อสด' : 'ออฟไลน์'}
            </span>
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm shadow-sm">
              <span className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-bold">{agent.name.replace(/^คุณ/, '').charAt(0)}</span>
              <span className="font-semibold text-slate-700">{agent.name}</span>
              {agent.role === 'supervisor' && <span className="text-[10px] flex items-center gap-0.5 text-teal-600"><ShieldCheck size={11} /> หัวหน้า</span>}
              <button onClick={logout} className="text-slate-400 hover:text-rose-500" title="ออกจากระบบ"><LogOut size={15} /></button>
            </div>
          </div>
        </div>

        {toast && <div className="mb-3 text-sm bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-3 py-2 flex items-center gap-2"><Check size={15} /> {toast}</div>}

        {view === 'learning' ? (
          <LearningView learned={learned} isSupervisor={agent.role === 'supervisor'} onPromote={promote} onReject={reject} />
        ) : (
          <div className="grid md:grid-cols-[320px_1fr] gap-4">
            {/* queue */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[640px]">
              <div className="px-4 py-3 bg-teal-700 text-white rounded-t-2xl font-semibold flex items-center gap-2">
                <Inbox size={18} /> คิวลูกค้า
                <span className="ml-auto text-xs bg-teal-800 px-2 py-0.5 rounded-full">{waitingIds.size} รอตอบ</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {customers.length === 0 && (
                  <div className="text-slate-400 text-sm text-center py-10 px-3">
                    ยังไม่มีข้อความจากลูกค้า<br />
                    <span className="text-xs">เมื่อมีข้อความเข้า LINE จะปรากฏที่นี่แบบเรียลไทม์</span>
                  </div>
                )}
                {customers.map((c) => {
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

            {/* conversation + draft composer */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[640px]">
              <div className="px-4 py-3 bg-green-600 text-white rounded-t-2xl font-semibold flex items-center justify-between">
                <span className="flex items-center gap-2"><MessageSquare size={18} /> บทสนทนา</span>
                {detail && <span className="text-xs font-normal">ถาม {detail.stats.questions} · ตอบ {detail.stats.replies}</span>}
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
                          <span className="font-bold flex items-center gap-1 mb-0.5"><Brain size={12} /> ความจำระยะยาว (AI ใช้ทุกคำตอบ)</span>
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
                          {m.text}
                          <div className={'text-[10px] mt-0.5 ' + (m.role === 'customer' ? 'text-slate-400' : 'text-teal-100')}>{fmtTime(m.createdAt)}</div>
                        </div>
                      </div>
                    ))}
                    <div ref={endRef} />
                  </div>

                  {/* draft composer */}
                  {draft ? (
                    <div className="border-t border-slate-200 p-3 space-y-2 bg-white">
                      <div className="flex items-center justify-between">
                        <span className={'text-xs font-semibold px-2 py-1 rounded-full border ' + TYPE_META[draft.type].cls}>{TYPE_META[draft.type].label}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-teal-600 flex items-center gap-1"><Sparkles size={12} /> ร่างโดย AI</span>
                          {draft.type !== 'draft' && <span className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle size={13} /> ตรวจ/เติมก่อนส่ง</span>}
                        </div>
                      </div>
                      {draft.note && <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2 border border-slate-200">เหตุผล: {draft.note}</div>}
                      {draft.usedKb.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-xs text-slate-500 flex items-center gap-1"><Database size={12} /> KB:</span>
                          {draft.usedKb.map((id) => <span key={id} className="text-xs px-2 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200">{id}</span>)}
                        </div>
                      )}
                      <textarea value={editText} onChange={(e) => { setEditText(e.target.value); setNeedsConfirm(false); }} rows={3}
                        className="w-full p-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 resize-none" placeholder="พิมพ์/แก้คำตอบก่อนส่ง…" />
                      {edited && <div className="text-[11px] text-amber-600 flex items-center gap-1"><Brain size={12} /> มีการแก้ — จะถูกเก็บเข้าคลังการเรียนรู้เมื่อส่ง</div>}
                      {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}
                      <div className="flex gap-2">
                        <button onClick={approve} disabled={sending || !editText.trim()}
                          className={'flex-1 px-3 py-2 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 ' + (needsConfirm ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700')}>
                          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />} {needsConfirm ? 'ยืนยันส่ง (มีตัวเลข)' : 'อนุมัติ & ส่ง'}
                        </button>
                        <button onClick={regenerate} disabled={sending} className="px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 text-sm font-semibold flex items-center gap-1 disabled:opacity-50">
                          <RefreshCw size={15} /> ร่างใหม่
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 py-3 border-t border-slate-200 text-xs text-slate-400 text-center">
                      {detail && detail.messages.length > 0 ? 'ลูกค้าได้รับคำตอบล่าสุดแล้ว — รอคำถามใหม่' : 'รอคำถามจากลูกค้า…'}
                    </div>
                  )}
                  <div className="px-4 py-1.5 border-t border-slate-100 text-[11px] text-slate-400">🔒 ราคา/สต็อก/คำถามคลินิก → ระบบบังคับให้คนตอบเสมอ</div>
                </>
              )}
            </div>
          </div>
        )}
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
