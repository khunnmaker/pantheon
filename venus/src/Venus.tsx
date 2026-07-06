import { useState } from 'react';
import { Heart, LogOut, Crown, Users, Upload, LayoutDashboard, ShoppingBag } from 'lucide-react';
import { canImport, clearSession, type Agent } from './lib/api';
import CustomerList from './CustomerList';
import CustomerDetail from './CustomerDetail';
import ImportCustomers from './ImportCustomers';
import ImportSales from './ImportSales';
import Dashboard from './Dashboard';

// Portal-back link (Jupiter). URL from build-time env; hidden when unset, so it stays
// completely inert until VITE_PORTAL_URL is configured (same convention as juno/vulcan).
const PORTAL_URL: string | undefined = import.meta.env.VITE_PORTAL_URL;

type View = { screen: 'dashboard' } | { screen: 'list' } | { screen: 'detail'; code: string } | { screen: 'import' } | { screen: 'import-sales' };

export default function Venus({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [view, setView] = useState<View>({ screen: 'dashboard' });
  const showImport = canImport(agent);

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
              <a href={PORTAL_URL} title="กลับพอร์ทัล Jupiter" className="flex items-center gap-1 text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <span className="text-slate-500 hidden sm:inline">{agent.name}</span>
            <button onClick={() => { clearSession(); onLogout(); }} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
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
          <Dashboard onOpen={(code) => setView({ screen: 'detail', code })} />
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
