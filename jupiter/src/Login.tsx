import { useEffect, useState } from 'react';
import { Scale, LogIn, Loader2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { groupLogins, memberAvatar, teamAvatar, type GroupMeta } from '@pantheon/ui';
import { getLogins, hasAppAccess, login, setSession, type Agent, type LoginCard } from './lib/api';

const PIN_LEN = 6;

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [view, setView] = useState<'list' | 'manual'>('list');
  const [cards, setCards] = useState<LoginCard[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getLogins()
      .then((rows) => { if (!cancelled) setCards(rows); })
      .catch(() => { if (!cancelled) { setLoadFailed(true); setView('manual'); } });
    return () => { cancelled = true; };
  }, []);

  const groups = cards ? groupLogins(cards) : [];
  const group = groupId ? groups.find((g) => g.meta.id === groupId) ?? null : null;
  const selected = group && selectedEmail ? group.members.find((p) => p.email === selectedEmail) ?? null : null;

  async function submit(useEmail: string, value: string) {
    const normalized = useEmail.trim();
    if (!normalized || !value || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await login(normalized, value);
      if (!hasAppAccess(result.agent, 'jupiter')) {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าใช้งาน Jupiter');
        setSecret('');
        setPassword('');
        return;
      }
      setSession(result.token, result.agent);
      onLogin(result.agent);
    } catch {
      setError('รหัสไม่ถูกต้อง');
      setSecret('');
      setPassword('');
    } finally { setBusy(false); }
  }

  function back() {
    if (selectedEmail) setSelectedEmail(null); else setGroupId(null);
    setSecret(''); setError('');
  }
  function onPinChange(value: string) {
    if (!selected) return;
    const digits = value.replace(/\D/g, '').slice(0, PIN_LEN);
    setSecret(digits);
    if (digits.length === PIN_LEN) void submit(selected.email, digits);
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-md w-full p-6">
        <div className="flex items-center gap-2 text-violet-700 mb-1"><Scale size={24} /><h1 className="text-xl font-bold">Jupiter</h1></div>
        <p className="text-sm text-slate-500 mb-5">ระบบบัญชี · เลือกชื่อเพื่อเข้าสู่ระบบ</p>

        {view === 'list' ? (
          <>
            {!cards ? <div className="py-8 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={22} /></div>
              : !group ? <GroupGrid groups={groups} onPick={(meta) => { setGroupId(meta.id); setError(''); }} />
              : !selected ? (
                <div><BackButton onClick={back} /><div className={`${group.meta.color} text-white rounded-md px-3 py-2 mb-3`}><span className="text-sm font-bold">{group.meta.label}</span></div><NameGrid members={group.members} onPick={(p) => { setSelectedEmail(p.email); setError(''); }} /></div>
              ) : (
                <div>
                  <BackButton onClick={back} />
                  <div className={`${group.meta.color} text-white rounded-md px-4 py-3 mb-4 flex items-center gap-2`}><img src={memberAvatar(selected.email, selected.gender)} alt="" className="w-12 h-12 rounded-md bg-white/25 object-cover" /><span className="font-bold">{selected.name}</span></div>
                  {selected.kind === 'password' ? (
                    <><label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label><input type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit(selected.email, secret)} className="w-full px-3 py-2 mb-3 rounded-md border border-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400" /><Submit busy={busy} disabled={!secret} onClick={() => submit(selected.email, secret)} /></>
                  ) : (
                    <><label className="block text-xs font-semibold text-slate-500 mb-1">PIN 6 หลัก</label><input type="password" inputMode="numeric" autoFocus autoComplete="one-time-code" value={secret} onChange={(e) => onPinChange(e.target.value)} placeholder="••••••" className="w-full px-3 py-2 mb-1 rounded-md border border-slate-300 text-center tracking-[0.5em] text-lg focus:outline-none focus:ring-2 focus:ring-violet-400" /><div className="h-5 flex justify-center">{busy && <Loader2 size={16} className="animate-spin text-violet-500" />}</div></>
                  )}
                  <Error text={error} />
                </div>
              )}
            <button type="button" onClick={() => { setView('manual'); setGroupId(null); setSelectedEmail(null); setError(''); }} className="w-full mt-4 text-[11px] text-slate-400 hover:text-slate-600">เข้าสู่ระบบด้วยอีเมลอื่น</button>
          </>
        ) : (
          <>
            {loadFailed && <div className="text-[11px] text-slate-400 mb-3">โหลดรายชื่อไม่สำเร็จ — เข้าสู่ระบบด้วยอีเมล</div>}
            <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400" />
            <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit(email, password)} className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400" />
            <Error text={error} /><Submit busy={busy} onClick={() => submit(email, password)} />
            {!loadFailed && <button type="button" onClick={() => { setView('list'); setError(''); }} className="w-full mt-3 text-[11px] text-slate-400 hover:text-slate-600">ย้อนกลับ</button>}
          </>
        )}
        <p className="text-[10px] text-slate-300 mt-4">Jupiter · ระบบบัญชี The Pantheon</p>
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-1 px-2 py-2 -ml-2 mb-3 text-sm text-slate-500 hover:text-violet-600"><ArrowLeft size={16} /> กลับ</button>;
}
function GroupGrid({ groups, onPick }: { groups: { meta: GroupMeta; members: LoginCard[] }[]; onPick: (g: GroupMeta) => void }) {
  if (!groups.length) return <div className="py-6 text-center text-xs text-slate-400">ยังไม่มีรายชื่อ</div>;
  return <div className="grid grid-cols-2 gap-2">{groups.map(({ meta, members }) => <button key={meta.id} onClick={() => onPick(meta)} className={`${meta.color} relative aspect-square flex flex-col items-center justify-center gap-2 p-2 rounded-md text-white hover:brightness-110`}><span className="absolute top-2 right-2.5 text-xs text-white/80">{members.length}</span><img src={teamAvatar(meta.id)} alt="" className="w-24 h-24 rounded-full bg-white/90 object-cover" /><span className="font-bold">{meta.label}</span></button>)}</div>;
}
function NameGrid({ members, onPick }: { members: LoginCard[]; onPick: (p: LoginCard) => void }) {
  return <div className="grid grid-cols-2 gap-2">{members.map((p) => <button key={p.email} onClick={() => onPick(p)} className="aspect-square flex flex-col items-center justify-center gap-2 p-2 rounded-md bg-slate-700 hover:bg-slate-800 text-white"><img src={memberAvatar(p.email, p.gender)} alt="" className="w-24 h-24 rounded-full object-cover bg-white/15" /><span className="text-sm font-bold">{p.name}</span></button>)}</div>;
}
function Submit({ busy, disabled, onClick }: { busy: boolean; disabled?: boolean; onClick: () => void }) {
  return <button onClick={onClick} disabled={busy || disabled} className="w-full px-3 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">{busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ</button>;
}
function Error({ text }: { text: string }) {
  return text ? <div className="flex items-center gap-1 text-rose-600 text-xs mb-3"><AlertTriangle size={13} /> {text}</div> : null;
}
