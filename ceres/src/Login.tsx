import { useEffect, useState } from 'react';
import { Wallet, Loader2, AlertTriangle, Delete, LogIn, ShieldCheck, ArrowLeft } from 'lucide-react';
import { login, setSession, getLogins, type Agent, type LoginName } from './lib/api';

const RAW_ROLES = new Set(['messenger', 'md', 'supervisor']);

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [adminMode, setAdminMode] = useState(false);

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 flex flex-col items-center px-4 py-8">
      <div className="flex items-center gap-2 text-amber-700 mb-1">
        <Wallet size={26} />
        <h1 className="text-2xl font-bold">Ceres</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6">ระบบค่าใช้จ่าย</p>

      <div className="w-full max-w-sm">
        {adminMode ? (
          <AdminLogin onLogin={onLogin} onBack={() => setAdminMode(false)} />
        ) : (
          <MessengerLogin onLogin={onLogin} />
        )}
      </div>

      {!adminMode && (
        <button
          onClick={() => setAdminMode(true)}
          className="mt-8 text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
        >
          สำหรับผู้ดูแล (MD/CEO)
        </button>
      )}
    </div>
  );
}

// ── Messenger flow: pick your name, then a PIN pad ──────────────────────────
function MessengerLogin({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [names, setNames] = useState<LoginName[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<LoginName | null>(null);

  useEffect(() => {
    getLogins()
      .then(setNames)
      .catch(() => setLoadError('โหลดรายชื่อไม่สำเร็จ'));
  }, []);

  if (selected) {
    return <PinPad name={selected} onBack={() => setSelected(null)} onLogin={onLogin} />;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
      <div className="text-sm font-semibold text-slate-500 mb-3">เลือกชื่อของคุณ</div>
      {loadError ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-4 justify-center">
          <AlertTriangle size={15} /> {loadError}
        </div>
      ) : !names ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : names.length === 0 ? (
        <div className="py-8 text-center text-slate-400 text-sm">ไม่พบรายชื่อผู้ใช้</div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {names.map((n) => (
            <button
              key={n.email}
              onClick={() => setSelected(n)}
              className="min-h-[64px] px-3 py-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-amber-50 hover:border-amber-300 text-base font-semibold text-slate-700 flex items-center justify-center text-center"
            >
              {n.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PinPad({ name, onBack, onLogin }: { name: LoginName; onBack: () => void; onLogin: (agent: Agent) => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(fullPin: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(name.email, fullPin);
      if (!RAW_ROLES.has(agent.role)) {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าระบบ');
        setPin('');
        setBusy(false);
        return;
      }
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('PIN ไม่ถูกต้อง');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  function press(d: string) {
    if (busy) return;
    setError('');
    setPin((prev) => {
      const next = (prev + d).slice(0, 6);
      return next;
    });
  }
  function backspace() {
    if (busy) return;
    setError('');
    setPin((prev) => prev.slice(0, -1));
  }
  function ok() {
    if (pin.length === 0) return;
    submit(pin);
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-600 p-1 -ml-1">
          <ArrowLeft size={18} />
        </button>
        <div className="text-base font-semibold">{name.name}</div>
      </div>

      <div className="flex justify-center gap-3 mb-4" inputMode="numeric">
        {Array.from({ length: 6 }).map((_, i) => (
          <span
            key={i}
            className={`w-3.5 h-3.5 rounded-full border-2 ${i < pin.length ? 'bg-amber-600 border-amber-600' : 'border-slate-300'}`}
          />
        ))}
      </div>

      {error && (
        <div className="flex items-center justify-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            onClick={() => press(d)}
            disabled={busy}
            className="min-h-[56px] rounded-xl bg-slate-50 border border-slate-200 text-xl font-semibold hover:bg-slate-100 disabled:opacity-50"
          >
            {d}
          </button>
        ))}
        <button
          onClick={backspace}
          disabled={busy}
          className="min-h-[56px] rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center hover:bg-slate-100 disabled:opacity-50"
        >
          <Delete size={20} />
        </button>
        <button
          onClick={() => press('0')}
          disabled={busy}
          className="min-h-[56px] rounded-xl bg-slate-50 border border-slate-200 text-xl font-semibold hover:bg-slate-100 disabled:opacity-50"
        >
          0
        </button>
        <button
          onClick={ok}
          disabled={busy || pin.length === 0}
          className="min-h-[56px] rounded-xl bg-amber-600 text-white font-semibold flex items-center justify-center hover:bg-amber-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="animate-spin" size={20} /> : 'OK'}
        </button>
      </div>
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
