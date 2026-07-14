import { useEffect, useState } from 'react';
import { Loader2, ShoppingCart, Check, AlertTriangle, PackageX } from 'lucide-react';
import { getReorderQueue, createRequest, flatSku, type ReorderRow } from '../lib/api';

// The reorder queue = Vesta's low-stock feed (stock <= reorderPoint). One-click "ขอสั่ง" per
// row creates a MercuryRequest (resolving/creating the ordinary MercuryItem from the Vesta SKU).
export default function ReorderQueue({ onRequested }: { onRequested: () => void }) {
  const [rows, setRows] = useState<ReorderRow[] | null>(null);
  const [error, setError] = useState('');
  const [busySku, setBusySku] = useState<string | null>(null);
  const [doneSkus, setDoneSkus] = useState<Set<string>>(new Set());

  async function load() {
    setError('');
    try {
      const { products } = await getReorderQueue();
      setRows(products);
    } catch {
      setError('โหลดคิวสั่งซื้อไม่สำเร็จ');
      setRows([]);
    }
  }
  useEffect(() => { void load(); }, []);

  async function request(row: ReorderRow) {
    if (busySku) return;
    setBusySku(row.sku);
    setError('');
    try {
      await createRequest({ vestaSku: row.sku, displayName: row.nameTh || row.nameEn || undefined });
      setDoneSkus((s) => new Set(s).add(row.sku));
      onRequested();
    } catch {
      setError('สร้างคำขอไม่สำเร็จ');
    } finally {
      setBusySku(null);
    }
  }

  if (rows === null) {
    return <div className="py-12 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-slate-700">สินค้าใกล้หมด (ต่ำกว่าจุดสั่งซื้อ)</h2>
        <span className="text-xs text-slate-400">{rows.length} รายการ</span>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3"><AlertTriangle size={14} /> {error}</div>
      )}

      {rows.length === 0 ? (
        <div className="py-12 flex flex-col items-center gap-2 text-slate-400">
          <PackageX size={28} />
          <p className="text-sm">ไม่มีสินค้าที่ต่ำกว่าจุดสั่งซื้อ</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">รหัส</th>
                  <th className="text-left font-medium px-3 py-2">ชื่อสินค้า</th>
                  <th className="text-right font-medium px-3 py-2">คงเหลือ</th>
                  <th className="text-right font-medium px-3 py-2">จุดสั่งซื้อ</th>
                  <th className="text-right font-medium px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const done = doneSkus.has(r.sku);
                  return (
                    <tr key={r.sku} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{flatSku(r.sku)}</td>
                      <td className="px-3 py-2">{r.nameTh || r.nameEn || <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={r.stock === 0 ? 'text-rose-600 font-semibold' : ''}>
                          {r.stock ?? '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.reorderPoint ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {done ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
                            <Check size={14} /> ขอแล้ว
                          </span>
                        ) : (
                          <button
                            onClick={() => request(r)}
                            disabled={busySku === r.sku}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold disabled:opacity-50"
                          >
                            {busySku === r.sku ? <Loader2 size={13} className="animate-spin" /> : <ShoppingCart size={13} />}
                            ขอสั่ง
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
