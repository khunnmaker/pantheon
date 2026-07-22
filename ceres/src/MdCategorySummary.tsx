import { Fragment, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { baht, getCategorySummary, type CategorySummary, type CategorySummaryRow } from './lib/api';
import { groupByCategoryGroup } from './components/CategoryPicker';

// สรุปรายหมวด (category spend rollup) — new สรุป segment of the ประวัติ tab (see
// Md.tsx's HistoryComposedView). gm/ceo only, same gate as the rest of ประวัติ/ภาพรวม —
// enforced server-side by GET /api/ceres/reports/category-summary (requireCeresRole('gm',
// 'ceo')). Read-only: a date-range picker (default = current month-to-date), a table
// grouped by CeresCategory.group with per-group + grand-total rows, and a client-side CSV
// download (no new export endpoint — built from the same JSON already on screen).

function monthStartStr(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
}
function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
}

// Same formula-injection-safe CSV escaping + UTF-8 BOM/CRLF convention as the server's own
// CSV exports (api/src/routes/ceres/exports.ts esc()/sendCsv()) — kept as a local client-side
// copy since this button builds its file from data already fetched, not a new export route.
function escCsv(v: unknown): string {
  const raw = String(v ?? '');
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCategorySummaryCsv(data: CategorySummary, from: string, to: string) {
  const lines = [['กลุ่ม', 'หมวดหมู่', 'จำนวนรายการ', 'ยอดรวม'].join(',')];
  for (const row of data.rows) {
    lines.push([escCsv(row.group), escCsv(row.category), row.count, (row.totalSatang / 100).toFixed(2)].join(','));
  }
  lines.push(['', escCsv('รวมทั้งหมด'), data.grandTotal.count, (data.grandTotal.totalSatang / 100).toFixed(2)].join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ceres-category-summary-${from}_${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function MdCategorySummary() {
  const [from, setFrom] = useState(monthStartStr());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState<CategorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getCategorySummary(from, to)
      .then(setData)
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง'))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = groupByCategoryGroup<CategorySummaryRow>(data?.rows ?? []);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
        <span className="text-slate-400 text-sm">ถึง</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
        <button
          onClick={() => data && downloadCategorySummaryCsv(data, from, to)}
          disabled={!data || data.rows.length === 0}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50 ml-auto"
        >
          <Download size={14} /> ดาวน์โหลด CSV
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-8 bg-white rounded-xl border border-slate-200">
          ไม่มีรายการในช่วงที่เลือก
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs">
                  <th className="text-left font-semibold px-3 py-2">หมวดหมู่</th>
                  <th className="text-right font-semibold px-3 py-2">จำนวนรายการ</th>
                  <th className="text-right font-semibold px-3 py-2">ยอดรวม</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {groups.map((g) => {
                  const subtotalSatang = g.items.reduce((s, r) => s + r.totalSatang, 0);
                  const subtotalCount = g.items.reduce((s, r) => s + r.count, 0);
                  return (
                    <Fragment key={g.group}>
                      <tr className="bg-amber-50/60">
                        <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-amber-700">{g.group}</td>
                      </tr>
                      {g.items.map((row) => (
                        <tr key={row.category}>
                          <td className="px-3 py-2 pl-5 text-slate-700">{row.category}</td>
                          <td className="px-3 py-2 text-right text-slate-500">{row.count}</td>
                          <td className="px-3 py-2 text-right text-slate-700 font-medium">{baht(row.totalSatang / 100)}</td>
                        </tr>
                      ))}
                      <tr className="text-xs text-slate-400">
                        <td className="px-3 py-1 pl-5">รวม{g.group}</td>
                        <td className="px-3 py-1 text-right">{subtotalCount}</td>
                        <td className="px-3 py-1 text-right">{baht(subtotalSatang / 100)}</td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-700">
                  <td className="px-3 py-2.5">รวมทั้งหมด</td>
                  <td className="px-3 py-2.5 text-right">{data.grandTotal.count}</td>
                  <td className="px-3 py-2.5 text-right">{baht(data.grandTotal.totalSatang / 100)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
