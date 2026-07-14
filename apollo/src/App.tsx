import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PORTAL_URL_DEFAULT, clearSsoBounce, redirectToPortalLogin } from '@pantheon/ui';
import Login from './Login';
import Workspace from './Workspace';
import { bootstrap, getStoredAgent, getToken, hasAppAccess } from './lib/api';
import type { Agent } from './types';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() => getToken() ? getStoredAgent() : null);
  const [booting, setBooting] = useState(() => !getToken());
  useEffect(() => {
    if (!booting) return; let alive = true;
    void bootstrap().then((value) => { if (!alive) return; if (value) { clearSsoBounce(); setAgent(value); setBooting(false); return; } if (redirectToPortalLogin(PORTAL_URL)) return; setBooting(false); }).catch(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [booting]);
  if (booting) return <div className="min-h-screen grid place-items-center text-blue-400"><Loader2 className="animate-spin"/></div>;
  if (!agent || !hasAppAccess(agent, 'apollo')) return <Login onLogin={setAgent}/>;
  return <Workspace agent={agent} onLogout={() => setAgent(null)}/>;
}
