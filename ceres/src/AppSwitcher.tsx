// Grant-aware suite app switcher — copy-adapted from juno/src/AppSwitcher.tsx (2026-07-18,
// Ceres desktop nav) so the two apps share the same visual grammar. A dropdown anchored on
// the current app's own brand (icon+name) that lets a logged-in user jump to the OTHER suite
// apps they can access. Clicking the brand reveals the other apps as icon+text rows; when
// there's nowhere to switch to, the brand renders exactly as it did before the switcher
// existed (no chevron, non-interactive).
//
// An app appears iff BOTH: the user has access (hasAppAccess, mirroring the server) AND
// (it is the current app OR its VITE_<APP>_URL build-time env is set).
import { useEffect, useRef, useState } from 'react';
import { Bot, Boxes, Wallet, Scale, Coins, ShoppingCart, ChevronDown, Users, Globe, Workflow } from 'lucide-react';
import { hasAppAccess, type Agent, type AppName } from './lib/api';

const CURRENT: AppName = 'ceres';

// Suite app URLs: VITE_*_URL env override, with the canonical *.prominentdental.com subdomain
// as the built-in default — must be same-site with the api for the shared SSO cookie (see
// juno/src/AppSwitcher.tsx for the full explanation).
const APP_URL = {
  minerva: import.meta.env.VITE_MINERVA_URL ?? 'https://minerva.prominentdental.com',
  vesta: import.meta.env.VITE_VESTA_URL ?? 'https://vesta.prominentdental.com',
  juno: import.meta.env.VITE_JUNO_URL ?? 'https://juno.prominentdental.com',
  jupiter: import.meta.env.VITE_JUPITER_URL ?? 'https://jupiter.prominentdental.com',
  ceres: import.meta.env.VITE_CERES_URL ?? 'https://ceres.prominentdental.com',
  mercury: import.meta.env.VITE_MERCURY_URL ?? 'https://mercury.prominentdental.com',
  apollo: import.meta.env.VITE_APOLLO_URL ?? 'https://apollo.prominentdental.com',
};
const APPS: { app: AppName; label: string; url: string | undefined }[] = [
  { app: 'minerva', label: 'Minerva', url: APP_URL.minerva },
  { app: 'vesta', label: 'Vesta', url: APP_URL.vesta },
  { app: 'juno', label: 'Juno', url: APP_URL.juno },
  { app: 'jupiter', label: 'Jupiter', url: APP_URL.jupiter },
  { app: 'ceres', label: 'Ceres', url: APP_URL.ceres },
  { app: 'mercury', label: 'Mercury', url: APP_URL.mercury },
  { app: 'apollo', label: 'Apollo', url: APP_URL.apollo },
];

// Canonical AppName carries all 8 suite apps (venus, diana included); this Record must
// enumerate every one. venus/diana have no switcher entry (not in APPS) so their icons are
// inert placeholders — present only to keep the Record exhaustive.
const APP_ICON: Record<AppName, typeof Bot> = {
  minerva: Bot,
  vesta: Boxes,
  juno: Wallet,
  jupiter: Scale,
  ceres: Coins,
  mercury: ShoppingCart,
  venus: Users,
  diana: Globe,
  apollo: Workflow,
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
  // just the plain "Ceres" text + icon, no chevron, non-interactive.
  if (items.length <= 1) {
    return (
      <span className="flex items-center gap-2 font-bold text-lg">
        <Coins size={22} /> Ceres
      </span>
    );
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
        <Coins size={22} />
        Ceres
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
                className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-amber-50 hover:text-amber-700"
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
