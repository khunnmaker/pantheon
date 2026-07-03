import { useEffect, useRef, useState } from 'react';
import { Bot, LogIn, Loader2, AlertTriangle, UserCircle2 } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';

// Owner-approved name-first layout (same as Vulcan/Juno): a vertical list of person
// cards — Dr. M on top, the team under his name — and NO credential box until a name
// is selected. Selecting an agent reveals a 6-digit PIN input (auto-submits on the 6th
// digit); selecting Dr. M reveals a password field (the supervisor never uses a PIN).
// The manual email/password form stays as a fallback (and keeps agents working via
// STAFF_PASSWORD for as long as AGENT_PINS isn't configured).
const QUICK = [
  { email: 'drm@prominent.local', label: 'Dr. M', role: 'supervisor' as const },
  { email: 'nadeer@prominent.local', label: 'NaDeer', role: 'agent' as const },
  { email: 'anny@prominent.local', label: 'Anny', role: 'agent' as const },
  { email: 'noey@prominent.local', label: 'Noey', role: 'agent' as const },
];
type Person = (typeof QUICK)[number];

export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [view, setView] = useState<'list' | 'manual'>('list');
  const [selected, setSelected] = useState<Person | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const credRef = useRef<HTMLInputElement>(null);

  // Focus the credential input as soon as a person is picked (or re-picked).
  useEffect(() => {
    if (selected) setTimeout(() => credRef.current?.focus(), 0);
  }, [selected]);

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
      setError('รหัสไม่ถูกต้อง');
      // PIN attempts are one-shot — clear and refocus so the agent just retypes.
      setPin('');
      setTimeout(() => credRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  function pick(q: Person) {
    setError('');
    setPin('');
    setPassword('');
    // Tapping the already-selected card collapses it back to the plain list.
    setSelected((cur) => (cur?.email === q.email ? null : q));
  }

  function onPinChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setPin(digits);
    if (digits.length === 6 && selected) {
      void submit(selected.email, digits);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-sky-700 mb-1">
          <Bot size={24} />
          <h1 className="text-xl font-bold">Minerva</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">คอนโซลพนักงาน · เข้าสู่ระบบ</p>

        {view === 'list' ? (
          <>
            <div className="space-y-2">
              {QUICK.map((q) => {
                const isSel = selected?.email === q.email;
                const isSup = q.role === 'supervisor';
                return (
                  <div key={q.email}>
                    <button
                      type="button"
                      onClick={() => pick(q)}
                      className={
                        'w-full flex items-center gap-2 rounded-xl px-3 py-2.5 border text-left transition-colors ' +
                        (isSel
                          ? 'bg-sky-50 border-sky-200'
                          : 'bg-white border-slate-200 hover:bg-slate-50')
                      }
                    >
                      <UserCircle2 size={22} className={isSel ? 'text-sky-600 shrink-0' : 'text-slate-400 shrink-0'} />
                      <div>
                        <div className="text-sm font-semibold text-slate-800">{q.label}</div>
                        <div className={'text-[11px] ' + (isSel ? 'text-sky-600' : 'text-slate-400')}>
                          {isSup ? 'หัวหน้า' : 'พนักงาน'}
                        </div>
                      </div>
                    </button>

                    {/* Credential box appears ONLY under the selected name. */}
                    {isSel && (
                      <div className="mt-2 mb-1 px-1">
                        {isSup ? (
                          <>
                            <label className="block text-xs font-semibold text-slate-500 mb-1">
                              รหัสผ่านของ {q.label}
                            </label>
                            <input
                              ref={credRef}
                              type="password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && submit(q.email, password)}
                              disabled={busy}
                              className="w-full px-3 py-2 mb-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:opacity-50"
                            />
                            {error && (
                              <div className="flex items-center gap-1 text-rose-600 text-xs mb-2">
                                <AlertTriangle size={13} /> {error}
                              </div>
                            )}
                            <button
                              onClick={() => submit(q.email, password)}
                              disabled={busy}
                              className="w-full px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
                            >
                              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
                            </button>
                          </>
                        ) : (
                          <>
                            <label className="block text-xs font-semibold text-slate-500 mb-1">
                              รหัส PIN 6 หลักของ {q.label}
                            </label>
                            <input
                              ref={credRef}
                              type="password"
                              inputMode="numeric"
                              autoComplete="current-password"
                              maxLength={6}
                              value={pin}
                              onChange={(e) => onPinChange(e.target.value)}
                              disabled={busy}
                              className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-2xl tracking-[0.5em] text-center focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:opacity-50"
                            />
                            {busy && (
                              <div className="flex items-center justify-center gap-1 text-slate-400 text-xs mt-2">
                                <Loader2 size={13} className="animate-spin" /> กำลังเข้าสู่ระบบ...
                              </div>
                            )}
                            {error && (
                              <div className="flex items-center justify-center gap-1 text-rose-600 text-xs mt-2">
                                <AlertTriangle size={13} /> {error}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => { setView('manual'); setSelected(null); setError(''); }}
              className="w-full mt-4 text-[11px] text-slate-400 hover:text-slate-600"
            >
              เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน
            </button>
          </>
        ) : (
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
            <button
              type="button"
              onClick={() => { setView('list'); setError(''); }}
              className="w-full mt-3 text-[11px] text-slate-400 hover:text-slate-600"
            >
              ย้อนกลับ
            </button>
          </>
        )}
      </div>
    </div>
  );
}
