import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Boxes, Search, Upload, History, LogOut, AlertTriangle, Check, Loader2,
  Package, RefreshCw, ChevronRight, X, LayoutDashboard, PackageX, PackageCheck,
  HelpCircle, Clock, ArrowRight, Crown, Tag, Wand2, Layers, Pencil,
  ClipboardCheck, Sparkles, Plus, Trash2,
} from 'lucide-react';

// Portal-back link (Jupiter). URL from build-time env; hidden when unset, so it is completely
// inert until VITE_PORTAL_URL is configured (Phase 1 go-live / Phase 2 domains).
const PORTAL_URL: string | undefined = import.meta.env.VITE_PORTAL_URL;
import {
  type Agent, type StockRow, type StockSummary, type StockImportRow,
  type StockAdjustmentRow, type ImportPreview, type ImportPreviewRow,
  type CatalogGroupInfo, type GroupProduct, type Pillar,
  getSummary, getStockList, adjustStock, setReorderPoint, renameProduct, getImports, getAdjustments,
  previewImport, applyImport, logout as logoutSuite, API_URL, flatSku,
  generateAliases, setAlias,
  getGroups, getGroupProducts, autoAssignGroups, setProductGroup, setSubgroup,
  setProductsGroup, setSubgroups,
  createGroup, createSubgroup, deleteGroup, deleteSubgroup,
  type NameProposalRow, type ProposalSummary, type ProposalFilter,
  getProposalSummary, getProposals, loadProposals, decideProposal, bulkApproveSafe,
} from './lib/api';
import AppSwitcher from './AppSwitcher';

type Tab = 'dashboard' | 'stock' | 'import' | 'history' | 'alias' | 'group' | 'review';
type StockFilter = 'all' | 'low' | 'out' | 'unknown' | 'noname';

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
      loading="lazy"
      style={{ width: size, height: size }}
      className="shrink-0 rounded object-contain bg-white border border-slate-100"
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

// Remaining-stock pill: "—" unknown, "หมด" out (rose), amber when at/below reorder point.
function StockPill({ stock, reorderPoint }: { stock: number | null; reorderPoint: number | null }) {
  if (stock == null) return <span className="text-[11px] text-slate-300 shrink-0">—</span>;
  const out = stock <= 0;
  const low = !out && reorderPoint != null && stock <= reorderPoint;
  return (
    <span
      className={`text-[11px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded ${
        out ? 'bg-rose-100 text-rose-700' : low ? 'bg-amber-100 text-amber-700' : 'text-slate-500'
      }`}
    >
      {out ? 'หมด' : `เหลือ ${stock.toLocaleString('th-TH')}`}
    </span>
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
    void logoutSuite(); // clears the shared SSO cookie + local session (fire-and-forget)
    onLogout();
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2 text-indigo-700 font-bold">
            <AppSwitcher agent={agent} />
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
            <TabBtn active={tab === 'group'} onClick={() => setTab('group')} icon={<Layers size={15} />}>
              จัดกลุ่ม
            </TabBtn>
            <TabBtn active={tab === 'review'} onClick={() => setTab('review')} icon={<ClipboardCheck size={15} />}>
              ตรวจทานชื่อ
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
        {tab === 'group' && <GroupTab />}
        {tab === 'review' && <ReviewTab />}
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
          {(['all', 'low', 'out', 'unknown', 'noname'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-xl text-sm font-medium border ${
                filter === f
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {f === 'all' ? 'ทั้งหมด' : f === 'low' ? 'ใกล้หมด' : f === 'out' ? 'หมด' : f === 'unknown' ? 'ไม่ทราบสต็อก' : 'ไม่มีชื่อไทย'}
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
              <div className="font-medium text-slate-800 truncate">
                {row.nameTh || row.nameEn || flatSku(row.sku)}
                {row.stockOnly && <span className="ml-1.5 align-middle text-[9px] font-bold uppercase tracking-wide bg-sky-100 text-sky-700 rounded px-1 py-px" title="เพิ่มจาก Express — ยังไม่ลงแคตตาล็อก (ไม่ขึ้นเว็บ/AI)">Express</span>}
              </div>
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
  const [nameTh, setNameTh] = useState(row.nameTh);
  const [nameEn, setNameEn] = useState(row.nameEn);
  const [busy, setBusy] = useState<'qty' | 'rp' | 'name' | null>(null);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState<StockAdjustmentRow[] | null>(null);
  const nameDirty = nameTh.trim() !== row.nameTh.trim() || nameEn.trim() !== row.nameEn.trim();

  async function saveName() {
    setErr('');
    setBusy('name');
    try {
      // Keep the alias the row already carries — the rename response doesn't include it.
      const { product } = await renameProduct(row.sku, nameEn.trim(), nameTh.trim());
      onPatch({ ...product, alias: row.alias });
    } catch {
      setErr('บันทึกชื่อไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

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
      {/* rename product (Thai + English) */}
      <div className="md:col-span-3">
        <div className="text-xs font-semibold text-slate-500 mb-1">ชื่อสินค้า</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={nameTh}
            onChange={(e) => setNameTh(e.target.value)}
            placeholder="ชื่อไทย"
            className="flex-1 min-w-[160px] px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            placeholder="ชื่ออังกฤษ (English)"
            className="flex-1 min-w-[160px] px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={saveName}
            disabled={busy !== null || !nameDirty}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium flex items-center gap-1 disabled:opacity-40"
          >
            {busy === 'name' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} บันทึกชื่อ
          </button>
        </div>
      </div>

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
  const [done, setDone] = useState<{ updated: number; unmatched: number; created: number } | null>(null);
  // opt-in: also create the not-in-catalog SKUs as hidden 'stock_only' products
  const [createNew, setCreateNew] = useState(false);
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
        msg === 'unauthorized'
          ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่'
          : msg === 'forbidden'
          ? 'ไม่มีสิทธิ์'
          : msg.includes('413')
          ? 'ไฟล์ใหญ่เกินไป — เกินขีดจำกัดของเซิร์ฟเวอร์'
          : msg.includes('422')
          ? 'ไม่พบรายการสินค้าในไฟล์ — ตรวจสอบว่าเป็นรายงานสินค้าคงเหลือจาก Express'
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
      const res = await applyImport(preview.token, undefined, createNew);
      setDone({ updated: res.skusUpdated, unmatched: res.skusUnmatched, created: res.created ?? 0 });
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

  // The full Express report spans ~5k SKUs while the catalog is ~1.2k — rendering every row
  // (each with an <img>) freezes the tab. Show what needs eyes first (changes, then unmatched,
  // then unchanged) and cap the DOM; the apply itself always uses the full parsed set server-side.
  const PREVIEW_CAP = 800;
  const sortedRows = useMemo(() => {
    if (!preview) return [];
    const weight = (r: ImportPreviewRow) => (r.willChange ? 0 : !r.matched ? 1 : 2);
    return [...preview.rows].sort((a, b) => weight(a) - weight(b));
  }, [preview]);

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
            <Check size={16} /> นำเข้าสำเร็จ — อัปเดต {done.updated.toLocaleString('th-TH')} รายการ
            {done.created > 0 && ` · เพิ่มสินค้าใหม่ ${done.created.toLocaleString('th-TH')} รายการ`}
            {done.unmatched > 0 && ` · ไม่พบในแคตตาล็อก ${done.unmatched.toLocaleString('th-TH')} รายการ`}
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
              {preview.asOfText && (
                <span className="mr-3 text-slate-600 font-medium">ข้อมูล ณ วันที่ {preview.asOfText}</span>
              )}
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
                <AlertTriangle size={13} /> SKU ที่ไม่พบในแคตตาล็อก ({unmatchedRows.length.toLocaleString('th-TH')} รายการ):
              </div>
              <div className="font-mono mb-2">
                {unmatchedRows.slice(0, 30).map((r) => flatSku(r.sku)).join(', ')}
                {unmatchedRows.length > 30 && ` … (+${unmatchedRows.length - 30})`}
              </div>
              <label className="flex items-start gap-2 cursor-pointer bg-white/60 rounded-lg p-2 border border-amber-200">
                <input type="checkbox" checked={createNew} onChange={(e) => setCreateNew(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-amber-300 text-indigo-600 focus:ring-indigo-400" />
                <span>
                  <b>เพิ่มสินค้าใหม่เหล่านี้เข้าระบบ (นับสต็อกในVulcan)</b> — ใช้ชื่อจาก Express, ยังไม่มีราคา/รูป/หมวด
                  <br /><span className="text-amber-600">จะแสดงเฉพาะใน Vulcan เท่านั้น · ไม่ขึ้นเว็บไซต์และ AI ไม่นำไปตอบลูกค้า จนกว่าจะจัดข้อมูลให้ครบ</span>
                </span>
              </label>
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
                {sortedRows.slice(0, PREVIEW_CAP).map((r, i) => (
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
            {sortedRows.length > PREVIEW_CAP && (
              <div className="px-3 py-2 text-center text-xs text-slate-400 border-t border-slate-100">
                แสดง {PREVIEW_CAP.toLocaleString('th-TH')} จาก {sortedRows.length.toLocaleString('th-TH')} แถว
                (เรียงรายการที่เปลี่ยน/ไม่พบขึ้นก่อน) — การนำเข้าใช้ข้อมูลครบทุกแถว
              </div>
            )}
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

// ── Product codes (group-based, e.g. "IM01" impression, "EN12" endo) ────
function AliasTab() {
  const [groups, setGroups] = useState<CatalogGroupInfo[]>([]);
  const [ungrouped, setUngrouped] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'fill' | 'redo' | null>(null);
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<GroupProduct[]>([]);
  const [prodLoading, setProdLoading] = useState(false);

  const loadGroups = useCallback(async () => {
    try {
      const g = await getGroups();
      setGroups(g.groups);
      setUngrouped(g.unassigned);
    } catch { /* leave as-is */ }
  }, []);
  useEffect(() => { loadGroups().finally(() => setLoading(false)); }, [loadGroups]);

  const loadProducts = useCallback(async (query: string) => {
    setProdLoading(true);
    try {
      const r = await getGroupProducts({ q: query });
      setProducts(r.products);
    } catch { setProducts([]); } finally { setProdLoading(false); }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => loadProducts(q), 250);
    return () => clearTimeout(t);
  }, [q, loadProducts]);

  async function gen(regenerate: boolean) {
    if (regenerate && !window.confirm('สร้างรหัสใหม่ทั้งหมด? รหัสที่แก้ด้วยมือจะถูกเขียนทับ')) return;
    setBusy(regenerate ? 'redo' : 'fill');
    try {
      await generateAliases(regenerate);
      await loadGroups();
      await loadProducts(q);
    } catch { /* ignore */ } finally { setBusy(null); }
  }

  const codeOf = (key: string | null) => groups.find((g) => g.key === key)?.code ?? null;

  if (loading) {
    return <div className="text-slate-400 py-8 text-center"><Loader2 size={18} className="animate-spin inline" /> กำลังโหลด…</div>;
  }

  return (
    <div className="max-w-4xl">
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
        <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <Tag size={18} className="text-indigo-600" /> รหัสสินค้า (ตามกลุ่ม)
        </h2>
        <p className="text-sm text-slate-500 mb-3">
          รหัสสั้นที่บอกหมวดในตัว เช่น <b>IM01</b> = พิมพ์ปาก, <b>EN12</b> = รักษาราก, <b>TC03</b> = ครอบชั่วคราว
          (รหัส = ตัวอักษรกลุ่ม + เลขลำดับ) พิมพ์รหัสในช่องค้นหาหน้า “สต็อก” ได้เลย · รหัส Express (07-10-09) ไม่เปลี่ยน
        </p>
        {ungrouped > 0 && (
          <div className="mb-3 flex items-center gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs">
            <AlertTriangle size={14} /> มี {ungrouped.toLocaleString('th-TH')} รายการยังไม่จัดกลุ่ม จึงยังไม่มีรหัส — ไปที่แท็บ “จัดกลุ่ม” ก่อน
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => gen(false)}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'fill' ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} สร้างรหัสอัตโนมัติ
          </button>
          <button
            onClick={() => gen(true)}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm disabled:opacity-50"
          >
            {busy === 'redo' ? <Loader2 size={15} className="animate-spin inline" /> : 'สร้างใหม่ทั้งหมด'}
          </button>
        </div>
      </div>

      {/* code legend by pillar */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">รหัสของแต่ละกลุ่ม</div>
        <div className="space-y-3">
          {PILLAR_ORDER.map((pl) => (
            <div key={pl}>
              <div className="text-[11px] text-slate-400 mb-1.5">{PILLAR_LABEL[pl]}</div>
              <div className="flex flex-wrap gap-1.5">
                {groups.filter((g) => g.pillar === pl).map((g) => (
                  <span
                    key={g.key}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs ${
                      g.count > 0 ? 'border-slate-200 bg-white' : 'border-dashed border-slate-200 bg-slate-50 text-slate-400'
                    }`}
                  >
                    <b className={`font-mono ${g.count > 0 ? 'text-indigo-600' : 'text-slate-400'}`}>{g.code}</b> {g.nameTh}
                    {g.count > 0 && <span className="text-slate-400 tabular-nums">· {g.count}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* product list — code + manual override */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4">
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาสินค้าเพื่อดู/แก้รหัส…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        {prodLoading ? (
          <div className="text-slate-400 py-6 text-center"><Loader2 size={16} className="animate-spin inline" /></div>
        ) : products.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">ไม่พบสินค้า</p>
        ) : (
          <div className="divide-y divide-slate-100 max-h-[60vh] overflow-auto">
            {products.map((p) => (
              <CodeRow key={p.sku} product={p} groupCode={codeOf(p.catalogGroup)} onChanged={() => { loadProducts(q); loadGroups(); }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CodeRow({ product, groupCode, onChanged }: { product: GroupProduct; groupCode: string | null; onChanged: () => void }) {
  const [alias, setAliasVal] = useState(product.alias ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const dirty = alias.trim().toUpperCase() !== (product.alias ?? '');

  async function save() {
    const a = alias.trim().toUpperCase();
    if (a && !/^[A-Z0-9]{2,12}$/.test(a)) { setErr('2–12 ตัว (A–Z, 0–9)'); return; }
    setSaving(true);
    setErr('');
    try {
      await setAlias(product.sku, a);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('409') ? 'รหัสซ้ำ' : 'บันทึกไม่สำเร็จ');
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
        placeholder={groupCode ? `${groupCode}–` : '—'}
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
        <div className="text-sm text-slate-700 truncate">{product.nameTh || product.nameEn || flatSku(product.sku)}</div>
        <div className="text-[10px] text-slate-400 font-mono">
          {flatSku(product.sku)}
          {!product.catalogGroup && <span className="text-amber-600"> · ยังไม่จัดกลุ่ม</span>}
        </div>
      </div>
      <StockPill stock={product.stock} reorderPoint={product.reorderPoint} />
      {err && (
        <span className="text-rose-600 text-[10px] flex items-center gap-0.5 shrink-0">
          <AlertTriangle size={10} /> {err}
        </span>
      )}
    </div>
  );
}

// ── Catalog grouping (merchandising taxonomy) ───────────────────────────
const PILLAR_LABEL: Record<Pillar, string> = {
  lab: 'แล็บ / ทันตกรรมประดิษฐ์',
  digital: 'ดิจิทัล',
  clinical: 'คลินิก',
  equipment: 'อุปกรณ์และของใช้',
  review: 'รอตัดสินใจ / ตรวจสอบภายหลัง',
};
const PILLAR_ORDER: Pillar[] = ['lab', 'digital', 'clinical', 'equipment', 'review'];

// A <select> of every group (optgroup'd by pillar) + a blank "unassigned" option.
function GroupSelect({
  groups, value, onChange, disabled,
}: { groups: CatalogGroupInfo[]; value: string | null; onChange: (g: string | null) => void; disabled?: boolean }) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className="shrink-0 w-40 px-2 py-1 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
    >
      <option value="">— ยังไม่จัด —</option>
      {PILLAR_ORDER.map((pl) => (
        <optgroup key={pl} label={PILLAR_LABEL[pl]}>
          {groups.filter((g) => g.pillar === pl).map((g) => (
            <option key={g.key} value={g.key}>{g.nameTh}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// One reviewable product row: group + sub-group pickers, remaining stock, and inline name edit.
function GroupProductRow({
  product, groups, index, checked, onToggleSelect, onChangeGroup, onChangeSubgroup, onRenamed,
}: {
  product: GroupProduct;
  groups: CatalogGroupInfo[];
  index: number;
  checked: boolean;
  onToggleSelect: (sku: string, index: number, shiftKey: boolean) => void;
  onChangeGroup: (sku: string, group: string | null) => void;
  onChangeSubgroup: (sku: string, sub: string | null) => void;
  onRenamed: (sku: string, nameTh: string, nameEn: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameTh, setNameTh] = useState(product.nameTh);
  const [nameEn, setNameEn] = useState(product.nameEn);
  const [saving, setSaving] = useState(false);
  const subs = groups.find((g) => g.key === product.catalogGroup)?.subgroups ?? [];

  async function saveName() {
    setSaving(true);
    try {
      await renameProduct(product.sku, nameEn.trim(), nameTh.trim());
      onRenamed(product.sku, nameTh.trim(), nameEn.trim());
      setEditing(false);
    } catch { /* keep editor open on failure */ } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`py-2 ${checked ? 'bg-indigo-50/60 -mx-4 px-4' : ''}`}>
      <div className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => {}}
          onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
          onClick={(e) => onToggleSelect(product.sku, index, e.shiftKey)}
          className="shrink-0 w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-400 cursor-pointer"
        />
        <Thumb photoSku={product.photoSku} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-slate-700 truncate">
            {product.nameTh || product.nameEn || flatSku(product.sku)}
            {product.stockOnly && <span className="ml-1.5 align-middle text-[9px] font-bold uppercase tracking-wide bg-sky-100 text-sky-700 rounded px-1 py-px" title="เพิ่มจาก Express — ยังไม่ลงแคตตาล็อก">Express</span>}
          </div>
          <div className="text-[10px] text-slate-400 font-mono">
            {product.alias && <span className="text-indigo-600 font-semibold">{product.alias} · </span>}
            {flatSku(product.sku)}
            {product.nameEn && product.nameTh && <span className="text-slate-300"> · {product.nameEn}</span>}
          </div>
        </div>
        <button
          onClick={() => { setEditing((v) => !v); setNameTh(product.nameTh); setNameEn(product.nameEn); }}
          title="แก้ชื่อ"
          className={`shrink-0 p-1.5 rounded-lg border ${editing ? 'bg-indigo-50 border-indigo-300 text-indigo-600' : 'border-slate-200 text-slate-400 hover:text-slate-600'}`}
        >
          <Pencil size={13} />
        </button>
        <StockPill stock={product.stock} reorderPoint={product.reorderPoint} />
        {subs.length > 0 && (
          <select
            value={product.catalogSubgroup ?? ''}
            onChange={(e) => onChangeSubgroup(product.sku, e.target.value || null)}
            className="shrink-0 w-28 px-2 py-1 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="">— ชนิด —</option>
            {subs.map((s) => (
              <option key={s.code} value={s.code}>{s.nameTh}</option>
            ))}
          </select>
        )}
        <GroupSelect groups={groups} value={product.catalogGroup} onChange={(g) => onChangeGroup(product.sku, g)} />
      </div>
      {editing && (
        <div className="flex flex-wrap items-center gap-2 mt-2 pl-11">
          <input
            value={nameTh}
            onChange={(e) => setNameTh(e.target.value)}
            placeholder="ชื่อไทย"
            className="flex-1 min-w-[140px] px-2 py-1 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            placeholder="ชื่ออังกฤษ"
            className="flex-1 min-w-[140px] px-2 py-1 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={saveName}
            disabled={saving}
            className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} บันทึกชื่อ
          </button>
        </div>
      )}
    </div>
  );
}

// Inline form to create a new staff-defined group (name Th/En + 2-letter code + pillar).
function CreateGroupForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [nameTh, setNameTh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [code, setCode] = useState('');
  const [pillar, setPillar] = useState<Pillar>('lab');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (!nameTh.trim() && !nameEn.trim()) { setErr('กรอกชื่อกลุ่ม'); return; }
    if (!/^[A-Za-z]{2}$/.test(code.trim())) { setErr('รหัสต้องเป็นตัวอักษร 2 ตัว'); return; }
    setBusy(true);
    try {
      await createGroup(nameTh.trim(), nameEn.trim(), code.trim().toUpperCase(), pillar);
      setNameTh(''); setNameEn(''); setCode(''); setPillar('lab'); setOpen(false);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('409') ? 'รหัสนี้ถูกใช้แล้ว' : 'สร้างไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="px-3 py-2 rounded-xl border border-dashed border-indigo-300 text-indigo-600 hover:bg-indigo-50 text-sm font-medium flex items-center gap-1.5">
        <Plus size={15} /> สร้างกลุ่มใหม่
      </button>
    );
  }
  return (
    <div className="w-full mt-2 p-3 rounded-xl border border-indigo-200 bg-indigo-50/50 flex flex-wrap items-end gap-2">
      <label className="text-xs text-slate-500">ชื่อไทย
        <input value={nameTh} onChange={(e) => setNameTh(e.target.value)} placeholder="เช่น วัสดุพิเศษ"
          className="block mt-0.5 w-40 px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      </label>
      <label className="text-xs text-slate-500">ชื่ออังกฤษ
        <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Special"
          className="block mt-0.5 w-40 px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      </label>
      <label className="text-xs text-slate-500">รหัส (2 ตัว)
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))} placeholder="ZX"
          className="block mt-0.5 w-16 px-2 py-1.5 rounded-lg border border-slate-300 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      </label>
      <label className="text-xs text-slate-500">หมวด
        <select value={pillar} onChange={(e) => setPillar(e.target.value as Pillar)}
          className="block mt-0.5 w-44 px-2 py-1.5 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
          {PILLAR_ORDER.map((pl) => (<option key={pl} value={pl}>{PILLAR_LABEL[pl]}</option>))}
        </select>
      </label>
      <button onClick={submit} disabled={busy}
        className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium flex items-center gap-1 disabled:opacity-50">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} สร้าง
      </button>
      <button onClick={() => { setOpen(false); setErr(''); }} className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700">ยกเลิก</button>
      {err && <span className="w-full text-rose-600 text-xs flex items-center gap-1"><AlertTriangle size={12} /> {err}</span>}
    </div>
  );
}

// Sub-group manager for the open group: lists sub-groups (custom ones deletable) + a create form.
function SubgroupManager({ group, onChanged }: { group: CatalogGroupInfo; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [nameTh, setNameTh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (!nameTh.trim() && !nameEn.trim()) { setErr('กรอกชื่อชนิด'); return; }
    if (!/^[A-Za-z]{2}$/.test(code.trim())) { setErr('รหัส 2 ตัวอักษร'); return; }
    setBusy(true);
    try {
      await createSubgroup(group.key, nameTh.trim(), nameEn.trim(), code.trim().toUpperCase());
      setNameTh(''); setNameEn(''); setCode(''); setOpen(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('409') ? 'รหัสซ้ำ' : 'ไม่สำเร็จ');
    } finally { setBusy(false); }
  }
  async function removeSub(c: string) {
    const s = group.subgroups.find((x) => x.code === c);
    if (!window.confirm(`ลบชนิด “${s?.nameTh || s?.nameEn || c}”? สินค้าจะไม่ถูกลบ แต่จะไม่มีชนิดนี้กำกับ`)) return;
    setErr('');
    try { await deleteSubgroup(group.key, c); onChanged(); } catch { setErr('ลบชนิดไม่สำเร็จ'); }
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-slate-400">ชนิด:</span>
      {group.subgroups.length === 0 && <span className="text-[11px] text-slate-300">— ยังไม่มี —</span>}
      {group.subgroups.map((s) => (
        <span key={s.code} className="inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px]">
          <b className="font-mono text-indigo-600">{s.code}</b> {s.nameTh || s.nameEn}
          {s.custom && <button onClick={() => removeSub(s.code)} className="text-slate-400 hover:text-rose-600" title="ลบชนิด"><X size={11} /></button>}
        </span>
      ))}
      {open ? (
        <span className="inline-flex items-center gap-1">
          <input value={nameTh} onChange={(e) => setNameTh(e.target.value)} placeholder="ชื่อไทย" className="w-24 px-2 py-1 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="อังกฤษ" className="w-20 px-2 py-1 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))} placeholder="รหัส" className="w-14 px-2 py-1 rounded-lg border border-slate-300 text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <button onClick={submit} disabled={busy} className="px-2 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs disabled:opacity-50">{busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}</button>
          <button onClick={() => { setOpen(false); setErr(''); }} className="text-xs text-slate-400 hover:text-slate-600 px-1">✕</button>
        </span>
      ) : (
        <button onClick={() => setOpen(true)} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full border border-dashed border-indigo-300 text-indigo-600 text-[11px] hover:bg-indigo-50">
          <Plus size={11} /> เพิ่มชนิด
        </button>
      )}
      {err && <span className="text-rose-600 text-[10px]">{err}</span>}
    </div>
  );
}

function GroupTab() {
  const [groups, setGroups] = useState<CatalogGroupInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [unassigned, setUnassigned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'fill' | 'redo' | null>(null);
  // Which bucket is open for review: a group key, 'unassigned', or null (overview only).
  const [sel, setSel] = useState<string | null>(null);
  const [products, setProducts] = useState<GroupProduct[]>([]);
  const [prodLoading, setProdLoading] = useState(false);
  const [q, setQ] = useState('');
  // batch selection: SKUs ticked in the open bucket
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNote, setBatchNote] = useState('');
  // Anchor row index for shift-click range selection (index into the current `products` order).
  const lastIndexRef = useRef<number | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      const g = await getGroups();
      setGroups(g.groups);
      setTotal(g.total);
      setUnassigned(g.unassigned);
    } catch { /* leave as-is */ }
  }, []);
  useEffect(() => { loadGroups().finally(() => setLoading(false)); }, [loadGroups]);

  const loadProducts = useCallback(async (bucket: string, query: string) => {
    setProdLoading(true);
    try {
      const opts = bucket === 'unassigned' ? { filter: 'unassigned' as const, q: query } : { group: bucket, q: query };
      const r = await getGroupProducts(opts);
      setProducts(r.products);
    } catch { setProducts([]); } finally { setProdLoading(false); }
  }, []);

  // (re)load the open bucket when it or the (debounced) search changes.
  useEffect(() => {
    if (!sel) { setProducts([]); return; }
    const t = setTimeout(() => loadProducts(sel, q), 250);
    return () => clearTimeout(t);
  }, [sel, q, loadProducts]);

  // Keep selection within the current view: drop it when the bucket or search changes.
  useEffect(() => { setSelected(new Set()); setBatchNote(''); }, [sel, q]);
  // Prune selection to rows still present. A per-row move (changeProduct) filters a SKU out of
  // `products` without changing [sel, q]; it must NOT linger in `selected` and get swept into a
  // later batch acting on a row the supervisor can no longer see.
  useEffect(() => {
    lastIndexRef.current = null; // list changed → the old anchor index is meaningless
    setSelected((s) => {
      if (s.size === 0) return s;
      const visible = new Set(products.map((p) => p.sku));
      let changed = false;
      const n = new Set<string>();
      for (const sku of s) { if (visible.has(sku)) n.add(sku); else changed = true; }
      return changed ? n : s;
    });
  }, [products]);

  async function auto(redo: boolean) {
    if (redo && !window.confirm('จัดกลุ่มใหม่ทั้งหมด? การจัดด้วยมือจะถูกเขียนทับ')) return;
    setBusy(redo ? 'redo' : 'fill');
    try {
      await autoAssignGroups(!redo);
      await loadGroups();
      if (sel) await loadProducts(sel, q);
    } catch { /* ignore */ } finally { setBusy(null); }
  }

  async function changeProduct(sku: string, group: string | null) {
    // optimistic: update the row (changing group clears the sub-group), then drop it if it no
    // longer belongs to the open bucket.
    setProducts((ps) => {
      const updated = ps.map((p) => (p.sku === sku ? { ...p, catalogGroup: group, catalogSubgroup: null } : p));
      if (sel === 'unassigned') return updated.filter((p) => p.catalogGroup === null);
      if (sel) return updated.filter((p) => p.catalogGroup === sel);
      return updated;
    });
    try {
      await setProductGroup(sku, group);
      loadGroups();
    } catch {
      if (sel) loadProducts(sel, q); // revert to server truth on failure
    }
  }

  async function changeSubgroup(sku: string, sub: string | null) {
    setProducts((ps) => ps.map((p) => (p.sku === sku ? { ...p, catalogSubgroup: sub } : p)));
    try {
      await setSubgroup(sku, sub);
    } catch {
      if (sel) loadProducts(sel, q);
    }
  }

  function patchName(sku: string, nameTh: string, nameEn: string) {
    setProducts((ps) => ps.map((p) => (p.sku === sku ? { ...p, nameTh, nameEn } : p)));
  }

  // ── batch selection ──
  // Toggle one row, or — with Shift held — select every row between the last-clicked anchor and
  // this one (inclusive). The anchor is captured BEFORE setSelected so the state updater doesn't
  // observe the ref we advance right after.
  function toggleSelect(sku: string, index: number, shiftKey: boolean) {
    const anchor = lastIndexRef.current;
    setSelected((s) => {
      const n = new Set(s);
      if (shiftKey && anchor !== null) {
        const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = a; i <= b; i++) { const p = products[i]; if (p) n.add(p.sku); }
      } else if (n.has(sku)) {
        n.delete(sku);
      } else {
        n.add(sku);
      }
      return n;
    });
    lastIndexRef.current = index;
  }
  const allSelected = products.length > 0 && products.every((p) => selected.has(p.sku));
  // True size of the open bucket (from the uncapped groupBy), vs how many rows actually loaded.
  const bucketTotal = sel === 'unassigned' ? unassigned : (groups.find((g) => g.key === sel)?.count ?? products.length);
  // Loaded fewer than the bucket holds (only possible if a bucket ever exceeds the fetch cap) —
  // "select all" would then miss the overflow, so we say so instead of moving a silent subset.
  const truncated = !q.trim() && products.length < bucketTotal;
  const openGroup = groups.find((g) => g.key === sel);
  async function removeGroup() {
    if (!openGroup) return;
    if (!window.confirm(`ลบกลุ่ม “${openGroup.nameTh || openGroup.nameEn}”? สินค้า ${openGroup.count.toLocaleString('th-TH')} รายการจะกลายเป็น “ยังไม่จัด”`)) return;
    try { await deleteGroup(openGroup.key); setSel(null); await loadGroups(); }
    catch { setBatchNote('ลบกลุ่มไม่สำเร็จ ลองใหม่อีกครั้ง'); }
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(products.map((p) => p.sku)));
  }
  async function batchGroup(group: string | null) {
    const skus = [...selected];
    if (skus.length === 0) return;
    const name = group === null ? 'ยังไม่จัดกลุ่ม' : groups.find((x) => x.key === group)?.nameTh ?? group;
    if (!window.confirm(`ย้าย ${skus.length.toLocaleString('th-TH')} รายการไปที่ “${name}”?`)) return;
    setBatchBusy(true);
    setBatchNote('');
    try {
      const res = await setProductsGroup(skus, group);
      setSelected(new Set());
      setBatchNote(`ย้าย ${res.updated.toLocaleString('th-TH')} รายการไปที่ “${name}” แล้ว`);
      await loadGroups();
      if (sel) await loadProducts(sel, q);
    } catch { setBatchNote('ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง'); } finally { setBatchBusy(false); }
  }
  async function batchSubgroup(sub: string | null) {
    const skus = [...selected];
    if (skus.length === 0) return;
    setBatchBusy(true);
    setBatchNote('');
    try {
      const res = await setSubgroups(skus, sub);
      setSelected(new Set());
      setBatchNote(
        sub === null
          ? `ล้างชนิด ${res.updated.toLocaleString('th-TH')} รายการ`
          : `ตั้งชนิด ${res.updated.toLocaleString('th-TH')} รายการ${res.skipped > 0 ? ` · ข้าม ${res.skipped.toLocaleString('th-TH')} รายการ (คนละกลุ่ม)` : ''}`,
      );
      if (sel) await loadProducts(sel, q);
    } catch { setBatchNote('ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง'); } finally { setBatchBusy(false); }
  }

  const byPillar = (pl: Pillar) => groups.filter((g) => g.pillar === pl);
  const selName = sel === 'unassigned' ? 'ยังไม่จัดกลุ่ม' : groups.find((g) => g.key === sel)?.nameTh ?? '';
  const assigned = total - unassigned;

  if (loading) {
    return <div className="text-slate-400 py-8 text-center"><Loader2 size={18} className="animate-spin inline" /> กำลังโหลด…</div>;
  }

  return (
    <div className="max-w-5xl">
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
        <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <Layers size={18} className="text-indigo-600" /> จัดกลุ่มสินค้า
        </h2>
        <p className="text-sm text-slate-500 mb-3">
          จัดสินค้าเข้าหมวดตามชนิด (พิมพ์ปาก, อะคริลิก, รักษาราก, ฯลฯ) — ไม่แตะรหัส Express กด “จัดกลุ่มอัตโนมัติ” ให้ระบบเดาให้ก่อน แล้วแก้รายการที่ผิดได้
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => auto(false)}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'fill' ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />} จัดกลุ่มอัตโนมัติ
          </button>
          <button
            onClick={() => auto(true)}
            disabled={busy !== null}
            className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm disabled:opacity-50"
          >
            {busy === 'redo' ? <Loader2 size={15} className="animate-spin inline" /> : 'จัดใหม่ทั้งหมด'}
          </button>
          <CreateGroupForm onCreated={loadGroups} />
          <div className="ml-auto text-sm text-slate-500">
            จัดแล้ว <b className="text-slate-800">{assigned.toLocaleString('th-TH')}</b> / {total.toLocaleString('th-TH')} ·{' '}
            <button
              onClick={() => { setSel('unassigned'); setQ(''); }}
              className={unassigned > 0 ? 'text-amber-600 font-semibold hover:underline' : 'text-slate-400'}
            >
              ยังไม่จัด {unassigned.toLocaleString('th-TH')}
            </button>
          </div>
        </div>
      </div>

      {/* group overview by pillar */}
      <div className="space-y-4">
        {PILLAR_ORDER.map((pl) => (
          <div key={pl}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{PILLAR_LABEL[pl]}</div>
            <div className="flex flex-wrap gap-2">
              {byPillar(pl).map((g) => (
                <button
                  key={g.key}
                  onClick={() => { setSel(sel === g.key ? null : g.key); setQ(''); }}
                  className={`px-3 py-2 rounded-xl border text-sm flex items-center gap-2 transition ${
                    sel === g.key
                      ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100'
                      : g.count > 0
                        ? 'border-slate-200 bg-white hover:border-indigo-300'
                        : 'border-dashed border-slate-200 bg-slate-50 text-slate-400'
                  }`}
                >
                  <span className="font-medium">{g.nameTh}</span>
                  <span className={`text-xs font-bold tabular-nums ${g.count > 0 ? 'text-indigo-600' : 'text-slate-300'}`}>{g.count}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* review list for the open bucket */}
      {sel && (
        <div className="mt-5 bg-white rounded-2xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <h3 className="font-semibold text-slate-800">{selName}</h3>
            {openGroup?.custom && (
              <button onClick={removeGroup} title="ลบกลุ่มนี้" className="text-slate-300 hover:text-rose-600"><Trash2 size={15} /></button>
            )}
            <button onClick={() => setSel(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            <div className="relative flex-1 min-w-[200px]">
              <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ค้นหาในหมวดนี้…"
                className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            {products.length > 0 && (
              <button
                onClick={toggleAll}
                className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm whitespace-nowrap"
              >
                {allSelected ? 'ล้างที่เลือก' : truncated ? `เลือกที่โหลด (${products.length.toLocaleString('th-TH')})` : `เลือกทั้งหมด (${products.length.toLocaleString('th-TH')})`}
              </button>
            )}
          </div>

          {sel !== 'unassigned' && openGroup && (
            <SubgroupManager group={openGroup} onChanged={() => { loadGroups(); loadProducts(sel, q); }} />
          )}

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-3 p-2.5 rounded-xl bg-indigo-50 border border-indigo-200">
              <span className="text-sm font-semibold text-indigo-800 shrink-0">เลือก {selected.size.toLocaleString('th-TH')} รายการ</span>
              <span className="text-sm text-slate-500 shrink-0">→</span>
              <select
                value=""
                disabled={batchBusy}
                onChange={(e) => { const v = e.target.value; if (!v) return; batchGroup(v === '__clear__' ? null : v); }}
                className="shrink-0 w-48 px-2 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
              >
                <option value="">ย้ายไปกลุ่ม…</option>
                {PILLAR_ORDER.map((pl) => (
                  <optgroup key={pl} label={PILLAR_LABEL[pl]}>
                    {groups.filter((g) => g.pillar === pl).map((g) => (<option key={g.key} value={g.key}>{g.nameTh}</option>))}
                  </optgroup>
                ))}
                <option value="__clear__">— ล้างกลุ่ม (ยังไม่จัด) —</option>
              </select>
              {sel && sel !== 'unassigned' && (groups.find((x) => x.key === sel)?.subgroups.length ?? 0) > 0 && (
                <select
                  value=""
                  disabled={batchBusy}
                  onChange={(e) => { const v = e.target.value; if (!v) return; batchSubgroup(v === '__clear__' ? null : v); }}
                  className="shrink-0 w-40 px-2 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
                >
                  <option value="">ตั้งชนิด (subgroup)…</option>
                  {(groups.find((x) => x.key === sel)?.subgroups ?? []).map((s) => (<option key={s.code} value={s.code}>{s.nameTh}</option>))}
                  <option value="__clear__">— ล้างชนิด —</option>
                </select>
              )}
              {batchBusy && <Loader2 size={15} className="animate-spin text-indigo-500 shrink-0" />}
              <button
                onClick={() => setSelected(new Set())}
                disabled={batchBusy}
                className="ml-auto text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 disabled:opacity-50"
              >
                <X size={13} /> ยกเลิก
              </button>
            </div>
          )}

          {truncated && (
            <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <AlertTriangle size={13} className="shrink-0" /> โหลด {products.length.toLocaleString('th-TH')} จาก {bucketTotal.toLocaleString('th-TH')} รายการ — “เลือกทั้งหมด” จะเลือกเฉพาะที่โหลด ใช้ช่องค้นหาเพื่อจัดการส่วนที่เหลือ
            </div>
          )}
          {batchNote && (
            <div className="mb-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <Check size={13} className="shrink-0" /> {batchNote}
            </div>
          )}

          {prodLoading ? (
            <div className="text-slate-400 py-6 text-center"><Loader2 size={16} className="animate-spin inline" /></div>
          ) : products.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">ไม่มีสินค้าในรายการนี้</p>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[60vh] overflow-auto">
              {products.map((p, i) => (
                <GroupProductRow
                  key={p.sku}
                  product={p}
                  groups={groups}
                  index={i}
                  checked={selected.has(p.sku)}
                  onToggleSelect={toggleSelect}
                  onChangeGroup={changeProduct}
                  onChangeSubgroup={changeSubgroup}
                  onRenamed={patchName}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Name normalization review (ตรวจทานชื่อ) ──────────────────────────────
// Review AI-normalized English names before they replace the live name. NOTHING here changes a
// live product name until you press อนุมัติ — proposals are staged server-side. Approving copies
// the proposed name onto the live product (and makes it searchable); rejecting leaves it as-is.
const PROPOSAL_FILTERS: { key: ProposalFilter; label: string; count: (s: ProposalSummary) => number }[] = [
  { key: 'pending', label: 'รอตรวจ', count: (s) => s.pending },
  { key: 'review', label: '⚠ ต้องตรวจสอบ', count: (s) => s.review },
  { key: 'approved', label: 'อนุมัติแล้ว', count: (s) => s.approved },
  { key: 'rejected', label: 'ไม่ใช้', count: (s) => s.rejected },
  { key: 'all', label: 'ทั้งหมด', count: (s) => s.total },
];

// Full-size product photo overlay — click anywhere or press Esc to close.
function Lightbox({ photoSku, onClose }: { photoSku: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/70 flex items-center justify-center p-6 cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={`${API_URL}/content/product/${photoSku}`}
        alt=""
        className="max-w-[90vw] max-h-[85vh] rounded-2xl bg-white object-contain shadow-2xl"
        onError={onClose}
      />
    </div>
  );
}

function ReviewTab() {
  const [groups, setGroups] = useState<CatalogGroupInfo[]>([]);
  const [summary, setSummary] = useState<ProposalSummary | null>(null);
  const [filter, setFilter] = useState<ProposalFilter>('pending');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<NameProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'load' | 'bulk' | null>(null);
  // photoSku currently zoomed in the lightbox (null = closed)
  const [zoom, setZoom] = useState<string | null>(null);

  const loadSummary = useCallback(() => { getProposalSummary().then(setSummary).catch(() => {}); }, []);
  useEffect(() => { getGroups().then((g) => setGroups(g.groups)).catch(() => {}); }, []);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { products } = await getProposals(filter, q); setRows(products); }
    catch { setRows([]); }
    finally { setLoading(false); }
  }, [filter, q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const groupLabel = useCallback((g: string | null, sub: string | null): { text: string; muted: boolean } => {
    if (!g) return { text: 'ยังไม่จัดกลุ่ม', muted: true };
    const grp = groups.find((x) => x.key === g);
    const gName = grp?.nameTh ?? g;
    const sName = sub ? (grp?.subgroups.find((s) => s.code === sub)?.nameTh ?? sub) : '';
    return { text: sName ? `${gName} › ${sName}` : gName, muted: false };
  }, [groups]);

  // After a decide: update the row in place, or drop it if it no longer matches the open filter.
  function afterDecide(r: NameProposalRow) {
    setRows((rs) => rs.flatMap((x) => {
      if (x.sku !== r.sku) return [x];
      const merged = { ...x, ...r, alias: x.alias, catalogGroup: x.catalogGroup, catalogSubgroup: x.catalogSubgroup };
      const keep =
        filter === 'all' ? true :
        filter === 'pending' ? merged.status === 'pending' :
        filter === 'review' ? merged.status === 'pending' && merged.needsReview :
        filter === 'approved' ? merged.status === 'approved' :
        merged.status === 'rejected';
      return keep ? [merged] : [];
    }));
    loadSummary();
  }

  async function seed() {
    setBusy('load');
    try { await loadProposals(); await Promise.all([loadSummary(), load()]); }
    finally { setBusy(null); }
  }
  async function bulk() {
    const n = summary ? summary.pending - summary.review : 0;
    if (n <= 0) return;
    if (!window.confirm(
      `อนุมัติชื่อที่ปลอดภัย ${n.toLocaleString('th-TH')} รายการทั้งหมด?\n` +
      `ชื่อจริงจะถูกอัปเดตทันที (รายการที่ต้อง “ตรวจสอบ” จะไม่ถูกแตะ)`,
    )) return;
    setBusy('bulk');
    try { await bulkApproveSafe(); await Promise.all([loadSummary(), load()]); }
    finally { setBusy(null); }
  }

  const total = summary?.total ?? 0;
  const done = (summary?.approved ?? 0) + (summary?.rejected ?? 0);
  const safeN = summary ? summary.pending - summary.review : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="max-w-4xl">
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
        <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <ClipboardCheck size={18} className="text-indigo-600" /> ตรวจทานชื่อสินค้า
        </h2>
        <p className="text-sm text-slate-500 mb-3">
          ทบทวนชื่ออังกฤษที่ระบบปรับให้ก่อนบันทึกลงระบบจริง — <b>ชื่อจริงจะยังไม่เปลี่ยนจนกว่าคุณจะกด “อนุมัติ”</b>{' '}
          ชื่อเดิมจะขีดฆ่าไว้ให้เทียบ · แก้ข้อความในช่องได้ก่อนอนุมัติ · รายการ <span className="text-amber-700">⚠ ต้องตรวจสอบ</span> (สี/เฉดที่ระบบเดาไม่ได้) เก็บไว้ให้ทีมดูร่วมกัน
        </p>

        {total === 0 ? (
          <button onClick={seed} disabled={busy !== null}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {busy === 'load' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} โหลดข้อเสนอชื่อเพื่อเริ่มตรวจทาน
          </button>
        ) : (
          <>
            {/* progress */}
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-slate-500 tabular-nums shrink-0">
                ตรวจแล้ว <b className="text-slate-700">{done.toLocaleString('th-TH')}</b> / {total.toLocaleString('th-TH')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={bulk} disabled={busy !== null || safeN <= 0}
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40">
                {busy === 'bulk' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                อนุมัติชื่อที่ปลอดภัยทั้งหมด{safeN > 0 ? ` (${safeN.toLocaleString('th-TH')})` : ''}
              </button>
              <span className="text-[11px] text-slate-400">รายการที่ต้องตรวจสอบจะไม่ถูกอนุมัติอัตโนมัติ</span>
              <button onClick={seed} disabled={busy !== null}
                className="ml-auto text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1" title="โหลดข้อเสนอที่ยังไม่มีในระบบ">
                {busy === 'load' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} โหลดเพิ่ม
              </button>
            </div>
          </>
        )}
      </div>

      {/* filters + search */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาชื่อ / รหัสสินค้า…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {PROPOSAL_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 rounded-xl text-sm font-medium border flex items-center gap-1.5 ${
                filter === f.key
                  ? f.key === 'review' ? 'bg-amber-500 text-white border-amber-500' : 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {f.label}
              {summary && <span className={`text-xs tabular-nums ${filter === f.key ? 'opacity-80' : 'text-slate-400'}`}>{f.count(summary).toLocaleString('th-TH')}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4">
        {loading ? (
          <div className="text-slate-400 py-8 text-center"><Loader2 size={18} className="animate-spin inline" /> กำลังโหลด…</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400 py-8 text-center">
            {total === 0 ? 'ยังไม่มีข้อเสนอ — กด “โหลดข้อเสนอชื่อ” ด้านบน' : 'ไม่มีรายการในตัวกรองนี้'}
          </p>
        ) : (
          <div className="divide-y divide-slate-100 max-h-[64vh] overflow-auto">
            {rows.map((r) => (
              <ProposalRow key={r.sku} row={r} groupLabel={groupLabel} onDecided={afterDecide} onZoom={setZoom} />
            ))}
          </div>
        )}
      </div>
      {zoom && <Lightbox photoSku={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

function ProposalRow({
  row, groupLabel, onDecided, onZoom,
}: {
  row: NameProposalRow;
  groupLabel: (g: string | null, sub: string | null) => { text: string; muted: boolean };
  onDecided: (r: NameProposalRow) => void;
  onZoom: (photoSku: string) => void;
}) {
  const proposed = (row.proposedNameEn ?? '').trim();
  const [text, setText] = useState(proposed);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  // Discard any abandoned in-place edit when the row's proposal/status changes. ProposalRow is
  // reused across decides (same key=sku, no remount), so local text must not outlive the row
  // state it belonged to — otherwise a rejected row's inline approve could write leftover text.
  useEffect(() => { setText((row.proposedNameEn ?? '').trim()); setOpen(false); }, [row.sku, row.proposedNameEn, row.status]);
  const gl = groupLabel(row.catalogGroup, row.catalogSubgroup);
  const flagged = row.needsReview && row.status === 'pending';
  const editable = row.status === 'pending' || open;
  const liveDiffers = proposed !== row.nameEn.trim();

  async function decide(action: 'approve' | 'reject') {
    setBusy(action);
    try {
      // Only send edited text when the editor is actually visible (editable). An inline approve on
      // a closed approved/rejected row approves the STORED proposal, never leftover local text.
      const nameEn = action === 'approve' && editable ? text.trim() : undefined;
      const { product } = await decideProposal(row.sku, action, nameEn);
      onDecided(product);
      setOpen(false);
    } catch { /* leave the row as-is on failure */ } finally { setBusy(null); }
  }
  function startEdit() { setText(proposed); setOpen(true); }

  return (
    <div className={`py-2.5 ${flagged ? 'bg-amber-50/60 -mx-4 px-4' : ''}`}>
      <div className="flex items-start gap-2.5">
        {row.photoSku ? (
          <button type="button" onClick={() => onZoom(row.photoSku!)} title="คลิกเพื่อขยายรูป" className="shrink-0 cursor-zoom-in rounded hover:ring-2 hover:ring-indigo-300">
            <Thumb photoSku={row.photoSku} size={38} />
          </button>
        ) : (
          <Thumb photoSku={null} size={38} />
        )}
        <div className="min-w-0 flex-1">
          {editable ? (
            <>
              {liveDiffers && <div className="text-[13px] text-slate-400 line-through truncate">{row.nameEn || '—'}</div>}
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full text-sm font-semibold text-slate-800 bg-transparent border-b border-dashed border-slate-300 focus:border-indigo-500 focus:outline-none py-0.5"
              />
            </>
          ) : (
            <>
              <div className={`text-sm truncate ${row.status === 'approved' ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
                {row.nameEn || '—'}
              </div>
              {row.status === 'rejected' && liveDiffers && (
                <div className="text-[11px] text-slate-400 truncate">เสนอ: {proposed}</div>
              )}
            </>
          )}
          <div className="text-[10px] text-slate-400 font-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {row.alias && <span className="text-indigo-600 font-semibold">{row.alias}</span>}
            <span>{flatSku(row.sku)}</span>
            <span className={gl.muted ? 'text-amber-600' : 'text-slate-500'}>· {gl.text}</span>
            {flagged && <span className="font-sans not-italic text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-semibold">⚠ ต้องตรวจสอบ</span>}
          </div>
          {row.nameTh && <div className="text-[11px] text-slate-400 truncate mt-0.5">{row.nameTh}</div>}
          {row.expressName && (
            <div className="text-[11px] text-sky-800 truncate mt-0.5" title="ชื่อตามระบบ Express (อ้างอิง)">
              <span className="text-[9px] font-bold uppercase tracking-wide bg-sky-100 text-sky-700 rounded px-1 py-px mr-1">Express</span>
              {row.expressName}
            </div>
          )}
        </div>
        <StockPill stock={row.stock} reorderPoint={row.reorderPoint} />
        <div className="shrink-0 flex items-center gap-1.5">
          {row.status === 'pending' && (
            <>
              <button onClick={() => decide('approve')} disabled={busy !== null}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50">
                {busy === 'approve' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} อนุมัติ
              </button>
              <button onClick={() => decide('reject')} disabled={busy !== null}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 text-xs flex items-center gap-1 disabled:opacity-50">
                {busy === 'reject' ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} ไม่ใช้
              </button>
            </>
          )}
          {row.status === 'approved' && (open ? (
            <>
              <button onClick={() => decide('approve')} disabled={busy !== null}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50">
                {busy === 'approve' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} บันทึก
              </button>
              <button onClick={() => { setOpen(false); setText(proposed); }} className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-600">ยกเลิก</button>
            </>
          ) : (
            <>
              <span className="text-emerald-600 text-xs font-medium flex items-center gap-1"><Check size={13} /> อนุมัติแล้ว</span>
              <button onClick={startEdit} className="text-slate-400 hover:text-indigo-600 p-1" title="แก้ไขชื่อ"><Pencil size={13} /></button>
            </>
          ))}
          {row.status === 'rejected' && !open && (
            <>
              <span className="text-slate-400 text-xs">ไม่ใช้แล้ว</span>
              <button onClick={() => decide('approve')} disabled={busy !== null} className="text-xs text-indigo-600 hover:underline">อนุมัติ</button>
              <button onClick={startEdit} className="text-slate-400 hover:text-indigo-600 p-1" title="แก้ไขชื่อ"><Pencil size={13} /></button>
            </>
          )}
          {row.status === 'rejected' && open && (
            <>
              <button onClick={() => decide('approve')} disabled={busy !== null}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50">
                {busy === 'approve' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} บันทึก
              </button>
              <button onClick={() => { setOpen(false); setText(proposed); }} className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-600">ยกเลิก</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
