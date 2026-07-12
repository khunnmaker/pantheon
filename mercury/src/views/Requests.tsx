import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, X, PackageX, PackageCheck } from 'lucide-react';
import {
  getRequests,
  setRequestStatus,
  receiveRequest,
  type MercuryRequest,
  type RequestStatus,
} from '../lib/api';

const STATUS_META: Record<RequestStatus, { label: string; cls: string }> = {
  pending: { label: 'รอสั่ง', cls: 'bg-amber-100 text-amber-700' },
  ordered: { label: 'สั่งแล้ว', cls: 'bg-sky-100 text-sky-700' },
  received: { label: 'รับแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'ยกเลิก', cls: 'bg-slate-100 text-slate-500' },
};

const FILTERS: { id: RequestStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'pending', label: 'รอสั่ง' },
  { id: 'ordered', label: 'สั่งแล้ว' },
  { id: 'received', label: 'รับแล้ว' },
  { id: 'cancelled', label: 'ยกเลิก' },
];

export default function Requests({ onChanged }: { onChanged: () => void }) {
  const [requests, setRequests] = useState<MercuryRequest[] | null>(null);
  const [filter, setFilter] = useState<RequestStatus | 'all'>('all');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(f = filter) {
    setError('');
    try {
      const { requests } = await getRequests(f === 'all' ? undefined : f);
      setRequests(requests);
    } catch {
      setError('โหลดคำขอไม่สำเร็จ');
      setRequests([]);
    }
  }
  useEffect(() => { void load(filter); /* eslint-disable-next-line */ }, [filter]);

  async function cancel(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError('');
    try {
      await setRequestStatus(id, 'cancelled');
      await load();
      onChanged();
    } catch {
      setError('ยกเลิกไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  }

  // Goods-receipt for an ORDINARY item: confirm the received qty (prefilled from the request),
  // then call the receive endpoint (marks 'received' + bumps Vesta stock via the shared path).
  async function receive(r: MercuryRequest) {
    if (busyId) return;
    const suggested = (r.qty ?? '').trim() || '1';
    const input = window.prompt(
      `รับของ "${r.item?.displayName ?? ''}" — ใส่จำนวนที่รับเข้า (จะบวกเข้าสต็อก Vesta)`,
      suggested,
    );
    if (input === null) return; // cancelled the prompt
    const qty = Number(input.trim());
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('จำนวนที่รับต้องเป็นจำนวนเต็มบวก');
      return;
    }
    setBusyId(r.id);
    setError('');
    try {
      await receiveRequest(r.id, qty);
      await load();
      onChanged();
    } catch {
      setError('รับของไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === f.id ? 'bg-orange-600 text-white' : 'bg-white border border-slate-200 text-slate-500 hover:text-slate-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3"><AlertTriangle size={14} /> {error}</div>
      )}

      {requests === null ? (
        <div className="py-12 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={22} /></div>
      ) : requests.length === 0 ? (
        <div className="py-12 flex flex-col items-center gap-2 text-slate-400">
          <PackageX size={28} />
          <p className="text-sm">ไม่มีคำขอในสถานะนี้</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">สินค้า</th>
                  <th className="text-right font-medium px-3 py-2">จำนวน</th>
                  <th className="text-left font-medium px-3 py-2">หมายเหตุ</th>
                  <th className="text-left font-medium px-3 py-2">สถานะ</th>
                  <th className="text-left font-medium px-3 py-2">วันที่</th>
                  <th className="text-right font-medium px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const meta = STATUS_META[r.status];
                  // Ordinary = has a Vesta SKU on the cloud row and isn't flagged secret. Only
                  // ordinary items can be received on the cloud (the cloud can resolve their SKU).
                  const isOrdinary = !!r.item && !r.item.isSecret && !!r.item.vestaSku;
                  const canReceive =
                    !!r.item && r.status !== 'received' && r.status !== 'cancelled';
                  const busy = busyId === r.id;
                  return (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{r.item?.displayName ?? <span className="text-slate-400">(ลบแล้ว)</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.qty || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{r.note || <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs rounded-full px-2 py-0.5 ${meta.cls}`}>{meta.label}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleDateString('th-TH')}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {canReceive && isOrdinary && (
                            <button
                              onClick={() => receive(r)}
                              disabled={busy}
                              title="รับของเข้าสต็อก Vesta"
                              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                            >
                              {busy ? <Loader2 size={13} className="animate-spin" /> : <PackageCheck size={13} />} รับของ
                            </button>
                          )}
                          {canReceive && !isOrdinary && (
                            <span className="text-xs text-slate-400" title="สินค้าลับ — รับของผ่านเครื่อง local ที่รู้ SKU จริง">
                              รับของผ่าน Mercury เครื่อง local
                            </span>
                          )}
                          {r.status === 'pending' && (
                            <button
                              onClick={() => cancel(r.id)}
                              disabled={busy}
                              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-rose-600 disabled:opacity-50"
                            >
                              {busy ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} ยกเลิก
                            </button>
                          )}
                        </div>
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
