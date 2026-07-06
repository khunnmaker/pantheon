import { useState } from 'react';
import Login from './Login';
import Board from './Board';
import { getStoredAgent, getToken, hasAppAccess, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );

  // Per-grant gate (NOT supervisor-only): anyone with the 'mercury' app grant may enter.
  // Mirrors the server's requireApp('mercury'). Owner-only today (only supervisor is granted).
  if (!agent || !hasAppAccess(agent, 'mercury')) {
    return <Login onLogin={setAgent} />;
  }
  return <Board agent={agent} onLogout={() => setAgent(null)} />;
}
