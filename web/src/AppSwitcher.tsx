// Grant-aware suite app switcher — small pills next to the Minerva title/icon that let a
// logged-in user jump to the OTHER suite apps they can access. The current app (minerva) shows
// as a highlighted, non-link label; the rest are plain <a href> links (same-tab navigation).
//
// An app appears iff BOTH: the user has access (hasAppAccess, mirroring the server) AND
// (it is the current app OR its VITE_<APP>_URL build-time env is set). Until those envs are
// configured on Railway, only the current app's label shows — fully inert, no visual change.
import { hasAppAccess, type Agent, type AppName } from './lib/api';

const CURRENT: AppName = 'minerva';

// URL for each OTHER suite app, from the same VITE_*_URL convention as VITE_PORTAL_URL.
// The current app needs no URL (it is just the active label).
const APPS: { app: AppName; label: string; url: string | undefined }[] = [
  { app: 'minerva', label: 'Minerva', url: undefined },
  { app: 'vulcan', label: 'Vulcan', url: import.meta.env.VITE_VULCAN_URL },
  { app: 'juno', label: 'Juno', url: import.meta.env.VITE_JUNO_URL },
  { app: 'ceres', label: 'Ceres', url: import.meta.env.VITE_CERES_URL },
];

export default function AppSwitcher({ agent }: { agent: Agent }) {
  const items = APPS.filter(
    (a) => hasAppAccess(agent, a.app) && (a.app === CURRENT || Boolean(a.url)),
  );
  // Nothing to switch to → render nothing (just the Minerva icon stays, as before).
  if (items.length <= 1) return null;

  return (
    <nav aria-label="สลับแอป" className="flex items-center gap-1">
      {items.map((a) =>
        a.app === CURRENT ? (
          <span
            key={a.app}
            aria-current="page"
            className="px-2 py-0.5 rounded-full text-xs font-semibold bg-sky-100 text-sky-700"
          >
            {a.label}
          </span>
        ) : (
          <a
            key={a.app}
            href={a.url}
            title={`ไปที่ ${a.label}`}
            className="px-2 py-0.5 rounded-full text-xs font-medium text-slate-500 hover:text-sky-700 hover:bg-slate-100"
          >
            {a.label}
          </a>
        ),
      )}
    </nav>
  );
}
