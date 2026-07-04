import { useEffect, useState } from 'react';
import { Heart, ShieldOff } from 'lucide-react';
import Login from './Login';
import Venus from './Venus';
import { getStoredAgent, getToken, setOnUnauthorized, setOnForbidden, clearSession, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );
  // Access to Venus is per-grant (requireApp('venus') server-side) — the login screen
  // does not block by role, so a logged-in-but-ungranted account (e.g. an employee not
  // yet granted) is only discovered when the app's first authenticated data call 403s.
  const [forbidden, setForbidden] = useState(false);

  // A daily-JWT 401 clears the stored session (lib/api.ts) — also drop back to Login here
  // instead of leaving the app as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  // A 403 (authed but ungranted) keeps the session — show a friendly no-access state
  // instead of Venus's screens spinning/erroring on every fetch.
  useEffect(() => {
    setOnForbidden(() => setForbidden(true));
    return () => setOnForbidden(null);
  }, []);

  useEffect(() => {
    setForbidden(false);
  }, [agent]);

  if (!agent) {
    return <Login onLogin={setAgent} />;
  }

  if (forbidden) {
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
            onClick={() => { clearSession(); setAgent(null); setForbidden(false); }}
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
