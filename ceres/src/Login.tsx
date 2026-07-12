import { useEffect, useState } from 'react';
import { Wallet, Loader2, AlertTriangle, LogIn, ArrowLeft, ShieldCheck } from 'lucide-react';
import { login, setSession, getLogins, type Agent, type LoginName } from './lib/api';
import { groupLogins, type GroupMeta, memberAvatar, teamAvatar } from '@pantheon/ui';

const PIN_LEN = 6;
const RAW_ROLES = new Set(['employee', 'md', 'supervisor']);

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [manual, setManual] = useState(false);

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 flex flex-col items-center px-4 py-8">
      <div className="flex items-center gap-2 text-amber-700 mb-1">
        <Wallet size={26} />
        <h1 className="text-2xl font-bold">Ceres</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6">ระบบค่าใช้จ่าย</p>

      <div className="w-full max-w-md">
        {manual ? (
          <AdminLogin onLogin={onLogin} onBack={() => setManual(false)} />
        ) : (
          <CardLogin onLogin={onLogin} onManual={() => setManual(true)} />
        )}
      </div>
    </div>
  );
}

// ── Card flow: role-grouped, tap-to-drill-down, Metro-tile picker — the SAME UX as the Pantheon
// portal (pantheon/src/Login.tsx), adapted to Ceres's amber accent. People come from the server
// (GET /api/ceres/logins) — a rich card list carrying group + gender. 3-level DRILL-DOWN:
//   L1 role groups (2-col Metro grid) → L2 that group's people (avatar tiles) → L3 person + cred
//   (password field for supervisor/MD, masked auto-submit 6-digit PIN for everyone else).
// The auth mechanism is UNCHANGED: submit() still calls login() → setSession() → onLogin(), with
// the RAW_ROLES guard preserved. Falls back to the manual email/password form (AdminLogin) if the
// card list fails to load.
function CardLogin({ onLogin, onManual }: { onLogin: (agent: Agent) => void; onManual: () => void }) {
  const [cards, setCards] = useState<LoginName[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getLogins()
      .then((rows) => { if (!cancelled) setCards(rows); })
      .catch(() => { if (!cancelled) setLoadError('โหลดรายชื่อไม่สำเร็จ'); });
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
      if (!RAW_ROLES.has(agent.role)) {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าระบบค่าใช้จ่าย');
        setSecret('');
        setBusy(false);
        return;
      }
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError(selected?.kind === 'password' ? 'รหัสผ่านไม่ถูกต้อง' : 'PIN ไม่ถูกต้อง');
      setSecret('');
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
  function pickPerson(p: LoginName) {
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
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
      {loadError ? (
        <div className="flex flex-col items-center gap-2 py-4">
          <div className="flex items-center gap-1 text-rose-600 text-sm justify-center">
            <AlertTriangle size={15} /> {loadError}
          </div>
          <button
            onClick={onManual}
            className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
          >
            เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน
          </button>
        </div>
      ) : !cards ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : !group ? (
        <>
          <div className="text-sm font-semibold text-slate-500 mb-3">เลือกชื่อของคุณ</div>
          <GroupGrid groups={groups} onPick={pickGroup} />
        </>
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
                disabled={busy}
                className="w-full px-3 py-3 mb-3 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[48px] disabled:opacity-50"
              />
              <button
                onClick={() => submit(selected.email, secret)}
                disabled={busy || !secret}
                className="w-full px-3 py-3 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 min-h-[48px]"
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
                disabled={busy}
                className="w-full px-3 py-3 mb-1 rounded-md border border-slate-300 text-center tracking-[0.5em] text-2xl focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[48px] disabled:opacity-50"
              />
              <div className="h-5 flex items-center justify-center">
                {busy && <Loader2 size={16} className="animate-spin text-amber-500" />}
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

      {!loadError && (
        <button
          onClick={onManual}
          className="w-full mt-4 text-[11px] text-slate-400 hover:text-slate-600"
        >
          เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน
        </button>
      )}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-2 -ml-2 mb-3 rounded-md text-sm font-medium text-slate-500 hover:text-amber-600 hover:bg-slate-100"
    >
      <ArrowLeft size={16} /> กลับ
    </button>
  );
}

function GroupGrid({
  groups,
  onPick,
}: {
  groups: { meta: GroupMeta; members: LoginName[] }[];
  onPick: (g: GroupMeta) => void;
}) {
  if (groups.length === 0) {
    return <div className="px-1 py-6 text-center text-xs text-slate-400">ไม่พบรายชื่อผู้ใช้</div>;
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

function NameGrid({ members, onPick }: { members: LoginName[]; onPick: (p: LoginName) => void }) {
  if (members.length === 0) {
    return <div className="px-1 py-6 text-center text-xs text-slate-400">ไม่พบรายชื่อผู้ใช้</div>;
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

// ── Admin (MD/CEO) flow: classic email + password ───────────────────────────
function AdminLogin({ onLogin, onBack }: { onLogin: (agent: Agent) => void; onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const em = email.trim();
    if (!em || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, password);
      if (!RAW_ROLES.has(agent.role)) {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าระบบค่าใช้จ่าย');
        setBusy(false);
        return;
      }
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
      <div className="flex items-center gap-2 text-amber-700 mb-1">
        <ShieldCheck size={20} />
        <h2 className="text-lg font-bold">ผู้ดูแล</h2>
      </div>
      <p className="text-sm text-slate-500 mb-5">MD / CEO · เข้าสู่ระบบ</p>

      <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="name@prominent.local"
        className="w-full px-3 py-3 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[48px]"
      />
      <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        className="w-full px-3 py-3 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[48px]"
      />

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      <button
        onClick={() => submit()}
        disabled={busy}
        className="w-full px-3 py-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 min-h-[48px]"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
      </button>

      <button onClick={onBack} className="w-full mt-3 text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600">
        กลับไปหน้าเลือกชื่อ
      </button>
    </div>
  );
}
