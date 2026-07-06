import { useState } from 'react';
import { Building2, Boxes, FileText, Lock, RefreshCw } from 'lucide-react';
import Vendors from './views/Vendors';
import Items from './views/Items';
import PurchaseOrders from './views/PurchaseOrders';
import Sync from './views/Sync';

type Tab = 'items' | 'vendors' | 'sync' | 'pos';

const TABS: { key: Tab; label: string; icon: typeof Boxes }[] = [
  { key: 'items', label: 'รายการ / แผนที่ลับ', icon: Boxes },
  { key: 'vendors', label: 'ผู้ขาย', icon: Building2 },
  { key: 'sync', label: 'ซิงค์ / สร้าง PO', icon: RefreshCw },
  { key: 'pos', label: 'ใบสั่งซื้อ', icon: FileText },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('items');

  return (
    <div className="min-h-screen bg-orange-50/40 text-slate-800">
      {/* Header */}
      <header className="bg-gradient-to-r from-orange-600 to-amber-500 text-white shadow">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white/20 flex items-center justify-center font-bold text-lg">
            M
          </div>
          <div className="flex-1">
            <div className="font-bold leading-tight">Mercury · จัดซื้อ (เครื่องภายใน)</div>
            <div className="text-xs text-orange-100">โหนดความลับภายใน — ข้อมูลไม่ออกจากเครื่องนี้</div>
          </div>
          <div className="inline-flex items-center gap-1 text-xs bg-white/15 rounded-full px-2.5 py-1">
            <Lock size={12} /> LOCAL
          </div>
        </div>
      </header>

      {/* Nav */}
      <nav className="bg-white border-b border-orange-100 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 -mb-px transition ${
                  active
                    ? 'border-orange-600 text-orange-700'
                    : 'border-transparent text-slate-500 hover:text-orange-700'
                }`}
              >
                <Icon size={16} /> {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-5">
        {tab === 'items' && <Items />}
        {tab === 'vendors' && <Vendors />}
        {tab === 'sync' && <Sync />}
        {tab === 'pos' && <PurchaseOrders />}
      </main>
    </div>
  );
}
