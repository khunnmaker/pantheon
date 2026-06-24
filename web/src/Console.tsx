import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Bot, User, LogOut, Clock, Inbox, Wifi, WifiOff, Loader2, ShieldCheck, MessageSquare,
} from 'lucide-react';
import {
  getQueue, getCustomers, getCustomer, clearSession,
  type Agent, type CustomerLite, type CustomerDetail, type Message,
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

export default function Console({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [waitingIds, setWaitingIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [connected, setConnected] = useState(false);
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
      setDetail(await getCustomer(id));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // initial load + live socket
  useEffect(() => {
    refreshLists().catch(() => undefined);
    const socket = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: Error) => {
      setConnected(false);
      // Server rejects an expired/invalid token with 'unauthorized' — log out
      // instead of silently retrying forever with a dead session.
      if (err.message === 'unauthorized') logout();
    };
    const onMessage = (payload: { customer: CustomerLite; message: Message }) => {
      refreshLists().catch(() => undefined);
      if (selectedRef.current === payload.customer.id) {
        loadDetail(payload.customer.id).catch(() => undefined);
      }
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('message:new', onMessage);
    if (socket.connected) setConnected(true);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('message:new', onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLists, loadDetail]);

  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId) loadDetail(selectedId).catch(() => undefined);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length]);

  function logout() {
    disconnectSocket();
    clearSession();
    onLogout();
  }

  return (
    <div className="min-h-screen bg-slate-100 p-3 sm:p-5 font-sans text-slate-800">
      <div className="max-w-6xl mx-auto">
        {/* header */}
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-teal-700">
            <Bot size={22} />
            <h1 className="text-xl sm:text-2xl font-bold">Minerva — คอนโซลพนักงาน</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">M1</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={'text-xs flex items-center gap-1 px-2 py-1 rounded-lg border ' +
              (connected ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-400')}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}{connected ? 'เชื่อมต่อสด' : 'ออฟไลน์'}
            </span>
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm shadow-sm">
              <span className="w-7 h-7 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs font-bold">
                {agent.name.replace(/^คุณ/, '').charAt(0)}
              </span>
              <span className="font-semibold text-slate-700">{agent.name}</span>
              {agent.role === 'supervisor' && (
                <span className="text-[10px] flex items-center gap-0.5 text-teal-600"><ShieldCheck size={11} /> หัวหน้า</span>
              )}
              <button onClick={logout} className="text-slate-400 hover:text-rose-500" title="ออกจากระบบ">
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-[320px_1fr] gap-4">
          {/* queue / customers */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[620px]">
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
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={'w-full text-left px-3 py-2 rounded-xl border transition ' +
                      (active ? 'bg-teal-50 border-teal-300' : 'bg-white border-slate-100 hover:bg-slate-50')}
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center shrink-0">
                        <User size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-sm truncate">{nameOf(c)}</span>
                          {waiting && <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="รอตอบ" />}
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-1">
                          <Clock size={10} /> {fmtTime(c.lastSeen)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* conversation */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[620px]">
            <div className="px-4 py-3 bg-green-600 text-white rounded-t-2xl font-semibold flex items-center justify-between">
              <span className="flex items-center gap-2"><MessageSquare size={18} /> บทสนทนา</span>
              {detail && (
                <span className="text-xs font-normal">
                  ถาม {detail.stats.questions} · ตอบ {detail.stats.replies}
                </span>
              )}
            </div>

            {!selectedId ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm p-6 text-center">
                <Inbox size={36} className="mb-3 text-slate-300" />
                เลือกลูกค้าจากคิวด้านซ้ายเพื่อดูบทสนทนา
              </div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-slate-100 bg-slate-50 text-xs text-slate-500 flex items-center gap-2">
                  {detail && (
                    <>
                      <b className="text-slate-700">{nameOf(detail.customer)}</b>
                      <span>· LINE: {detail.customer.lineUserId}</span>
                      <span className="ml-auto">ลูกค้าตั้งแต่ {fmtTime(detail.customer.firstSeen)}</span>
                    </>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-green-50">
                  {loadingDetail && !detail && (
                    <div className="flex justify-center py-8 text-slate-400">
                      <Loader2 size={18} className="animate-spin" />
                    </div>
                  )}
                  {detail?.messages.map((m) => (
                    <div key={m.id} className={m.role === 'customer' ? 'flex justify-start' : 'flex justify-end'}>
                      <div className={'max-w-[78%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ' +
                        (m.role === 'customer'
                          ? 'bg-white border border-slate-200 rounded-tl-sm'
                          : 'bg-teal-600 text-white rounded-tr-sm')}>
                        {m.text}
                        <div className={'text-[10px] mt-0.5 ' + (m.role === 'customer' ? 'text-slate-400' : 'text-teal-100')}>
                          {fmtTime(m.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={endRef} />
                </div>
              </>
            )}

            <div className="px-4 py-2 border-t border-slate-200 text-xs text-slate-400 bg-amber-50/40">
              ✍️ การ <b>ร่างคำตอบด้วย AI</b> และ <b>อนุมัติ &amp; ส่ง</b> จะมาในขั้น M2 · ตอนนี้คอนโซลแสดงข้อความเข้าแบบเรียลไทม์ (อ่านอย่างเดียว)
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-400 mt-3 text-center">
          M1: รับข้อความจาก LINE (ตรวจลายเซ็น) · เข้าสู่ระบบพนักงาน (JWT) · คิวสดผ่าน WebSocket
        </p>
      </div>
    </div>
  );
}
