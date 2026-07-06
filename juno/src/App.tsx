import { useEffect, useState } from 'react';
import Login from './Login';
import Juno from './Juno';
import { getStoredAgent, getToken, setOnUnauthorized, hasAppAccess, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );

  // A daily-JWT 401 clears the stored session (lib/api.ts) — also drop back to Login here
  // instead of leaving the app as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  if (!agent || !hasAppAccess(agent, 'juno')) {
    return <Login onLogin={setAgent} />;
  }
  return <Juno agent={agent} onLogout={() => setAgent(null)} />;
}
