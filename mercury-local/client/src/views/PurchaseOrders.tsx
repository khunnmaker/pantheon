import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, FileText } from 'lucide-react';
import { getPurchaseOrders, type PurchaseOrder } from '../lib/api';

// Purchase Orders — read-only list scaffold. The PO builder (pull cloud requests → resolve
// aliases → grouped PDF → Gmail review-then-send) comes in a later chunk. Empty for now.
export default function PurchaseOrders() {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getPurchaseOrders()
      .then(({ orders }) => setOrders(orders))
      .catch(() => {
        setError('โหลดใบสั่งซื้อไม่สำเร็จ');
        setOrders([]);
      });
  }, []);

  return (
    <div>
      <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
        ตัวสร้างใบสั่งซื้อ (ดึงคำขอจาก cloud → แก้ alias → PDF → ส่งอีเมลแบบตรวจก่อนส่ง) จะมาในขั้นถัดไป
        หน้านี้แสดงรายการใบสั่งซื้อที่มีอยู่เท่านั้น
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {orders === null ? (
        <div className="py-12 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : orders.length === 0 ? (
        <div className="py-16 text-center text-slate-400">
          <FileText size={28} className="mx-auto mb-2 opacity-50" />
          <div className="text-sm">ยังไม่มีใบสั่งซื้อ</div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">เลขที่</th>
                  <th className="text-left font-medium px-3 py-2">ผู้ขาย</th>
                  <th className="text-left font-medium px-3 py-2">สถานะ</th>
                  <th className="text-right font-medium px-3 py-2">จำนวนบรรทัด</th>
                  <th className="text-left font-medium px-3 py-2">สร้างเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{o.poNumber ?? '—'}</td>
                    <td className="px-3 py-2">{o.vendor?.name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-xs rounded-full px-2 py-0.5 ${
                          o.status === 'sent'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500">{o.lines.length}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {new Date(o.createdAt).toLocaleDateString('th-TH')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
