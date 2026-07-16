import { useEffect, useState } from 'react';
import { Heart, LogOut, Crown, Users, Upload, LayoutDashboard, ShoppingBag } from 'lucide-react';
import { useHashTab } from '@pantheon/ui';
import { canImport, logout, type Agent } from './lib/api';
import CustomerList from './CustomerList';
import CustomerDetail from './CustomerDetail';
import ImportCustomers from './ImportCustomers';
import ImportSales from './ImportSales';
import Dashboard from './Dashboard';

// Portal-back link (Pantheon). URL from build-time env; hidden when unset, so it stays
// completely inert until VITE_PORTAL_URL is configured (same convention as juno/vesta).
const PORTAL_URL: string | undefined = import.meta.env.VITE_PORTAL_URL;

type View = { screen: 'dashboard' } | { screen: 'list' } | { screen: 'detail'; code: string } | { screen: 'import' } | { screen: 'import-sales' };
// Only the top-level screen is synced to the hash — 'detail' carries a customer code that
// isn't captured there in this pass, so it's deliberately excluded from the hash vocabulary
// (F5 while viewing a customer detail lands back on the list, not the same customer).
type Screen = Exclude<View['screen'], 'detail'>;

// Screen (a plain string union) -> View: a switch per-branch keeps each return a single
// discriminant literal, so it type-checks against the View union (a bare `{ screen: Screen }`
// object literal does not — TS won't distribute a union-valued field across a discriminated
// union target) and stays exhaustive if Screen ever grows.
function screenToView(screen: Screen): View {
  switch (screen) {
    case 'dashboard': return { screen: 'dashboard' };
    case 'list': return { screen: 'list' };
    case 'import': return { screen: 'import' };
    case 'import-sales': return { screen: 'import-sales' };
  }
}

export default function Venus({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const showImport = canImport(agent);
  // Import screens are gated exactly like their nav buttons below, so a shared #import link
  // opened by an agent without import rights falls back to the list instead of a hidden tab.
  const hashScreens: Screen[] = showImport
    ? ['dashboard', 'list', 'import', 'import-sales']
    : ['dashboard', 'list'];
  const [hashScreen, setHashScreen] = useHashTab<Screen>(hashScreens, 'dashboard');
  // view keeps its existing object shape (customer-detail carries `code`); the hash only ever
  // mirrors its top-level `screen`, in both directions.
  const [view, setView] = useState<View>(() => screenToView(hashScreen));

  // Local screen change (nav click, opening/leaving a customer) → mirror into the hash.
  // Skipped for 'detail' since it isn't in the hash vocabulary — the hash just keeps
  // whatever top-level screen was last active underneath it.
  useEffect(() => {
    if (view.screen !== 'detail') setHashScreen(view.screen);
  }, [view.screen, setHashScreen]);

  // Hash changed from outside this state (user edited the URL / opened a shared link in the
  // same tab) → jump the view there.
  useEffect(() => {
    setView((v) => (v.screen === hashScreen ? v : screenToView(hashScreen)));
  }, [hashScreen]);

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <button
            onClick={() => setView({ screen: 'list' })}
            className="flex items-center gap-2 text-rose-600"
          >
            <Heart size={22} />
            <span className="font-bold text-lg">Venus</span>
            <span className="text-slate-400 text-sm hidden sm:inline">· ลูกค้า 360°</span>
          </button>
          <div className="flex items-center gap-3 text-sm">
            {PORTAL_URL && (
              <a href={PORTAL_URL} title="กลับพอร์ทัล Pantheon" className="flex items-center gap-1 text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <span className="text-slate-500 hidden sm:inline">{agent.name}</span>
            <button onClick={() => { void logout(); onLogout(); }} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 flex gap-1 overflow-x-auto">
          <button
            onClick={() => setView({ screen: 'dashboard' })}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
              view.screen === 'dashboard'
                ? 'border-rose-600 text-rose-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <LayoutDashboard size={16} /> แดชบอร์ด
          </button>
          <button
            onClick={() => setView({ screen: 'list' })}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
              view.screen === 'list' || view.screen === 'detail'
                ? 'border-rose-600 text-rose-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Users size={16} /> รายชื่อลูกค้า
          </button>
          {showImport && (
            <button
              onClick={() => setView({ screen: 'import' })}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
                view.screen === 'import' ? 'border-rose-600 text-rose-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Upload size={16} /> นำเข้าลูกค้า
            </button>
          )}
          {showImport && (
            <button
              onClick={() => setView({ screen: 'import-sales' })}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
                view.screen === 'import-sales' ? 'border-rose-600 text-rose-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <ShoppingBag size={16} /> นำเข้าการขาย
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5">
        {view.screen === 'dashboard' && (
          <Dashboard onOpen={(code) => setView({ screen: 'detail', code })} canManage={showImport} />
        )}
        {view.screen === 'list' && (
          <CustomerList onOpen={(code) => setView({ screen: 'detail', code })} />
        )}
        {view.screen === 'detail' && (
          <CustomerDetail code={view.code} onBack={() => setView({ screen: 'list' })} />
        )}
        {view.screen === 'import' && showImport && <ImportCustomers />}
        {view.screen === 'import-sales' && showImport && <ImportSales />}
      </main>
    </div>
  );
}
