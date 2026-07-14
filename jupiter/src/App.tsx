import { useEffect, useState } from 'react';
import { Loader2, LogOut } from 'lucide-react';
import Login from './Login';
import Accounting from './Accounting';
import { getStoredAgent, getToken, setOnUnauthorized, bootstrap, hasAppAccess, logout, type Agent } from './lib/api';
import { PORTAL_URL_DEFAULT, clearSsoBounce, redirectToPortalLogin } from '@pantheon/ui';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );
  // Only bootstrap when there's NO local session. If we already have one, this stays false
  // and the portal renders exactly as before (no /me call, no delay).
  const [booting, setBooting] = useState<boolean>(() => !getToken());

  // A JWT 401 clears the stored session (lib/api.ts) — drop back to Login here too
  // instead of leaving the portal as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  // Suite SSO: with no local token, try the shared parent-domain cookie once via /me before
  // falling back to Login — so an already-signed-in teammate lands straight in the portal
  // instead of flashing the Login screen.
  useEffect(() => {
    if (!booting) return;
    let alive = true;
    bootstrap()
      .then((a) => {
        if (!alive) return;
        if (a) { clearSsoBounce(); setAgent(a); setBooting(false); return; }
        // No suite session. Bounce to the central Pantheon login unless a guard says local.
        if (redirectToPortalLogin(PORTAL_URL)) return;
        setBooting(false);
      })
      .catch(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [booting]);

  if (booting) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-violet-50 to-slate-100 flex items-center justify-center text-violet-300">
        <Loader2 size={22} className="animate-spin" />
      </div>
    );
  }
  if (!agent) return <Login onLogin={setAgent} />;
  if (!hasAppAccess(agent, 'jupiter')) {
    return (
      <div className="min-h-screen bg-violet-50 flex items-center justify-center p-6">
        <div className="bg-white border border-violet-100 rounded-2xl p-6 text-center shadow-sm">
          <p className="text-slate-700 mb-4">ไม่มีสิทธิ์เข้าใช้งาน</p>
          <button onClick={() => { void logout(); setAgent(null); }} className="inline-flex items-center gap-1 text-sm text-violet-700 hover:text-violet-900"><LogOut size={15} /> ออกจากระบบ</button>
        </div>
      </div>
    );
  }
  return <Accounting onLogout={() => setAgent(null)} />;
}
