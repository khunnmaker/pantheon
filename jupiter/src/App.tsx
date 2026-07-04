import { useEffect, useState } from 'react';
import Login from './Login';
import Portal from './Portal';
import { getStoredAgent, getToken, setOnUnauthorized, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );

  // A JWT 401 clears the stored session (lib/api.ts) — drop back to Login here too
  // instead of leaving the portal as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  if (!agent) return <Login onLogin={setAgent} />;
  return <Portal agent={agent} onLogout={() => setAgent(null)} />;
}
