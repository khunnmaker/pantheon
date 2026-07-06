import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Login from './Login';
import Portal from './Portal';
import { getStoredAgent, getToken, setOnUnauthorized, bootstrap, type Agent } from './lib/api';

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
      .then((a) => { if (alive && a) setAgent(a); })
      .finally(() => { if (alive) setBooting(false); });
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
  return <Portal agent={agent} onLogout={() => setAgent(null)} />;
}
