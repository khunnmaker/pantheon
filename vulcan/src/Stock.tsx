import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Boxes, Search, Upload, History, LogOut, AlertTriangle, Check, Loader2,
  Package, RefreshCw, ChevronRight, X,
} from 'lucide-react';
import {
  type Agent, type StockRow, type StockSummary, type StockImportRow,
  type StockAdjustmentRow, type ImportPreview,
  getSummary, getStockList, adjustStock, setReorderPoint, getImports, getAdjustments,
  previewImport, applyImport, clearSession,
} from './lib/api';

type Tab = 'stock' | 'import' | 'history';

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
  const [tab, setTab] = useState<Tab>('stock');
  const [summary, setSummary] = useState<StockSummary | null>(null);

  const loadSummary = useCallback(() => {
    getSummary().then(setSummary).catch(() => {});
  }, []);
  useEffect(() => loadSummary(), [loadSummary]);

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
            <TabBtn active={tab === 'stock'} onClick={() => setTab('stock')} icon={<Package size={15} />}>
              สต็อก
            </TabBtn>
            <TabBtn active={tab === 'import'} onClick={() => setTab('import')} icon={<Upload size={15} />}>
              นำเข้า CSV
            </TabBtn>
            <TabBtn active={tab === 'history'} onClick={() => setTab('history')} icon={<History size={15} />}>
              ประวัติ
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
            <span className="text-slate-400">{agent.name}</span>
            <button onClick={logout} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5">
        {tab === 'stock' && <StockTab onChanged={loadSummary} />}
        {tab === 'import' && (
          <ImportTab
            onApplied={() => {
              loadSummary();
              setTab('stock');
            }}
          />
        )}
        {tab === 'history' && <HistoryTab />}
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

// ── Stock list + manual adjust + reorder point ──────────────────────────
function StockTab({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'unknown'>('all');
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
            placeholder="ค้นหาด้วยชื่อหรือรหัสสินค้า (SKU)…"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'low', 'unknown'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-xl text-sm font-medium border ${
                filter === f
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {f === 'all' ? 'ทั้งหมด' : f === 'low' ? 'ใกล้หมด' : 'ไม่ทราบสต็อก'}
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
          <div className="font-medium text-slate-800">{row.nameTh || row.nameEn || row.sku}</div>
          <div className="text-xs text-slate-400 font-mono">{row.sku}</div>
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
      setErr(
        e instanceof Error && e.message === 'forbidden'
          ? 'ไม่มีสิทธิ์'
          : 'อ่านไฟล์ไม่สำเร็จ — ตรวจสอบว่าเป็น CSV จาก Express',
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
    } catch {
      setErr('นำเข้าไม่สำเร็จ');
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
          <Upload size={18} className="text-indigo-600" /> นำเข้าไฟล์สต็อกประจำวัน (Express CSV)
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
          เลือกไฟล์ CSV
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

          {unmatchedRows.length > 0 && (
            <div className="mb-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              <div className="font-semibold mb-1 flex items-center gap-1">
                <AlertTriangle size={13} /> SKU ที่ไม่พบในแคตตาล็อก (จะถูกข้าม ไม่สร้างใหม่):
              </div>
              <div className="font-mono">
                {unmatchedRows.slice(0, 30).map((r) => r.sku).join(', ')}
                {unmatchedRows.length > 30 && ` … (+${unmatchedRows.length - 30})`}
              </div>
            </div>
          )}

          <div className="max-h-80 overflow-auto border border-slate-100 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">SKU</th>
                  <th className="text-left px-3 py-2 font-semibold">ชื่อ (จาก CSV)</th>
                  <th className="text-right px-3 py-2 font-semibold">ปัจจุบัน</th>
                  <th className="text-right px-3 py-2 font-semibold">ใหม่</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={`${r.sku}-${i}`} className={`border-t border-slate-100 ${!r.matched ? 'bg-amber-50/40' : ''}`}>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.sku}</td>
                    <td className="px-3 py-1.5 text-slate-600">{r.csvName || '—'}</td>
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
                <div className="text-slate-700 font-mono text-xs">{a.sku}</div>
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
