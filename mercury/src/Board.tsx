import { useCallback, useEffect, useState } from 'react';
import { LogOut, RefreshCw, ShoppingCart, PackagePlus, ClipboardList, Loader2 } from 'lucide-react';
import AppSwitcher from './AppSwitcher';
import ReorderQueue from './views/ReorderQueue';
import Items from './views/Items';
import Requests from './views/Requests';
import { clearSession, getRequests, type Agent } from './lib/api';

type Tab = 'reorder' | 'items' | 'requests';

const TABS: { id: Tab; label: string; icon: typeof ShoppingCart }[] = [
  { id: 'reorder', label: 'คิวสั่งซื้อ', icon: ShoppingCart },
  { id: 'items', label: 'รายการสินค้า', icon: PackagePlus },
  { id: 'requests', label: 'คำขอสั่งซื้อ', icon: ClipboardList },
];

export default function Board({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('reorder');
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  const refreshPending = useCallback(async () => {
    setLoadingCount(true);
    try {
      const { requests } = await getRequests('pending');
      setPendingCount(requests.length);
    } catch {
      setPendingCount(null);
    } finally {
      setLoadingCount(false);
    }
  }, []);

  useEffect(() => { void refreshPending(); }, [refreshPending]);

  function logout() {
    clearSession();
    onLogout();
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <AppSwitcher agent={agent} />
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500 hidden sm:inline">{agent.name}</span>
            <button
              onClick={logout}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-orange-700"
            >
              <LogOut size={16} /> ออก
            </button>
          </div>
        </div>
        <nav className="max-w-5xl mx-auto px-4 flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === id
                  ? 'border-orange-600 text-orange-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon size={16} /> {label}
              {id === 'requests' && pendingCount != null && pendingCount > 0 && (
                <span className="ml-1 rounded-full bg-orange-600 text-white text-[10px] px-1.5 py-0.5 leading-none">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => void refreshPending()}
            title="รีเฟรช"
            className="ml-auto px-2 my-1.5 text-slate-400 hover:text-orange-600"
          >
            {loadingCount ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </nav>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5">
        {tab === 'reorder' && <ReorderQueue onRequested={refreshPending} />}
        {tab === 'items' && <Items />}
        {tab === 'requests' && <Requests onChanged={refreshPending} />}
      </main>
    </div>
  );
}
