import { useEffect, useState } from 'react';
import { Landmark, LogIn, Loader2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { login, setSession, getLogins, type Agent, type LoginCard } from './lib/api';
import { groupLogins, type GroupMeta } from './lib/loginGroups';
import { memberAvatar, teamAvatar } from './lib/avatar';

const PIN_LEN = 6;

// Role-grouped, tap-to-drill-down, Metro-tile login picker — the SAME UX as the Jupiter portal
// (jupiter/src/Login.tsx), adapted to Juno's emerald accent. The people come from the server
// (GET /api/auth/logins?app=juno) — a rich card list carrying group + gender. 3-level DRILL-DOWN:
//   L1 role groups (2-col Metro grid) → L2 that group's people (avatar tiles) → L3 person + cred.
// The auth mechanism is UNCHANGED: submit() still calls login() → setSession() → onLogin(), and
// Juno's supervisor-only guard (only 'supervisor' role may enter) is preserved. The manual
// email/password form stays as a fallback for when the card fetch fails or for other roles.
export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [view, setView] = useState<'list' | 'manual'>('list');
  const [cards, setCards] = useState<LoginCard[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Manual-fallback state.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    getLogins()
      .then((rows) => { if (!cancelled) setCards(rows); })
      .catch(() => { if (!cancelled) { setLoadFailed(true); setView('manual'); } });
    return () => { cancelled = true; };
  }, []);

  const groups = cards ? groupLogins(cards) : [];
  const group = selectedGroupId ? groups.find((g) => g.meta.id === selectedGroupId) ?? null : null;
  const selected =
    group && selectedEmail ? group.members.find((p) => p.email === selectedEmail) ?? null : null;

  async function submit(useEmail: string, value: string) {
    const em = useEmail.trim();
    if (!em || !value || busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, value);
      if (agent.role !== 'supervisor') {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าระบบการเงิน (เฉพาะหัวหน้า)');
        setSecret('');
        setPassword('');
        setBusy(false);
        return;
      }
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('รหัสไม่ถูกต้อง');
      setSecret('');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  function pickGroup(g: GroupMeta) {
    setSelectedGroupId(g.id);
    setSelectedEmail(null);
    setSecret('');
    setError('');
  }
  function pickPerson(p: LoginCard) {
    setSelectedEmail(p.email);
    setSecret('');
    setError('');
  }
  function back() {
    if (selectedEmail) setSelectedEmail(null);
    else setSelectedGroupId(null);
    setSecret('');
    setError('');
  }
  function onPinChange(v: string) {
    if (!selected) return;
    const digits = v.replace(/\D/g, '').slice(0, PIN_LEN);
    setSecret(digits);
    if (digits.length === PIN_LEN) void submit(selected.email, digits);
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-md w-full p-6">
        <div className="flex items-center gap-2 text-emerald-700 mb-1">
          <Landmark size={24} />
          <h1 className="text-xl font-bold">Juno</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">ระบบการเงิน · เลือกชื่อเพื่อเข้าสู่ระบบ</p>

        {view === 'list' ? (
          <>
            {!cards ? (
              <div className="py-8 flex justify-center text-slate-400">
                <Loader2 className="animate-spin" size={22} />
              </div>
            ) : !group ? (
              <GroupGrid groups={groups} onPick={pickGroup} />
            ) : !selected ? (
              <div>
                <BackButton onClick={back} />
                <div className={`${group.meta.color} text-white rounded-md px-3 py-2 mb-3`}>
                  <span className="text-sm font-bold">{group.meta.label}</span>
                </div>
                <NameGrid members={group.members} onPick={pickPerson} />
              </div>
            ) : (
              <div>
                <BackButton onClick={back} />
                <div className={`${group.meta.color} text-white rounded-md px-4 py-3 mb-4`}>
                  <div className="flex items-center gap-2">
                    <div className="w-12 h-12 rounded-md bg-white/25 overflow-hidden flex items-center justify-center shrink-0">
                      <img src={memberAvatar(selected.email, selected.gender)} alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="font-bold text-base leading-tight">{selected.name}</div>
                  </div>
                </div>

                {selected.kind === 'password' ? (
                  <>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
                    <input
                      type="password"
                      autoFocus
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && submit(selected.email, secret)}
                      className="w-full px-3 py-2 mb-3 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                    <button
                      onClick={() => submit(selected.email, secret)}
                      disabled={busy || !secret}
                      className="w-full px-3 py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
                    </button>
                  </>
                ) : (
                  <>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">PIN 6 หลัก</label>
                    <input
                      type="password"
                      inputMode="numeric"
                      autoFocus
                      autoComplete="one-time-code"
                      value={secret}
                      onChange={(e) => onPinChange(e.target.value)}
                      placeholder="••••••"
                      className="w-full px-3 py-2 mb-1 rounded-md border border-slate-300 text-center tracking-[0.5em] text-lg focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    />
                    <div className="h-5 flex items-center justify-center">
                      {busy && <Loader2 size={16} className="animate-spin text-emerald-500" />}
                    </div>
                  </>
                )}

                {error && (
                  <div className="flex items-center gap-1 text-rose-600 text-xs mt-1">
                    <AlertTriangle size={13} /> {error}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => { setView('manual'); setSelectedGroupId(null); setSelectedEmail(null); setError(''); }}
              className="w-full mt-4 text-[11px] text-slate-400 hover:text-slate-600"
            >
              เข้าสู่ระบบด้วยอีเมลอื่น
            </button>
          </>
        ) : (
          <>
            {loadFailed && (
              <div className="text-[11px] text-slate-400 mb-3">โหลดรายชื่อไม่สำเร็จ — เข้าสู่ระบบด้วยอีเมล</div>
            )}
            <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(email, password)}
              placeholder="name@prominent.local"
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(email, password)}
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            <button
              onClick={() => submit(email, password)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
            </button>
            {!loadFailed && (
              <button
                type="button"
                onClick={() => { setView('list'); setError(''); }}
                className="w-full mt-3 text-[11px] text-slate-400 hover:text-slate-600"
              >
                ย้อนกลับ
              </button>
            )}
          </>
        )}

        <p className="text-[10px] text-slate-300 mt-4">Juno เปิดให้เฉพาะหัวหน้า (supervisor) เท่านั้น</p>
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-2 -ml-2 mb-3 rounded-md text-sm font-medium text-slate-500 hover:text-emerald-600 hover:bg-slate-100"
    >
      <ArrowLeft size={16} /> กลับ
    </button>
  );
}

function GroupGrid({
  groups,
  onPick,
}: {
  groups: { meta: GroupMeta; members: LoginCard[] }[];
  onPick: (g: GroupMeta) => void;
}) {
  if (groups.length === 0) {
    return <div className="px-1 py-6 text-center text-xs text-slate-400">ยังไม่มีรายชื่อ</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {groups.map(({ meta, members }) => (
        <button
          key={meta.id}
          onClick={() => onPick(meta)}
          className={`${meta.color} relative aspect-square flex flex-col items-center justify-center gap-2 p-2 rounded-md text-white hover:brightness-110 transition`}
        >
          <span className="absolute top-2 right-2.5 text-xs font-semibold text-white/80">{members.length}</span>
          <img src={teamAvatar(meta.id)} alt="" className="w-24 h-24 rounded-full bg-white/90 object-cover" />
          <span className="text-base font-bold leading-tight text-center">{meta.label}</span>
        </button>
      ))}
    </div>
  );
}

function NameGrid({ members, onPick }: { members: LoginCard[]; onPick: (p: LoginCard) => void }) {
  if (members.length === 0) {
    return <div className="px-1 py-6 text-center text-xs text-slate-400">ยังไม่มีรายชื่อ</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {members.map((p) => (
        <button
          key={p.email}
          onClick={() => onPick(p)}
          className="relative aspect-square flex flex-col items-center justify-center gap-2 p-2 rounded-md bg-slate-700 hover:bg-slate-800 text-white transition-colors"
        >
          <img src={memberAvatar(p.email, p.gender)} alt="" className="w-24 h-24 rounded-full object-cover bg-white/15" />
          <span className="text-sm font-bold leading-tight text-center">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
