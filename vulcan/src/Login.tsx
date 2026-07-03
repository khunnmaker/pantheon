import { useState } from 'react';
import { Boxes, LogIn, Loader2, AlertTriangle } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';

// Quick-login chips (mirrors the Minerva console's Login). Vulcan is supervisor-only,
// so only accounts that can actually get in are listed — agents would just be rejected.
const QUICK = [
  { email: 'drm@prominent.local', label: 'Dr. M' },
];

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(useEmail?: string) {
    if (busy) return;
    const em = (useEmail ?? email).trim();
    // Say WHY nothing happens instead of a silent no-op button.
    if (!em) return setError('กรุณากรอกอีเมล');
    if (!password) return setError('กรุณากรอกรหัสผ่าน');
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, password);
      if (agent.role !== 'supervisor') {
        setError('บัญชีนี้ไม่มีสิทธิ์จัดการสต็อก (เฉพาะหัวหน้า)');
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
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-indigo-700 mb-1">
          <Boxes size={24} />
          <h1 className="text-xl font-bold">Vulcan</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">จัดการสต็อกสินค้า · เข้าสู่ระบบ</p>

        <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="name@prominent.local"
          className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
            <AlertTriangle size={13} /> {error}
          </div>
        )}

        <button
          onClick={() => submit()}
          disabled={busy}
          className="w-full px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
        </button>

        <div className="mt-4 pt-3 border-t border-slate-100">
          <p className="text-[11px] text-slate-400 mb-2">เลือกชื่อผู้ใช้ (พิมพ์รหัสผ่านในช่องด้านบนก่อน):</p>
          <div className="flex flex-wrap gap-1">
            {QUICK.map((q) => (
              <button
                key={q.email}
                onClick={() => { setEmail(q.email); submit(q.email); }}
                disabled={busy}
                className="text-xs px-2 py-1 rounded-lg bg-slate-100 hover:bg-indigo-100 text-slate-600 border border-slate-200 disabled:opacity-50"
              >
                {q.label}<span className="text-indigo-600"> · หัวหน้า</span>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-300 mt-2">Vulcan เปิดให้เฉพาะหัวหน้า (supervisor) เท่านั้น</p>
        </div>
      </div>
    </div>
  );
}
