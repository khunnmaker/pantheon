import { useRef, useState } from 'react';
import { Bot, LogIn, Loader2, AlertTriangle } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';

const QUICK = [
  { email: 'drm@prominent.local', label: 'Dr. M', role: 'supervisor' },
  { email: 'nadeer@prominent.local', label: 'NaDeer', role: 'agent' },
  { email: 'anny@prominent.local', label: 'Anny', role: 'agent' },
  { email: 'noey@prominent.local', label: 'Noey', role: 'agent' },
];

// Three view-states: pick a name → PIN pad (agents) or password field (Dr. M) →
// fall back to the full manual email/password form (kept working for as long as
// AGENT_PINS isn't configured — agents can still use STAFF_PASSWORD by hand).
type View = 'picker' | 'pin' | 'manual';

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [view, setView] = useState<View>('picker');
  const [selected, setSelected] = useState<(typeof QUICK)[number] | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pinRef = useRef<HTMLInputElement>(null);

  async function submit(useEmail: string, usePassword: string) {
    const em = useEmail.trim();
    if (!em || !usePassword || busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, usePassword);
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      // PIN attempts are one-shot — clear it and let the agent retype rather than
      // resubmitting the same (wrong) 6 digits. Refocus after the input re-enables
      // (it's disabled while busy, which blurs it; autoFocus only fires on mount).
      if (view === 'pin') {
        setPin('');
        setTimeout(() => pinRef.current?.focus(), 0);
      }
    } finally {
      setBusy(false);
    }
  }

  function pickQuick(q: (typeof QUICK)[number]) {
    setError('');
    if (q.role === 'supervisor') {
      // Dr. M keeps the original flow: email prefilled, password typed by hand.
      setEmail(q.email);
      setSelected(q);
      setView('manual');
      return;
    }
    setSelected(q);
    setPin('');
    setView('pin');
  }

  function onPinChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setPin(digits);
    if (digits.length === 6 && selected) {
      void submit(selected.email, digits);
    }
  }

  function backToPicker() {
    setError('');
    setPin('');
    setPassword('');
    setSelected(null);
    setView('picker');
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-sky-700 mb-1">
          <Bot size={24} />
          <h1 className="text-xl font-bold">Minerva</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">เข้าสู่ระบบ</p>

        {view === 'picker' && (
          <>
            <p className="text-xs font-semibold text-slate-500 mb-2">เลือกชื่อพนักงาน</p>
            <div className="flex flex-wrap gap-1 mb-4">
              {QUICK.map((q) => (
                <button
                  key={q.email}
                  onClick={() => pickQuick(q)}
                  className="text-xs px-2 py-1 rounded-lg bg-slate-100 hover:bg-sky-100 text-slate-600 border border-slate-200"
                >
                  {q.label}
                  {q.role === 'supervisor' && <span className="text-sky-600"> · หัวหน้า</span>}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setSelected(null); setView('manual'); }}
              className="text-xs text-sky-600 hover:text-sky-700 underline"
            >
              เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน
            </button>
          </>
        )}

        {view === 'pin' && selected && (
          <>
            <p className="text-sm text-slate-600 mb-3 text-center">
              {selected.label} · ใส่รหัส PIN 6 หลัก
            </p>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={6}
              autoFocus
              ref={pinRef}
              value={pin}
              onChange={(e) => onPinChange(e.target.value)}
              disabled={busy}
              className="w-full px-3 py-3 mb-3 rounded-xl border border-slate-300 text-2xl tracking-[0.5em] text-center focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:opacity-50"
            />

            {busy && (
              <div className="flex items-center justify-center gap-1 text-slate-400 text-xs mb-3">
                <Loader2 size={13} className="animate-spin" /> กำลังเข้าสู่ระบบ...
              </div>
            )}
            {error && (
              <div className="flex items-center justify-center gap-1 text-rose-600 text-xs mb-3">
                <AlertTriangle size={13} /> {error}
              </div>
            )}

            <button onClick={backToPicker} className="text-xs text-slate-400 hover:text-sky-600 underline">
              ย้อนกลับ
            </button>
          </>
        )}

        {view === 'manual' && (
          <>
            <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(email, password)}
              placeholder="name@prominent.local"
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
            />
            <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(email, password)}
              autoFocus={!!selected}
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
            />

            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
                <AlertTriangle size={13} /> {error}
              </div>
            )}

            <button
              onClick={() => submit(email, password)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
            </button>

            <div className="mt-4 pt-3 border-t border-slate-100">
              <button onClick={backToPicker} className="text-xs text-slate-400 hover:text-sky-600 underline">
                ย้อนกลับ
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
