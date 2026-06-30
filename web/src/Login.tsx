import { useState } from 'react';
import { Bot, LogIn, Loader2, AlertTriangle } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';

const QUICK = [
  { email: 'drm@prominent.local', label: 'Dr. M', role: 'supervisor' },
  { email: 'nadeer@prominent.local', label: 'NaDeer', role: 'agent' },
  { email: 'anny@prominent.local', label: 'Anny', role: 'agent' },
  { email: 'noey@prominent.local', label: 'Noey', role: 'agent' },
];

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(useEmail?: string) {
    const em = (useEmail ?? email).trim();
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
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-sky-700 mb-1">
          <Bot size={24} />
          <h1 className="text-xl font-bold">Minerva</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">เข้าสู่ระบบ</p>

        <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="name@prominent.local"
          className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
        />

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
            <AlertTriangle size={13} /> {error}
          </div>
        )}

        <button
          onClick={() => submit()}
          disabled={busy}
          className="w-full px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
        </button>

        <div className="mt-4 pt-3 border-t border-slate-100">
          <p className="text-[11px] text-slate-400 mb-2">เลือกชื่อพนักงาน (พิมพ์รหัสผ่านในช่องด้านบนก่อน):</p>
          <div className="flex flex-wrap gap-1">
            {QUICK.map((q) => (
              <button
                key={q.email}
                onClick={() => { setEmail(q.email); submit(q.email); }}
                disabled={busy}
                className="text-xs px-2 py-1 rounded-lg bg-slate-100 hover:bg-sky-100 text-slate-600 border border-slate-200 disabled:opacity-50"
              >
                {q.label}
                {q.role === 'supervisor' && <span className="text-sky-600"> · หัวหน้า</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
