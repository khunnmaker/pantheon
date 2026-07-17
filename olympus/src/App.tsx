import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { PORTAL_URL_DEFAULT, clearSsoBounce, redirectToPortalLogin } from '@pantheon/ui';
import Login from './Login';
import OlympusHome from './OlympusHome';
import Hestia from './Hestia';
import OlympusShell from './components/OlympusShell';
import { bootstrap, getStoredAgent, getToken, isSupervisor } from './lib/api';
import { useRoute } from './lib/navigation';
import type { Agent } from './types';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() => getToken() ? getStoredAgent() : null);
  const [booting, setBooting] = useState(() => !getToken());
  const [route, navigate] = useRoute();

  useEffect(() => {
    if (!booting) return;
    let alive = true;
    void bootstrap().then((value) => {
      if (!alive) return;
      if (value) { clearSsoBounce(); setAgent(value); setBooting(false); return; }
      if (redirectToPortalLogin(PORTAL_URL)) return; // navigating away — leave booting true
      setBooting(false);
    }).catch(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [booting]);

  if (booting) return <div className="min-h-screen grid place-items-center text-amber-500"><Loader2 className="animate-spin"/></div>;
  if (!agent) return <Login onLogin={setAgent}/>;
  if (!isSupervisor(agent)) return <AccessDenied onLogout={() => setAgent(null)}/>;

  return (
    <OlympusShell agent={agent} route={route} onNavigate={navigate} onLogout={() => setAgent(null)}>
      {route === 'hestia' ? <Hestia/> : <OlympusHome agent={agent} onNavigate={navigate}/>}
    </OlympusShell>
  );
}

// Olympus is entirely supervisor-only (plan §1) — a signed-in non-supervisor who reaches this
// app on a valid shared SSO cookie (e.g. by guessing the URL) never sees any Hestia content,
// only this notice. The API's own requireRole('supervisor') hook is the authoritative gate; this
// is UX only.
function AccessDenied({ onLogout }: { onLogout: () => void }) {
  return <div className="min-h-screen bg-amber-50 flex items-center justify-center p-6">
    <div className="w-full max-w-sm rounded-2xl border border-amber-100 bg-white p-6 text-center shadow-sm">
      <ShieldAlert className="mx-auto text-amber-500" size={32}/>
      <h1 className="mt-3 text-lg font-bold text-stone-800">หน้านี้จำกัดเฉพาะหัวหน้า</h1>
      <p className="mt-1 text-sm text-stone-500">บัญชีนี้ไม่มีสิทธิ์เข้าใช้ Olympus</p>
      <a href={PORTAL_URL} className="mt-4 inline-block rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700">กลับไป Pantheon</a>
      <button onClick={onLogout} className="mt-3 block w-full text-xs text-stone-400 hover:text-rose-600">ออกจากระบบ</button>
    </div>
  </div>;
}
