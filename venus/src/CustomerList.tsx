import { useEffect, useRef, useState } from 'react';
import { Search, Loader2, ChevronRight, ChevronLeft, AlertTriangle, Users } from 'lucide-react';
import { getCustomers, creditLabel, segmentColor, SEGMENTS, type VenusCustomerListRow, type Segment } from './lib/api';

const PAGE_SIZE = 50;

// Debounced search over name + code (dash-insensitive, server-side via searchKey) —
// paginated list/cards, mobile-friendly (reps live on phones). Tap a row to open the
// rep-lens detail card (CustomerDetail). Segment filter + chip come from the left-joined
// CustomerStats sliver the list endpoint now returns (segment, m).
export default function CustomerList({ onOpen }: { onOpen: (code: string) => void }) {
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState<Segment | ''>('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [customers, setCustomers] = useState<VenusCustomerListRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setBusy(true);
    setErr('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      getCustomers({ q, segment, limit: PAGE_SIZE, offset })
        .then((r) => {
          setCustomers(r.customers);
          setTotal(r.total);
        })
        .catch(() => setErr('โหลดรายชื่อลูกค้าไม่สำเร็จ'))
        .finally(() => setBusy(false));
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, segment, offset]);

  // Any change to the search text or segment filter resets pagination back to page 1.
  function onSearch(v: string) {
    setQ(v);
    setOffset(0);
  }
  function onSegment(v: Segment | '') {
    setSegment(v);
    setOffset(0);
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="relative mb-2">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="ค้นหาชื่อลูกค้า หรือรหัสลูกค้า…"
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
        />
      </div>

      <div className="flex gap-1.5 overflow-x-auto mb-4 pb-1">
        <button
          onClick={() => onSegment('')}
          className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium border ${
            segment === '' ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-500 border-slate-200'
          }`}
        >
          ทั้งหมด
        </button>
        {SEGMENTS.map((s) => (
          <button
            key={s}
            onClick={() => onSegment(s)}
            className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium border ${
              segment === s ? 'bg-rose-600 text-white border-rose-600' : `${segmentColor(s)} border-transparent`
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {err && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      {busy && customers.length === 0 ? (
        <div className="py-16 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : customers.length === 0 ? (
        <div className="py-16 flex flex-col items-center text-slate-400 gap-2">
          <Users size={28} />
          <span className="text-sm">{q ? 'ไม่พบลูกค้าที่ค้นหา' : 'ยังไม่มีข้อมูลลูกค้า'}</span>
        </div>
      ) : (
        <div className="space-y-2">
          {customers.map((c) => (
            <CustomerRow key={c.code} customer={c} onOpen={() => onOpen(c.code)} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || busy}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-40"
          >
            <ChevronLeft size={14} /> ก่อนหน้า
          </button>
          <span>
            หน้า {page} / {pageCount} · ทั้งหมด {total} ราย
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total || busy}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-40"
          >
            ถัดไป <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function CustomerRow({ customer: c, onOpen }: { customer: VenusCustomerListRow; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-white rounded-xl border border-slate-200 hover:border-rose-300 hover:bg-rose-50/40 px-4 py-3 flex items-center gap-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-slate-800 truncate">{c.name || '(ไม่มีชื่อ)'}</span>
          <SegmentChip segment={c.segment} />
          {c.custType && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">{c.custType}</span>
          )}
          <CreditChip norm={c.creditTermsNorm} />
        </div>
        <div className="text-xs text-slate-400 font-mono mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{c.code}</span>
          {c.repCode && <span className="font-sans text-slate-400">พนักงานขาย {c.repCode}</span>}
          {c.m != null && <span className="font-sans text-slate-400">฿{c.m.toLocaleString('th-TH', { maximumFractionDigits: 0 })}</span>}
        </div>
      </div>
      <ChevronRight size={16} className="text-slate-300 shrink-0" />
    </button>
  );
}

export function SegmentChip({ segment }: { segment: Segment | null | undefined }) {
  if (!segment) return null;
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${segmentColor(segment)}`}>{segment}</span>;
}

export function CreditChip({ norm }: { norm: VenusCustomerListRow['creditTermsNorm'] }) {
  if (!norm) return null;
  const cls =
    norm === 'CREDIT'
      ? 'bg-amber-100 text-amber-700'
      : norm === 'PREPAY'
      ? 'bg-sky-100 text-sky-700'
      : norm === 'CASH'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-600';
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{creditLabel(norm)}</span>;
}
