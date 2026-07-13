import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Login from './Login';
import Ceres from './Ceres';
import { getStoredAgent, getToken, setOnUnauthorized, bootstrap, type Agent } from './lib/api';
import { PORTAL_URL_DEFAULT, clearSsoBounce, redirectToPortalLogin } from '@pantheon/ui';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() => (getToken() ? getStoredAgent() : null));
  // Only bootstrap when there's NO local session. If we already have one, this stays false
  // and the app renders exactly as before (no /me call, no delay).
  const [booting, setBooting] = useState<boolean>(() => !getToken());

  // A daily-JWT 401 clears the stored session (lib/api.ts) — also drop back to Login here
  // instead of leaving the app as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  // Suite SSO: with no local token, try the shared parent-domain cookie once via /me before
  // falling back to Login — so an already-signed-in teammate lands straight in the app instead
  // of flashing the Login screen.
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
      <div className="min-h-screen bg-slate-100 flex items-center justify-center font-sans text-slate-800">
        <Loader2 className="animate-spin text-amber-600" size={28} />
      </div>
    );
  }
  if (!agent) {
    return <Login onLogin={setAgent} />;
  }
  return <Ceres agent={agent} onLogout={() => setAgent(null)} />;
}
