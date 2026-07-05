// Grant-aware suite app switcher — small pills next to the "Vulcan" title that let a logged-in
// user jump to the OTHER suite apps they can access. The current app (vulcan) shows as a
// highlighted, non-link label; the rest are plain <a href> links that navigate in the same tab.
//
// An app appears iff BOTH: the user has access (hasAppAccess, mirroring the server) AND
// (it is the current app OR its VITE_<APP>_URL build-time env is set). Until those envs are
// configured on Railway, only the current app's label shows — fully inert, no visual change.
import { hasAppAccess, type Agent, type AppName } from './lib/api';

const CURRENT: AppName = 'vulcan';

// Suite app URLs: VITE_*_URL env override (for the future custom-domain cutover), with the
// current Railway production URL as a built-in default so the switcher works everywhere
// without per-service env config. Ceres has no service yet → env-only (stays hidden).
const APP_URL = {
  minerva: import.meta.env.VITE_MINERVA_URL ?? 'https://heroic-contentment-production-16e7.up.railway.app',
  vulcan: import.meta.env.VITE_VULCAN_URL ?? 'https://vulcan-production-dbba.up.railway.app',
  juno: import.meta.env.VITE_JUNO_URL ?? 'https://juno-production-5cea.up.railway.app',
  ceres: import.meta.env.VITE_CERES_URL as string | undefined,
};
const APPS: { app: AppName; label: string; url: string | undefined }[] = [
  { app: 'minerva', label: 'Minerva', url: APP_URL.minerva },
  { app: 'vulcan', label: 'Vulcan', url: APP_URL.vulcan },
  { app: 'juno', label: 'Juno', url: APP_URL.juno },
  { app: 'ceres', label: 'Ceres', url: APP_URL.ceres },
];

export default function AppSwitcher({ agent }: { agent: Agent }) {
  const items = APPS.filter(
    (a) => hasAppAccess(agent, a.app) && (a.app === CURRENT || Boolean(a.url)),
  );
  // Nothing to switch to → render nothing (just the plain title stays, as before).
  if (items.length <= 1) return null;

  return (
    <nav aria-label="สลับแอป" className="flex items-center gap-1">
      {items.map((a) =>
        a.app === CURRENT ? (
          <span
            key={a.app}
            aria-current="page"
            className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700"
          >
            {a.label}
          </span>
        ) : (
          <a
            key={a.app}
            href={a.url}
            title={`ไปที่ ${a.label}`}
            className="px-2 py-0.5 rounded-full text-xs font-medium text-slate-500 hover:text-indigo-700 hover:bg-slate-100"
          >
            {a.label}
          </a>
        ),
      )}
    </nav>
  );
}
