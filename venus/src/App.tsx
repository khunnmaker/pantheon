import { useEffect, useState } from 'react';
import { Heart, ShieldOff, Loader2 } from 'lucide-react';
import Login from './Login';
import Venus from './Venus';
import { getStoredAgent, getToken, setOnUnauthorized, getCustomers, clearSession, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );
  // Access to Venus is per-grant (requireApp('venus') server-side) — the login screen
  // does not block by role, so a logged-in-but-ungranted account is only discovered on
  // the first authenticated data call. null = checking, true = granted, false = 403.
  const [granted, setGranted] = useState<boolean | null>(null);

  // A daily-JWT 401 clears the stored session (lib/api.ts) — also drop back to Login here
  // instead of leaving the app as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  useEffect(() => {
    if (!agent) {
      setGranted(null);
      return;
    }
    setGranted(null);
    getCustomers({ limit: 1, offset: 0 })
      .then(() => setGranted(true))
      .catch((e) => setGranted(e instanceof Error && e.message === 'forbidden' ? false : true));
  }, [agent]);

  if (!agent) {
    return <Login onLogin={setAgent} />;
  }

  if (granted === null) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <Loader2 className="animate-spin text-rose-400" size={28} />
      </div>
    );
  }

  if (granted === false) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-rose-50 to-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
        <div className="bg-white rounded-2xl shadow-sm border border-rose-100 max-w-sm w-full p-6 text-center">
          <div className="flex items-center justify-center gap-2 text-rose-600 mb-3">
            <Heart size={22} />
            <span className="font-bold text-lg">Venus</span>
          </div>
          <div className="flex flex-col items-center gap-2 py-2">
            <ShieldOff size={28} className="text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">ไม่มีสิทธิ์เข้าใช้ Venus</p>
            <p className="text-xs text-slate-400">ยังไม่ได้รับสิทธิ์ — กรุณาติดต่อผู้ดูแลระบบ</p>
          </div>
          <button
            onClick={() => { clearSession(); setAgent(null); }}
            className="w-full mt-4 px-3 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm font-semibold"
          >
            ออกจากระบบ
          </button>
        </div>
      </div>
    );
  }

  return <Venus agent={agent} onLogout={() => setAgent(null)} />;
}
