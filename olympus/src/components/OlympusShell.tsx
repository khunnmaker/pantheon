import type { ReactNode } from 'react';
import { ArrowLeft, Flame, LogOut } from 'lucide-react';
import { PORTAL_URL_DEFAULT } from '@pantheon/ui';
import { logout } from '../lib/api';
import type { Route } from '../lib/navigation';
import type { Agent } from '../types';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? PORTAL_URL_DEFAULT;

// Olympus identity shell (plan §4): amber/terracotta header with the owner's name, a link back
// to the Pantheon portal, and logout — wraps both the home page and Hestia.
export default function OlympusShell({ agent, route, onNavigate, onLogout, children }: {
  agent: Agent; route: Route; onNavigate: (route: Route) => void; onLogout: () => void; children: ReactNode;
}) {
  async function signOut() {
    await logout(); // clears the shared SSO cookie + local session (fire-and-forget on network failure)
    onLogout();
  }
  return <div className="min-h-screen bg-amber-50/40">
    <header className="sticky top-0 z-30 border-b border-amber-100 bg-white">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <button onClick={() => onNavigate('home')} className="flex items-center gap-2 font-bold text-amber-700">
          <Flame size={21}/> Olympus{route === 'hestia' && <span className="text-sm font-normal text-stone-400"> / Hestia</span>}
        </button>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-stone-500 sm:inline">{agent.name}</span>
          <a href={PORTAL_URL} className="text-stone-400 hover:text-amber-700" title="กลับ Pantheon"><ArrowLeft size={17}/></a>
          <button onClick={() => void signOut()} className="text-stone-400 hover:text-rose-600" title="ออกจากระบบ"><LogOut size={18}/></button>
        </div>
      </div>
    </header>
    <main className="mx-auto max-w-5xl px-4 py-5 pb-20">{children}</main>
  </div>;
}
