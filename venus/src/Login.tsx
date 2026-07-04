import { useRef, useState } from 'react';
import { Heart, LogIn, Loader2, AlertTriangle } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';

// Venus login. Unlike Juno (supervisor-only), Venus is open to supervisor + employee
// (agents) — see docs/VENUS_BRIEF.md §3 — so there's no single pre-selected person to
// show. There is also no `app=venus` entry yet in the shared logins-card list
// (AppName in api/src/auth/jwt.ts), so this mirrors Juno's plain email/password form
// rather than the name-card list juno/jupiter show when that endpoint is wired.
export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pwRef = useRef<HTMLInputElement | null>(null);

  async function submit() {
    if (busy) return;
    const em = email.trim();
    if (!em) return setError('กรุณากรอกอีเมล');
    if (!password) return setError('กรุณากรอกรหัสผ่าน');
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, password);
      if (agent.role !== 'supervisor' && agent.role !== 'employee') {
        setError('บัญชีนี้ไม่มีสิทธิ์เข้าระบบ Venus');
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
    <div className="min-h-screen bg-gradient-to-b from-rose-50 to-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-rose-100 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-rose-600 mb-1">
          <Heart size={24} />
          <h1 className="text-xl font-bold">Venus</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">ลูกค้า 360° · เข้าสู่ระบบ</p>

        <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="name@prominent.local"
          className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
        />
        <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน / PIN</label>
        <input
          ref={pwRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
        />
        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
            <AlertTriangle size={13} /> {error}
          </div>
        )}
        <button
          onClick={submit}
          disabled={busy}
          className="w-full px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
        </button>

        <p className="text-[10px] text-slate-300 mt-4">
          Venus เปิดให้หัวหน้าและพนักงาน — การนำเข้าข้อมูลทำได้เฉพาะหัวหน้าเท่านั้น
        </p>
      </div>
    </div>
  );
}
