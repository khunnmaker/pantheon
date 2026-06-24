import { useState } from 'react';
import Login from './Login';
import Console from './Console';
import { getStoredAgent, getToken, type Agent } from './lib/api';

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() =>
    getToken() ? getStoredAgent() : null,
  );

  if (!agent) {
    return <Login onLogin={setAgent} />;
  }
  return <Console agent={agent} onLogout={() => setAgent(null)} />;
}
