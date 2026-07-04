import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Boxes, Search, Upload, History, LogOut, AlertTriangle, Check, Loader2,
  Package, RefreshCw, ChevronRight, X, LayoutDashboard, PackageX, PackageCheck,
  HelpCircle, Clock, ArrowRight, Crown, Tag, Wand2,
} from 'lucide-react';

// Portal-back link (Jupiter). URL from build-time env; hidden when unset, so it is completely
// inert until VITE_PORTAL_URL is configured (Phase 1 go-live / Phase 2 domains).
const PORTAL_URL: string | undefined = import.meta.env.VITE_PORTAL_URL;
import {
  type Agent, type StockRow, type StockSummary, type StockImportRow,
  type StockAdjustmentRow, type ImportPreview, type AliasGroup, type AliasItem,
  getSummary, getStockList, adjustStock, setReorderPoint, getImports, getAdjustments,
  previewImport, applyImport, clearSession, API_URL, flatSku,
  getAliases, generateAliases, setGroupPrefix, setAlias,
} from './lib/api';

type Tab = 'dashboard' | 'stock' | 'import' | 'history' | 'alias';
type StockFilter = 'all' | 'low' | 'out' | 'unknown';

// Product photo thumbnail (served public from the shared api). photoSku is the catalog
// photo key (variants share a lead photo); hides itself if the image is missing.
function Thumb({ photoSku, size = 36 }: { photoSku: string | null; size?: number }) {
  if (!photoSku) {
    return (
      <div
        style={{ width: size, height: size }}
        className="shrink-0 rounded bg-slate-100 text-[8px] text-slate-400 flex items-center justify-center text-center leading-none"
      >
        ไม่มีรูป
      </div>
    );
  }
  return (
    <img
      src={`${API_URL}/content/product/${photoSku}`}
      alt=""
      style={{ width: size, height: size }}
      className="shrink-0 rounded object-contain bg-white border border-slate-100"
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
// Stock figure is "stale" if older than ~36h (a daily import should refresh it).
function isStale(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > 36 * 3600 * 1000;
}

export default function Stock({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [summary, setSummary] = useState<StockSummary | null>(null);
  // Stock-tab filter lifted here so the dashboard cards can deep-link into a filtered view.
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');

  const loadSummary = useCallback(() => {
    getSummary().then(setSummary).catch(() => {});
  }, []);
  useEffect(() => loadSummary(), [loadSummary]);

  function goToStock(filter: StockFilter) {
    setStockFilter(filter);
    setTab('stock');
  }

  function logout() {
    clearSession();
    onLogout();
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2 text-indigo-700 font-bold">
            <Boxes size={22} /> Vulcan
          </div>
          <nav className="flex gap-1 text-sm">
            <TabBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')} icon={<LayoutDashboard size={15} />}>
              ภาพรวม
            </TabBtn>
            <TabBtn active={tab === 'stock'} onClick={() => setTab('stock')} icon={<Package size={15} />}>
              สต็อก
            </TabBtn>
            <TabBtn active={tab === 'import'} onClick={() => setTab('import')} icon={<Upload size={15} />}>
              นำเข้าสต็อก
            </TabBtn>
            <TabBtn active={tab === 'history'} onClick={() => setTab('history')} icon={<History size={15} />}>
              ประวัติ
            </TabBtn>
            <TabBtn active={tab === 'alias'} onClick={() => setTab('alias')} icon={<Tag size={15} />}>
              รหัสย่อ
            </TabBtn>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            {summary && (
              <span className="hidden sm:inline">
                {summary.withStock}/{summary.total} มีสต็อก ·{' '}
                <span className={summary.low > 0 ? 'text-rose-600 font-semibold' : ''}>
                  {summary.low} ใกล้หมด
                </span>
              </span>
            )}
            {PORTAL_URL && (
              <a href={PORTAL_URL} title="กลับพอร์ทัล Jupiter" className="flex items-center gap-1 text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <span className="text-slate-400">{agent.name}</span>
            <button onClick={logout} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5">
        {tab === 'dashboard' && (
          <DashboardTab
            summary={summary}
            onGoStock={goToStock}
            onGoImport={() => setTab('import')}
          />
        )}
        {tab === 'stock' && (
          <StockTab filter={stockFilter} setFilter={setStockFilter} onChanged={loadSummary} />
        )}
        {tab === 'import' && (
          <ImportTab
            onApplied={() => {
              loadSummary();
              setTab('stock');
            }}
          />
        )}
        {tab === 'history' && <HistoryTab />}
        {tab === 'alias' && <AliasTab />}
      </main>
    </div>
  );
}

function TabBtn({
  active, onClick, icon, children,
}: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium ${
        active ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {icon} {children}
    </button>
  );
}

// ── Dashboard (landing) ─────────────────────────────────────────────────
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'เมื่อสักครู่';
  if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  const d = Math.floor(h / 24);
  return `${d} วันที่แล้ว`;
}

function MetricCard({
  label, value, tone, icon, onClick,
}: {
  label: string; value: number | string; tone: 'slate' | 'emerald' | 'amber' | 'rose' | 'indigo';
  icon: ReactNode; onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-700 bg-slate-100',
    emerald: 'text-emerald-700 bg-emerald-100',
    amber: 'text-amber-700 bg-amber-100',
    rose: 'text-rose-700 bg-rose-100',
    indigo: 'text-indigo-700 bg-indigo-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`text-left bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3 transition ${
        onClick ? 'hover:border-indigo-300 hover:shadow-sm cursor-pointer' : 'cursor-default'
      }`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tones[tone]}`}>{icon}</div>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-slate-800 leading-tight">{value}</div>
        <div className="text-xs text-slate-500 flex items-center gap-1">
          {label}
          {onClick && <ArrowRight size={11} className="text-slate-300" />}
        </div>
      </div>
    </button>
  );
}

function DashboardTab({
  summary, onGoStock, onGoImport,
}: {
  summary: StockSummary | null;
  onGoStock: (f: StockFilter) => void;
  onGoImport: () => void;
}) {
  const [low, setLow] = useState<StockRow[]>([]);
  const [imports, setImports] = useState<StockImportRow[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getStockList('', 'low'), getImports(), getAdjustments()])
      .then(([l, i, a]) => {
        setLow(l.products);
        setImports(i.imports);
        setAdjustments(a.adjustments);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const lastImport = summary?.lastImport ?? null;
  const stale = lastImport ? isStale(lastImport.importedAt) : true;

  return (
    <div className="space-y-5">
      {/* metric cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <MetricCard label="สินค้าทั้งหมด" value={summary?.total ?? '—'} tone="slate"
          icon={<Boxes size={20} />} onClick={() => onGoStock('all')} />
        <MetricCard label="มีสต็อก" value={summary?.withStock ?? '—'} tone="emerald"
          icon={<PackageCheck size={20} />} onClick={() => onGoStock('all')} />
        <MetricCard label="ใกล้หมด" value={summary?.low ?? '—'} tone="amber"
          icon={<AlertTriangle size={20} />} onClick={() => onGoStock('low')} />
        <MetricCard label="หมด" value={summary?.outOfStock ?? '—'} tone="rose"
          icon={<PackageX size={20} />} onClick={() => onGoStock('out')} />
        <MetricCard label="ไม่ทราบสต็อก" value={summary?.unknown ?? '—'} tone="slate"
          icon={<HelpCircle size={20} />} onClick={() => onGoStock('unknown')} />
      </div>

      {/* last import status */}
      <div className={`rounded-2xl border p-4 flex flex-wrap items-center gap-x-6 gap-y-2 ${
        stale ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'
      }`}>
        <div className="flex items-center gap-2 font-semibold text-slate-700">
          <Clock size={16} className={stale ? 'text-amber-600' : 'text-slate-400'} />
          สถานะข้อมูลสต็อก
        </div>
        {lastImport ? (
          <>
            <div className="text-sm">
              <span className="text-slate-500">นำเข้าล่าสุด: </span>
              <span className={`font-medium ${stale ? 'text-amber-700' : 'text-slate-700'}`}>
                {relTime(lastImport.importedAt)}
              </span>
              <span className="text-slate-400"> ({fmtDateTime(lastImport.importedAt)})</span>
            </div>
            <div className="text-sm text-slate-500">
              อัปเดต {lastImport.skusUpdated}
              {lastImport.skusUnmatched > 0 && ` · ไม่พบ ${lastImport.skusUnmatched}`}
              {lastImport.fileName && ` · ${lastImport.fileName}`}
            </div>
            {stale && <span className="text-xs text-amber-700 font-medium">⚠ ข้อมูลอาจไม่เป็นปัจจุบัน — นำเข้าไฟล์ล่าสุด</span>}
          </>
        ) : (
          <div className="text-sm text-slate-500">ยังไม่เคยนำเข้าไฟล์สต็อก</div>
        )}
        <button
          onClick={onGoImport}
          className="ml-auto px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium flex items-center gap-1"
        >
          <Upload size={14} /> นำเข้าสต็อก
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* low-stock action list */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-500" /> ต้องสั่งซื้อ (ใกล้หมด)
            </h2>
            {low.length > 0 && (
              <button onClick={() => onGoStock('low')} className="text-xs text-indigo-600 hover:underline flex items-center gap-0.5">
                ดูทั้งหมด <ArrowRight size={12} />
              </button>
            )}
          </div>
          {loading ? (
            <div className="text-slate-400 text-sm py-4 text-center"><Loader2 size={16} className="animate-spin inline" /></div>
          ) : low.length === 0 ? (
            <p className="text-sm text-slate-400 py-2">ไม่มีสินค้าใกล้หมด 👍</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {low.slice(0, 8).map((r) => (
                <li key={r.sku} className="flex items-center gap-2.5 py-1.5">
                  <Thumb photoSku={r.photoSku} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-700 truncate">{r.nameTh || r.nameEn || flatSku(r.sku)}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{flatSku(r.sku)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-bold text-rose-600">{r.stock}</span>
                    <span className="text-[10px] text-slate-400"> / {r.reorderPoint}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* recent activity */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
            <History size={16} className="text-indigo-600" /> ความเคลื่อนไหวล่าสุด
          </h2>
          {loading ? (
            <div className="text-slate-400 text-sm py-4 text-center"><Loader2 size={16} className="animate-spin inline" /></div>
          ) : imports.length === 0 && adjustments.length === 0 ? (
            <p className="text-sm text-slate-400 py-2">ยังไม่มีความเคลื่อนไหว</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {imports.slice(0, 3).map((im) => (
                <li key={im.id} className="flex items-center gap-2">
                  <Upload size={13} className="text-indigo-500 shrink-0" />
                  <span className="text-slate-600 flex-1 min-w-0 truncate">
                    นำเข้า · อัปเดต {im.skusUpdated} รายการ
                  </span>
                  <span className="text-[11px] text-slate-400 shrink-0">{relTime(im.importedAt)}</span>
                </li>
              ))}
              {adjustments.slice(0, 5).map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <Package size={13} className="text-slate-400 shrink-0" />
                  <span className="text-slate-600 flex-1 min-w-0 truncate">
                    <span className="font-mono text-xs">{flatSku(a.sku)}</span> {a.fromQty ?? '—'} → <b>{a.toQty ?? '—'}</b>
                    {a.reason ? ` · ${a.reason}` : ''}
                  </span>
                  <span className="text-[11px] text-slate-400 shrink-0">{relTime(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stock list + manual adjust + reorder point ──────────────────────────
function StockTab({
  filter, setFilter, onChanged,
}: { filter: StockFilter; setFilter: (f: StockFilter) => void; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { products } = await getStockList(q, filter);
      setRows(products);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [q, filter]);

  // Debounce the search; reload immediately on filter change.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  function patchRow(updated: StockRow) {
    setRows((rs) => rs.map((r) => (r.sku === updated.sku ? updated : r)));
    onChanged();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาด้วยชื่อ รหัสย่อ (TR34) หรือรหัสสินค้า (071009)…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'low', 'out', 'unknown'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-xl text-sm font-medium border ${
                filter === f
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {f === 'all' ? 'ทั้งหมด' : f === 'low' ? 'ใกล้หมด' : f === 'out' ? 'หมด' : 'ไม่ทราบสต็อก'}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          className="px-3 py-2 rounded-xl text-sm border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 flex items-center gap-1"
        >
          <RefreshCw size={15} /> รีเฟรช
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2 font-semibold">สินค้า</th>
              <th className="text-right px-3 py-2 font-semibold">สต็อก</th>
              <th className="text-right px-3 py-2 font-semibold">จุดสั่งซื้อ</th>
              <th className="text-left px-3 py-2 font-semibold">ณ วันที่</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                <Loader2 size={18} className="animate-spin inline" /> กำลังโหลด…
              </td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">ไม่พบสินค้า</td></tr>
            )}
            {!loading && rows.map((r) => (
              <RowItem
                key={r.sku}
                row={r}
                expanded={expanded === r.sku}
                onToggle={() => setExpanded(expanded === r.sku ? null : r.sku)}
                onPatch={patchRow}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowItem({
  row, expanded, onToggle, onPatch,
}: { row: StockRow; expanded: boolean; onToggle: () => void; onPatch: (r: StockRow) => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${row.low ? 'bg-rose-50/50' : ''}`}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <Thumb photoSku={row.photoSku} />
            <div className="min-w-0">
              <div className="font-medium text-slate-800 truncate">{row.nameTh || row.nameEn || flatSku(row.sku)}</div>
              <div className="text-xs text-slate-400 font-mono">
                {row.alias && <span className="text-indigo-600 font-semibold">{row.alias} · </span>}
                {flatSku(row.sku)}
                {row.nameEn && row.nameTh && <span className="text-slate-300"> · {row.nameEn}</span>}
              </div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          {row.stock == null ? (
            <span className="text-slate-400">—</span>
          ) : (
            <span className={`font-semibold ${row.low ? 'text-rose-600' : 'text-slate-800'}`}>
              {row.stock.toLocaleString('th-TH')}
            </span>
          )}
          {row.low && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-semibold align-middle">
              ใกล้หมด
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right text-slate-500">{row.reorderPoint ?? '—'}</td>
        <td className="px-3 py-2.5 text-slate-500">
          <span className={isStale(row.stockAt) ? 'text-amber-600' : ''}>{fmtDate(row.stockAt)}</span>
        </td>
        <td className="px-3 py-2.5 text-slate-300">
          <ChevronRight size={16} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={5} className="px-4 py-3">
            <EditPanel row={row} onPatch={onPatch} />
          </td>
        </tr>
      )}
    </>
  );
}

function EditPanel({ row, onPatch }: { row: StockRow; onPatch: (r: StockRow) => void }) {
  const [qty, setQty] = useState(row.stock == null ? '' : String(row.stock));
  const [reason, setReason] = useState('');
  const [rp, setRp] = useState(row.reorderPoint == null ? '' : String(row.reorderPoint));
  const [busy, setBusy] = useState<'qty' | 'rp' | null>(null);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState<StockAdjustmentRow[] | null>(null);

  useEffect(() => {
    getAdjustments(row.sku).then((d) => setHistory(d.adjustments)).catch(() => setHistory([]));
  }, [row.sku]);

  async function saveQty() {
    setErr('');
    const toQty = qty.trim() === '' ? null : Number(qty);
    if (toQty != null && (!Number.isInteger(toQty) || toQty < 0)) {
      setErr('จำนวนต้องเป็นเลขจำนวนเต็ม ≥ 0');
      return;
    }
    setBusy('qty');
    try {
      const { product } = await adjustStock(row.sku, toQty, reason.trim());
      onPatch(product);
      setReason('');
      getAdjustments(row.sku).then((d) => setHistory(d.adjustments)).catch(() => {});
    } catch {
      setErr('บันทึกไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  async function saveRp() {
    setErr('');
    const v = rp.trim() === '' ? null : Number(rp);
    if (v != null && (!Number.isInteger(v) || v < 0)) {
      setErr('จุดสั่งซื้อต้องเป็นเลขจำนวนเต็ม ≥ 0');
      return;
    }
    setBusy('rp');
    try {
      const { product } = await setReorderPoint(row.sku, v);
      onPatch(product);
    } catch {
      setErr('บันทึกไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {/* manual stock adjust */}
      <div className="md:col-span-2">
        <div className="text-xs font-semibold text-slate-500 mb-1">แก้ไขจำนวนสต็อก (ด้วยมือ)</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="numeric"
            placeholder="จำนวน"
            className="w-24 px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="เหตุผล (เช่น นับสต็อกใหม่, ของเสีย)…"
            className="flex-1 min-w-[160px] px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={saveQty}
            disabled={busy !== null}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium flex items-center gap-1 disabled:opacity-50"
          >
            {busy === 'qty' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} บันทึก
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">
          เว้นว่างไว้ = ตั้งค่าสต็อกเป็น “ไม่ทราบ” · การแก้ไขจะถูกบันทึกไว้ในประวัติ
        </p>

        {history && history.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-slate-400 mb-1">ประวัติการแก้ไข</div>
            <ul className="space-y-0.5 text-xs text-slate-500">
              {history.slice(0, 5).map((h) => (
                <li key={h.id}>
                  {fmtDateTime(h.at)} · {h.fromQty ?? '—'} → <b>{h.toQty ?? '—'}</b>
                  {h.reason ? ` · ${h.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* reorder point */}
      <div>
        <div className="text-xs font-semibold text-slate-500 mb-1">จุดสั่งซื้อ (แจ้งเตือนใกล้หมด)</div>
        <div className="flex items-center gap-2">
          <input
            value={rp}
            onChange={(e) => setRp(e.target.value)}
            inputMode="numeric"
            placeholder="เช่น 10"
            className="w-24 px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={saveRp}
            disabled={busy !== null}
            className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-medium flex items-center gap-1 disabled:opacity-50"
          >
            {busy === 'rp' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} ตั้งค่า
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">เว้นว่าง = ไม่มีการแจ้งเตือน</p>
      </div>

      {err && (
        <div className="md:col-span-3 flex items-center gap-1 text-rose-600 text-xs">
          <AlertTriangle size={13} /> {err}
        </div>
      )}
    </div>
  );
}

// ── CSV import: upload → preview → apply ────────────────────────────────
function ImportTab({ onApplied }: { onApplied: () => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ updated: number; unmatched: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setErr('');
    setDone(null);
    setPreview(null);
    setFileName(file.name);
    setBusy('preview');
    try {
      const buf = await file.arrayBuffer();
      // base64-encode the raw bytes (server detects/handles Thai encoding)
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const dataB64 = btoa(binary);
      const p = await previewImport(dataB64, file.name);
      setPreview(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setErr(
        msg === 'forbidden'
          ? 'ไม่มีสิทธิ์'
          : msg.includes('413')
          ? 'ไฟล์ใหญ่เกินไป — เกินขีดจำกัดของเซิร์ฟเวอร์'
          : 'อ่านไฟล์ไม่สำเร็จ — ตรวจสอบว่าเป็นไฟล์รายงานสต็อกจาก Express (.txt)',
      );
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy('apply');
    setErr('');
    try {
      const res = await applyImport(preview.token);
      setDone({ updated: res.skusUpdated, unmatched: res.skusUnmatched });
      setPreview(null);
      onApplied();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setErr(msg.includes('410') ? 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' : 'นำเข้าไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  const unmatchedRows = useMemo(
    () => (preview ? preview.rows.filter((r) => !r.matched) : []),
    [preview],
  );

  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <Upload size={18} className="text-indigo-600" /> นำเข้าไฟล์สต็อกประจำวัน (รายงานจาก Express)
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          อัปโหลดไฟล์ → ดูตัวอย่างการเปลี่ยนแปลง → ยืนยันเพื่อบันทึก จำนวนสต็อกจะอัปเดตให้ Minerva ทันที
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
        >
          {busy === 'preview' ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          เลือกไฟล์รายงานสต็อก
        </button>
        {fileName && <span className="ml-3 text-sm text-slate-500">{fileName}</span>}

        {err && (
          <div className="mt-3 flex items-center gap-1 text-rose-600 text-sm">
            <AlertTriangle size={14} /> {err}
          </div>
        )}

        {done && (
          <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm flex items-center gap-2">
            <Check size={16} /> นำเข้าสำเร็จ — อัปเดต {done.updated} รายการ
            {done.unmatched > 0 && ` · ไม่พบในแคตตาล็อก ${done.unmatched} รายการ`}
          </div>
        )}
      </div>

      {preview && (
        <div className="mt-4 bg-white rounded-2xl border border-slate-200 p-5">
          <div className="flex flex-wrap gap-3 mb-3 text-sm">
            <Stat label="อ่านได้" value={preview.rowsParsed} />
            <Stat label="ตรงกับแคตตาล็อก" value={preview.matched} tone="ok" />
            <Stat label="จะเปลี่ยนแปลง" value={preview.willChange} tone="change" />
            <Stat label="ไม่พบในแคตตาล็อก" value={preview.unmatched} tone={preview.unmatched ? 'warn' : undefined} />
            <span className="ml-auto text-xs text-slate-400 self-center">
              encoding: {preview.encoding}
            </span>
          </div>

          {preview.unresolved > 0 && (
            <div className="mb-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              <div className="font-semibold mb-1 flex items-center gap-1">
                <AlertTriangle size={13} />
                อ่านไม่ได้ {preview.unresolved} บรรทัด — แถวเหล่านี้จะไม่ถูกอัปเดต (รูปแบบไฟล์อาจเปลี่ยน แจ้งผู้ดูแลระบบ)
              </div>
              <div className="font-mono">
                {preview.unresolvedSamples.map((s, i) => (
                  <div key={i}>{s}</div>
                ))}
              </div>
            </div>
          )}

          {unmatchedRows.length > 0 && (
            <div className="mb-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              <div className="font-semibold mb-1 flex items-center gap-1">
                <AlertTriangle size={13} /> SKU ที่ไม่พบในแคตตาล็อก (จะถูกข้าม ไม่สร้างใหม่):
              </div>
              <div className="font-mono">
                {unmatchedRows.slice(0, 30).map((r) => flatSku(r.sku)).join(', ')}
                {unmatchedRows.length > 30 && ` … (+${unmatchedRows.length - 30})`}
              </div>
            </div>
          )}

          <div className="max-h-80 overflow-auto border border-slate-100 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">สินค้า</th>
                  <th className="text-right px-3 py-2 font-semibold">ปัจจุบัน</th>
                  <th className="text-right px-3 py-2 font-semibold">ใหม่</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={`${r.sku}-${i}`} className={`border-t border-slate-100 ${!r.matched ? 'bg-amber-50/40' : ''}`}>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <Thumb photoSku={r.photoSku} size={30} />
                        <div className="min-w-0">
                          <div className="text-slate-700 truncate">{r.name || r.csvName || '—'}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{flatSku(r.sku)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-400">{r.matched ? (r.currentStock ?? '—') : '—'}</td>
                    <td className="px-3 py-1.5 text-right font-semibold">{r.qty}</td>
                    <td className="px-3 py-1.5 text-center">
                      {!r.matched ? (
                        <X size={14} className="text-amber-500 inline" />
                      ) : r.willChange ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-semibold">เปลี่ยน</span>
                      ) : (
                        <span className="text-slate-300 text-xs">เท่าเดิม</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={apply}
              disabled={busy !== null || preview.matched === 0}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
            >
              {busy === 'apply' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              ยืนยันนำเข้า ({preview.willChange} รายการจะเปลี่ยน)
            </button>
            <button
              onClick={() => setPreview(null)}
              disabled={busy !== null}
              className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm disabled:opacity-50"
            >
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'change' | 'warn' }) {
  const color =
    tone === 'ok' ? 'text-emerald-700' :
    tone === 'change' ? 'text-indigo-700' :
    tone === 'warn' ? 'text-amber-700' : 'text-slate-700';
  return (
    <div className="px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
      <span className="text-xs text-slate-400">{label} </span>
      <span className={`font-bold ${color}`}>{value}</span>
    </div>
  );
}

// ── History: imports + recent manual adjustments ────────────────────────
function HistoryTab() {
  const [imports, setImports] = useState<StockImportRow[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getImports(), getAdjustments()])
      .then(([i, a]) => {
        setImports(i.imports);
        setAdjustments(a.adjustments);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-slate-400 py-8 text-center"><Loader2 size={18} className="animate-spin inline" /> กำลังโหลด…</div>;
  }

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
          <Upload size={16} className="text-indigo-600" /> การนำเข้าล่าสุด
        </h2>
        {imports.length === 0 ? (
          <p className="text-sm text-slate-400">ยังไม่มีการนำเข้า</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {imports.map((im) => (
              <li key={im.id} className="border-b border-slate-100 pb-2 last:border-0">
                <div className="text-slate-700">{fmtDateTime(im.importedAt)}</div>
                <div className="text-xs text-slate-500">
                  {im.fileName || '—'} · อัปเดต {im.skusUpdated}
                  {im.skusUnmatched > 0 && ` · ไม่พบ ${im.skusUnmatched}`} · อ่าน {im.rowsParsed} แถว
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
          <History size={16} className="text-indigo-600" /> การแก้ไขด้วยมือล่าสุด
        </h2>
        {adjustments.length === 0 ? (
          <p className="text-sm text-slate-400">ยังไม่มีการแก้ไข</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {adjustments.map((a) => (
              <li key={a.id} className="border-b border-slate-100 pb-2 last:border-0">
                <div className="text-slate-700 font-mono text-xs">{flatSku(a.sku)}</div>
                <div className="text-xs text-slate-500">
                  {fmtDateTime(a.at)} · {a.fromQty ?? '—'} → <b>{a.toQty ?? '—'}</b>
                  {a.reason ? ` · ${a.reason}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Product aliases (short human codes, e.g. "TR34") ────────────────────
function AliasTab() {
  const [groups, setGroups] = useState<AliasGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'fill' | 'regen' | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAliases();
      setGroups(res.groups);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function gen(regenerate: boolean) {
    if (regenerate && !window.confirm('สร้างรหัสย่อใหม่ทั้งหมด? รหัสที่แก้ด้วยมือจะถูกเขียนทับ')) return;
    setBusy(regenerate ? 'regen' : 'fill');
    try {
      await generateAliases(regenerate);
      await load();
    } catch {
      /* ignore — the list just won't change */
    } finally {
      setBusy(null);
    }
  }

  const term = q.trim().toLowerCase();
  const flatTerm = term.replace(/-/g, '');
  const shown = term
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (it) =>
              g.group.includes(term) ||
              (g.prefix && g.prefix.toLowerCase().includes(term)) ||
              (it.alias && it.alias.toLowerCase().includes(term)) ||
              it.sku.replace(/-/g, '').includes(flatTerm) ||
              `${it.nameEn} ${it.nameTh}`.toLowerCase().includes(term),
          ),
        }))
        .filter((g) => g.items.length)
    : groups;

  return (
    <div className="max-w-4xl">
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
        <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <Tag size={18} className="text-indigo-600" /> รหัสย่อสินค้า
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          รหัสสั้นที่พิมพ์ง่าย เช่น <b>TR34</b> — สินค้ากลุ่มเดียวกันใช้ตัวอักษรนำหน้าเดียวกัน (รหัสย่อ = ตัวอักษรกลุ่ม + เลขสินค้า) พิมพ์รหัสย่อในช่องค้นหาหน้า “สต็อก” ได้เลย
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => gen(false)}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'fill' ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} สร้างรหัสย่ออัตโนมัติ
          </button>
          <button
            onClick={() => gen(true)}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm disabled:opacity-50"
          >
            {busy === 'regen' ? <Loader2 size={15} className="animate-spin inline" /> : 'สร้างใหม่ทั้งหมด'}
          </button>
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหากลุ่ม / รหัสย่อ / ชื่อ…"
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-slate-400 py-8 text-center">
          <Loader2 size={18} className="animate-spin inline" /> กำลังโหลด…
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">ยังไม่มีรหัสย่อ — กด “สร้างรหัสย่ออัตโนมัติ”</p>
      ) : (
        <div className="space-y-3">
          {shown.map((g) => (
            <AliasGroupCard key={g.group} group={g} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function AliasGroupCard({ group, onChanged }: { group: AliasGroup; onChanged: () => void }) {
  const [prefix, setPrefix] = useState(group.prefix);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function savePrefix() {
    const pfx = prefix.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(pfx)) {
      setErr('ตัวนำหน้า 1–4 ตัว (A–Z, 0–9)');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await setGroupPrefix(group.group, pfx);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('409') ? 'ตัวนำหน้าซ้ำกับกลุ่มอื่น' : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-slate-400 font-mono">กลุ่ม {group.group}</span>
        <span className="text-[11px] text-slate-400">· {group.count} รายการ</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-slate-500">ตัวนำหน้า</span>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
            maxLength={4}
            className="w-16 px-2 py-1 rounded-lg border border-slate-300 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={savePrefix}
            disabled={saving || prefix.trim().toUpperCase() === group.prefix}
            className="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs disabled:opacity-40 flex items-center gap-1"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} ตั้ง
          </button>
        </div>
      </div>
      {err && (
        <div className="text-rose-600 text-[11px] mb-2 flex items-center gap-1">
          <AlertTriangle size={11} /> {err}
        </div>
      )}
      <div className="divide-y divide-slate-100">
        {group.items.map((it) => (
          <AliasRow key={it.sku} item={it} onChanged={onChanged} />
        ))}
      </div>
    </div>
  );
}

function AliasRow({ item, onChanged }: { item: AliasItem; onChanged: () => void }) {
  const [alias, setAliasVal] = useState(item.alias ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const dirty = alias.trim().toUpperCase() !== (item.alias ?? '');

  async function save() {
    const a = alias.trim().toUpperCase();
    if (a && !/^[A-Z0-9]{2,12}$/.test(a)) {
      setErr('2–12 ตัว (A–Z, 0–9)');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await setAlias(item.sku, a);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('409') ? 'รหัสย่อซ้ำ' : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 py-1.5">
      <input
        value={alias}
        onChange={(e) => setAliasVal(e.target.value.toUpperCase())}
        onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
        placeholder="—"
        maxLength={12}
        className="w-24 shrink-0 px-2 py-1 rounded-lg border border-slate-300 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
      {dirty && (
        <button
          onClick={save}
          disabled={saving}
          className="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs disabled:opacity-40 flex items-center gap-1 shrink-0"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-700 truncate">{item.nameTh || item.nameEn || flatSku(item.sku)}</div>
        <div className="text-[10px] text-slate-400 font-mono">{flatSku(item.sku)}</div>
      </div>
      {err && (
        <span className="text-rose-600 text-[10px] flex items-center gap-0.5 shrink-0">
          <AlertTriangle size={10} /> {err}
        </span>
      )}
    </div>
  );
}
