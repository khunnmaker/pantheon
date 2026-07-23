import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Login from './Login';
import Ceres from './Ceres';
import InstallAppBanner from './lib/InstallAppBanner';
import { getStoredAgent, getToken, setOnUnauthorized, bootstrap, type Agent } from './lib/api';
import {
  PORTAL_URL_DEFAULT,
  clearSsoBounce,
  isPantheonSite,
  portalLoginUrl,
  redirectToPortalLogin,
  wantsLocalLogin,
} from '@pantheon/ui';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

export default function App() {
  const [agent, setAgent] = useState<Agent | null>(() => (getToken() ? getStoredAgent() : null));
  // Only bootstrap when there's NO local session. If we already have one, this stays false
  // and the app renders exactly as before (no /me call, no delay).
  const [booting, setBooting] = useState<boolean>(() => !getToken());

  // A daily-JWT 401 clears the stored session (lib/api.ts) — also drop back to Login here
  // instead of leaving the app as a dead husk of failed fetches.
  useEffect(() => {
    setOnUnauthorized(() => setAgent(null));
    return () => setOnUnauthorized(null);
  }, []);

  // Suite SSO: with no local token, try the shared parent-domain cookie once via /me before
  // handing a logged-out user to the portal-only entry component below.
  useEffect(() => {
    if (!booting) return;
    let alive = true;
    bootstrap()
      .then((a) => {
        if (!alive) return;
        if (a) { clearSsoBounce(); setAgent(a); setBooting(false); return; }
        setBooting(false);
      })
      .catch(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [booting]);

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center font-sans text-slate-800">
        <Loader2 className="animate-spin text-amber-600" size={28} />
      </div>
    );
  }
  if (!agent) {
    return wantsLocalLogin() || !isPantheonSite()
      ? <Login onLogin={setAgent} />
      : <PortalOnlyEntry />;
  }
  return (
    <>
      <InstallAppBanner />
      <Ceres agent={agent} onLogout={() => setAgent(null)} portalUrl={PORTAL_URL} />
    </>
  );
}

function PortalOnlyEntry() {
  const [redirectBlocked, setRedirectBlocked] = useState(false);

  useEffect(() => {
    // Same one-bounce sessionStorage guard used by Apollo/Juno/Vesta: a failed portal return
    // does not spin forever. Unlike those compatibility screens, Ceres never exposes account
    // cards here; local development and the explicit ?local=1 path mount Login above.
    if (!redirectToPortalLogin(PORTAL_URL)) setRedirectBlocked(true);
  }, []);

  if (!redirectBlocked) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center text-amber-600">
        <Loader2 className="animate-spin" size={28} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center gap-3 px-4 text-center text-slate-700">
      <p className="text-sm">กรุณาเข้าสู่ Ceres ผ่าน Pantheon</p>
      <a
        className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
        href={portalLoginUrl(PORTAL_URL)}
      >
        ไปที่ Pantheon
      </a>
    </div>
  );
}
