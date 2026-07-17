import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Login from './Login';
import Portal from './Portal';
import { bootstrap, getStoredAgent, getToken, setOnUnauthorized, type Agent } from './lib/api';
import { canOpen, type AppDef } from './lib/apps';
import { resolveRedirect } from './lib/redirect';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() => getToken() ? getStoredAgent() : null);
  const [booting, setBooting] = useState(() => !getToken());
  const [target] = useState(() => resolveRedirect(location.search));
  const [denied, setDenied] = useState<AppDef | null>(null);

  function finishLogin(a: Agent): boolean {
    if (!target) {
      setAgent(a);
      return false;
    }
    // canOpen (not hasAppAccess): supervisorOnly targets like Olympus complete their redirect
    // ONLY for the live supervisor role — a staff account (even one with an accidental
    // 'olympus' grant in Agent.apps) stays here in Pantheon with the denied banner.
    if (canOpen(a, target.app)) {
      location.replace(target.url.href);
      return true;
    }
    setDenied(target.app);
    setAgent(a);
    return false;
  }

  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  useEffect(() => {
    if (!booting) return;
    let alive = true;
    bootstrap()
      .then((a) => {
        if (!alive) return;
        if (a && finishLogin(a)) return;
        setBooting(false);
      })
      .catch(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [booting]);

  if (booting) {
    return <div className="min-h-screen bg-gradient-to-b from-violet-50 to-slate-100 flex items-center justify-center text-violet-300"><Loader2 size={22} className="animate-spin" /></div>;
  }
  if (!agent) return <Login onLogin={finishLogin} target={target?.app ?? null} />;
  return <Portal agent={agent} onLogout={() => setAgent(null)} denied={denied} onDismissDenied={() => setDenied(null)} />;
}
