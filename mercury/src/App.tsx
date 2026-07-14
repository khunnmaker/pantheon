import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Login from './Login';
import Board from './Board';
import { bootstrap, getStoredAgent, getToken, hasAppAccess, type Agent } from './lib/api';
import { PORTAL_URL_DEFAULT, clearSsoBounce, redirectToPortalLogin } from '@pantheon/ui';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );
  const [booting, setBooting] = useState<boolean>(() => !getToken());

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
    return <div className="min-h-screen bg-slate-100 flex items-center justify-center text-orange-300"><Loader2 size={22} className="animate-spin" /></div>;
  }

  // Per-grant gate (NOT supervisor-only): anyone with the 'mercury' app grant may enter.
  // Mirrors the server's requireApp('mercury'). Owner-only today (only supervisor is granted).
  if (!agent || !hasAppAccess(agent, 'mercury')) {
    return <Login onLogin={setAgent} />;
  }
  return <Board agent={agent} onLogout={() => setAgent(null)} />;
}
