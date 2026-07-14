import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Login from './Login';
import Console from './Console';
import { getStoredAgent, getToken, bootstrap, type Agent } from './lib/api';
import { PORTAL_URL_DEFAULT, clearSsoBounce, redirectToPortalLogin } from '@pantheon/ui';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );
  // Only bootstrap when there's NO local session. If we already have one, this stays false
  // and the app renders exactly as before (no /me call, no delay).
  const [booting, setBooting] = useState<boolean>(() => !getToken());

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
      <div className="min-h-screen flex items-center justify-center text-slate-300">
        <Loader2 size={22} className="animate-spin" />
      </div>
    );
  }
  if (!agent) {
    return <Login onLogin={setAgent} />;
  }
  return <Console agent={agent} onLogout={() => setAgent(null)} />;
}
