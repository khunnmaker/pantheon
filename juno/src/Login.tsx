import { useEffect, useRef, useState } from 'react';
import { Landmark, LogIn, Loader2, AlertTriangle, UserCircle2 } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';

// Name-first login (same concept as the Minerva console): the relevant person is
// pre-selected and the credential field is focused. Juno is supervisor-only, so the
// ONLY person shown is Dr. M. The supervisor always uses a password (never a PIN);
// the manual mode is a fallback for future roles.
const PERSON = { email: 'drm@prominent.local', label: 'Dr. M', role: 'หัวหน้า' };

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [mode, setMode] = useState<'person' | 'manual'>('person');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pwRef = useRef<HTMLInputElement | null>(null);

  // Focus the password field whenever the person mode is (re)shown.
  useEffect(() => {
    if (mode === 'person') pwRef.current?.focus();
  }, [mode]);

  async function submit(useEmail?: string) {
    if (busy) return;
    const em = (useEmail ?? email).trim();
    if (!em) return setError('กรุณากรอกอีเมล');
    if (!password) return setError('กรุณากรอกรหัสผ่าน');
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, password);
      if (agent.role !== 'supervisor') {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าระบบการเงิน (เฉพาะหัวหน้า)');
        setBusy(false);
        return;
      }
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      setPassword('');
      setTimeout(() => pwRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-emerald-700 mb-1">
          <Landmark size={24} />
          <h1 className="text-xl font-bold">Juno</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">ระบบการเงิน · เข้าสู่ระบบ</p>

        {mode === 'person' ? (
          <>
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5 mb-3">
              <UserCircle2 size={22} className="text-emerald-600 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-slate-800">{PERSON.label}</div>
                <div className="text-[11px] text-emerald-600">{PERSON.role}</div>
              </div>
            </div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่านของ {PERSON.label}</label>
            <input
              ref={pwRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(PERSON.email)}
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            <button
              onClick={() => submit(PERSON.email)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
            </button>
            <button
              type="button"
              onClick={() => { setMode('manual'); setError(''); }}
              className="w-full mt-3 text-[11px] text-slate-400 hover:text-slate-600"
            >
              เข้าสู่ระบบด้วยอีเมลอื่น
            </button>
          </>
        ) : (
          <>
            <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="name@prominent.local"
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            <button
              onClick={() => submit()}
              disabled={busy}
              className="w-full px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
            </button>
            <button
              type="button"
              onClick={() => { setMode('person'); setError(''); }}
              className="w-full mt-3 text-[11px] text-slate-400 hover:text-slate-600"
            >
              ย้อนกลับ
            </button>
          </>
        )}

        <p className="text-[10px] text-slate-300 mt-4">Juno เปิดให้เฉพาะหัวหน้า (supervisor) เท่านั้น</p>
      </div>
    </div>
  );
}
