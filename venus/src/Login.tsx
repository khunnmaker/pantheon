import { useEffect, useState } from 'react';
import { Heart, Loader2, AlertTriangle, Delete, LogIn, ArrowLeft, ShieldCheck } from 'lucide-react';
import { login, setSession, getLogins, type Agent, type LoginName } from './lib/api';

// Venus login — suite card-list pattern (same shape as Ceres/Juno/Jupiter): pick your
// name card, 'password'-kind cards (supervisor/gm) open a password field, 'pin'-kind
// cards (staff) open a 6-digit PIN pad. Falls back to a manual email/password form
// (AdminLogin) if the card list fails to load.
//
// Unlike Ceres, the login screen does NOT hard-block by role: access to Venus is
// per-grant (requireApp('venus') server-side — supervisor always in, staff need the
// explicit 'venus' grant, gm excluded). Any account that authenticates here is let in;
// an ungranted staff member gets a friendly 403 state after login instead (see App.tsx).
export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [manual, setManual] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-b from-rose-50 to-slate-100 font-sans text-slate-800 flex flex-col items-center px-4 py-8">
      <div className="flex items-center gap-2 text-rose-600 mb-1">
        <Heart size={26} />
        <h1 className="text-2xl font-bold">Venus</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6">ระบบลูกค้าสัมพันธ์ / CRM</p>

      <div className="w-full max-w-sm">
        {manual ? (
          <AdminLogin onLogin={onLogin} onBack={() => setManual(false)} />
        ) : (
          <CardLogin onLogin={onLogin} onManual={() => setManual(true)} />
        )}
      </div>
    </div>
  );
}

// ── Card flow: pick your name — 'pin' cards open a PIN pad, 'password' cards
// (supervisor + GM) open a password field. Falls back to the manual email/password
// form (AdminLogin) if the card list fails to load.
function CardLogin({ onLogin, onManual }: { onLogin: (agent: Agent) => void; onManual: () => void }) {
  const [names, setNames] = useState<LoginName[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<LoginName | null>(null);

  useEffect(() => {
    getLogins()
      .then(setNames)
      .catch(() => setLoadError('โหลดรายชื่อไม่สำเร็จ'));
  }, []);

  if (selected) {
    if (selected.kind === 'password') {
      return <PasswordCard name={selected} onBack={() => setSelected(null)} onLogin={onLogin} />;
    }
    return <PinPad name={selected} onBack={() => setSelected(null)} onLogin={onLogin} />;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-rose-100 p-5">
      <div className="text-sm font-semibold text-slate-500 mb-3">เลือกชื่อของคุณ</div>
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
              className="min-h-[64px] px-3 py-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-rose-50 hover:border-rose-300 text-base font-semibold text-slate-700 flex items-center justify-center text-center"
            >
              {n.name}
            </button>
          ))}
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

// ── Password card: for 'password'-kind cards (supervisor + GM) picked from the list. ──
function PasswordCard({ name, onBack, onLogin }: { name: LoginName; onBack: () => void; onLogin: (agent: Agent) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(name.email, password);
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('รหัสผ่านไม่ถูกต้อง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-rose-100 p-5">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-600 p-1 -ml-1">
          <ArrowLeft size={18} />
        </button>
        <div className="text-base font-semibold">{name.name}</div>
      </div>

      <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        autoFocus
        disabled={busy}
        className="w-full px-3 py-3 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 min-h-[48px] disabled:opacity-50"
      />

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={busy}
        className="w-full px-3 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 min-h-[48px]"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
      </button>
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
    <div className="bg-white rounded-2xl shadow-sm border border-rose-100 p-5">
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
            className={`w-3.5 h-3.5 rounded-full border-2 ${i < pin.length ? 'bg-rose-600 border-rose-600' : 'border-slate-300'}`}
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
          className="min-h-[56px] rounded-xl bg-rose-600 text-white font-semibold flex items-center justify-center hover:bg-rose-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="animate-spin" size={20} /> : 'OK'}
        </button>
      </div>
    </div>
  );
}

// ── Admin flow: classic email + password fallback, shown when the card list fails. ──
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
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-rose-100 p-6">
      <div className="flex items-center gap-2 text-rose-600 mb-1">
        <ShieldCheck size={20} />
        <h2 className="text-lg font-bold">ผู้ดูแล</h2>
      </div>
      <p className="text-sm text-slate-500 mb-5">เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน</p>

      <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="name@prominent.local"
        className="w-full px-3 py-3 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 min-h-[48px]"
      />
      <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        className="w-full px-3 py-3 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 min-h-[48px]"
      />

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      <button
        onClick={() => submit()}
        disabled={busy}
        className="w-full px-3 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50 min-h-[48px]"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
      </button>

      <button onClick={onBack} className="w-full mt-3 text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600">
        กลับไปหน้าเลือกชื่อ
      </button>
    </div>
  );
}
