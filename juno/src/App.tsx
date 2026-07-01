import { useState } from 'react';
import Login from './Login';
import Juno from './Juno';
import { getStoredAgent, getToken, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );

  if (!agent || agent.role !== 'supervisor') {
    return <Login onLogin={setAgent} />;
  }
  return <Juno agent={agent} onLogout={() => setAgent(null)} />;
}
