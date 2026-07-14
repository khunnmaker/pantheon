import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Workflow } from 'lucide-react';
import { hasAppAccess } from './lib/api';
import type { Agent } from './types';
import type { AppName } from '@pantheon/ui';

const apps: { key: AppName; label: string; url: string }[] = [
  { key: 'apollo', label: 'Apollo', url: import.meta.env.VITE_APOLLO_URL ?? 'https://apollo.prominentdental.com' },
  { key: 'minerva', label: 'Minerva', url: import.meta.env.VITE_MINERVA_URL ?? 'https://minerva.prominentdental.com' },
  { key: 'juno', label: 'Juno', url: import.meta.env.VITE_JUNO_URL ?? 'https://juno.prominentdental.com' },
  { key: 'jupiter', label: 'Jupiter', url: import.meta.env.VITE_JUPITER_URL ?? 'https://jupiter.prominentdental.com' },
  { key: 'vesta', label: 'Vesta', url: import.meta.env.VITE_VESTA_URL ?? 'https://vesta.prominentdental.com' },
  { key: 'ceres', label: 'Ceres', url: import.meta.env.VITE_CERES_URL ?? 'https://ceres.prominentdental.com' },
  { key: 'mercury', label: 'Mercury', url: import.meta.env.VITE_MERCURY_URL ?? 'https://mercury.prominentdental.com' },
];

export default function AppSwitcher({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  const visible = apps.filter((app) => hasAppAccess(agent, app.key));
  useEffect(() => { const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, []);
  if (visible.length <= 1) return <div className="flex items-center gap-2 font-bold text-blue-700"><Workflow size={21}/> Apollo</div>;
  return <div ref={ref} className="relative"><button onClick={() => setOpen(!open)} className="flex items-center gap-2 font-bold text-blue-700"><Workflow size={21}/> Apollo <ChevronDown size={14}/></button>
    {open && <div className="absolute left-0 top-8 z-50 w-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">{visible.filter((a) => a.key !== 'apollo').map((a) => <a key={a.key} href={a.url} className="block px-3 py-2 text-sm text-slate-600 hover:bg-blue-50 hover:text-blue-700">{a.label}</a>)}</div>}
  </div>;
}
