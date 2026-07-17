import { useEffect, useState } from 'react';
import { Flame, LogIn, Loader2 } from 'lucide-react';
import { getLogins, login, setSession } from './lib/api';
import type { Agent } from './types';

type Card = Awaited<ReturnType<typeof getLogins>>[number];

// Only reached via `?local=1` (App.tsx tries the shared-cookie SSO boot first) — the login-card
// list here is `GET /api/auth/logins?app=olympus`, which the server scopes to the supervisor
// alone (plan §1), so there is at most one card.
export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void getLogins().then(setCards).catch(() => undefined); }, []);

  async function submit(selectedEmail = email, secret = password) {
    if (!selectedEmail || !secret || busy) return;
    setBusy(true); setError('');
    try {
      const out = await login(selectedEmail, secret);
      if (out.agent.role !== 'supervisor') throw new Error('forbidden');
      setSession(out.token, out.agent); onLogin(out.agent);
    } catch (err) {
      setError(err instanceof Error && err.message === 'forbidden' ? 'บัญชีนี้ไม่มีสิทธิ์ใช้ Olympus' : 'อีเมลหรือรหัสไม่ถูกต้อง');
    } finally { setBusy(false); }
  }

  return <div className="min-h-screen bg-amber-50 flex items-center justify-center p-5">
    <div className="w-full max-w-lg rounded-2xl border border-amber-100 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2 text-amber-700"><Flame size={25}/><h1 className="text-xl font-bold">Olympus</h1></div>
      <p className="mt-1 text-sm text-slate-500">พื้นที่ส่วนตัว · Hestia</p>
      {!!cards.length && <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {cards.map((card) => <button key={card.email} onClick={() => { setEmail(card.email); setPassword(''); }} className={`rounded-xl border px-3 py-3 text-sm font-medium ${email === card.email ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-slate-200 hover:border-amber-300'}`}>{card.name}</button>)}
      </div>}
      <label className="mt-5 block text-xs font-semibold text-slate-500">อีเมล</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2" placeholder="name@prominent.local"/>
      <label className="mt-3 block text-xs font-semibold text-slate-500">รหัสผ่าน / PIN</label>
      <input type="password" value={password} autoFocus={!!email} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"/>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      <button onClick={() => void submit()} disabled={busy || !email || !password} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="animate-spin" size={17}/> : <LogIn size={17}/>} เข้าสู่ระบบ</button>
      <p className="mt-4 text-center text-[11px] text-slate-400">เพิ่ม <b>?local=1</b> ที่ URL เพื่อใช้หน้าล็อกอินนี้โดยไม่ผ่าน Pantheon</p>
    </div>
  </div>;
}
