// Grant-aware suite app switcher — a dropdown anchored on the current app's own brand
// (icon+name) that lets a logged-in user jump to the OTHER suite apps they can access.
// Clicking the brand reveals the other apps as icon+text rows; when there's nowhere to
// switch to, the brand renders exactly as it did before the switcher existed (no chevron,
// non-interactive).
//
// An app appears iff BOTH: the user has access (hasAppAccess, mirroring the server) AND
// (it is the current app OR its VITE_<APP>_URL build-time env is set). Until those envs are
// configured on Railway, only the current app's label shows — fully inert, no visual change.
import { useEffect, useRef, useState } from 'react';
import { Bot, Boxes, Wallet, Coins, ShoppingCart, ChevronDown } from 'lucide-react';
import { hasAppAccess, type Agent, type AppName } from './lib/api';

const CURRENT: AppName = 'juno';

// Suite app URLs: VITE_*_URL env override (for the future custom-domain cutover), with the
// current Railway production URL as a built-in default so the switcher works everywhere
// without per-service env config. Ceres has no service yet → env-only (stays hidden).
const APP_URL = {
  minerva: import.meta.env.VITE_MINERVA_URL ?? 'https://heroic-contentment-production-16e7.up.railway.app',
  vulcan: import.meta.env.VITE_VULCAN_URL ?? 'https://vulcan-production-dbba.up.railway.app',
  juno: import.meta.env.VITE_JUNO_URL ?? 'https://juno-production-5cea.up.railway.app',
  ceres: import.meta.env.VITE_CERES_URL as string | undefined,
  mercury: import.meta.env.VITE_MERCURY_URL as string | undefined,
};
const APPS: { app: AppName; label: string; url: string | undefined }[] = [
  { app: 'minerva', label: 'Minerva', url: APP_URL.minerva },
  { app: 'vulcan', label: 'Vulcan', url: APP_URL.vulcan },
  { app: 'juno', label: 'Juno', url: APP_URL.juno },
  { app: 'ceres', label: 'Ceres', url: APP_URL.ceres },
  { app: 'mercury', label: 'Mercury', url: APP_URL.mercury },
];

const APP_ICON: Record<AppName, typeof Bot> = {
  minerva: Bot,
  vulcan: Boxes,
  juno: Wallet,
  ceres: Coins,
  mercury: ShoppingCart,
};

export default function AppSwitcher({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const items = APPS.filter(
    (a) => hasAppAccess(agent, a.app) && (a.app === CURRENT || Boolean(a.url)),
  );

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // Nothing to switch to → render the brand exactly as it looked before the switcher existed:
  // just the plain "Juno" text, no icon, no chevron, non-interactive.
  if (items.length <= 1) {
    return <span className="font-bold text-lg">Juno</span>;
  }

  const others = items.filter((a) => a.app !== CURRENT);

  return (
    <div className="relative" ref={containerRef} aria-label="สลับแอป">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 font-bold text-lg hover:opacity-80"
      >
        <Wallet size={20} />
        Juno
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-50 mt-1 min-w-[10rem] bg-white rounded-md shadow-lg border border-gray-200 overflow-hidden"
        >
          {others.map((a) => {
            const Icon = APP_ICON[a.app];
            return (
              <a
                key={a.app}
                href={a.url}
                role="menuitem"
                title={`ไปที่ ${a.label}`}
                className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-emerald-50 hover:text-emerald-700"
              >
                <Icon size={16} />
                {a.label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
