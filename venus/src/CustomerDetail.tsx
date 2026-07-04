import { useEffect, useState } from 'react';
import {
  ArrowLeft, Loader2, AlertTriangle, MapPin, Phone, User, CreditCard, Truck, Hash,
  ShoppingCart, MessageCircle, Wallet, StickyNote, Clock,
} from 'lucide-react';
import { getCustomer, type VenusCustomer } from './lib/api';
import { CreditChip } from './CustomerList';

type Tab = 'overview' | 'purchases' | 'chat' | 'payments' | 'notes';

// The rep-lens card: header + ภาพรวม (master data from the Express import) + stubbed
// future tabs. Venus Stage C has no sales/payments/notes data wired yet (Phase 1+ —
// see docs/VENUS_BRIEF.md §5-7), so those tabs show a "เร็วๆ นี้" placeholder rather
// than faking numbers.
export default function CustomerDetail({ code, onBack }: { code: string; onBack: () => void }) {
  const [customer, setCustomer] = useState<VenusCustomer | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    setBusy(true);
    setErr('');
    setCustomer(null);
    getCustomer(code)
      .then((r) => setCustomer(r.customer))
      .catch((e) => setErr(e instanceof Error && e.message.includes('404') ? 'ไม่พบลูกค้ารายนี้' : 'โหลดข้อมูลลูกค้าไม่สำเร็จ'))
      .finally(() => setBusy(false));
  }, [code]);

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-rose-600 mb-3">
        <ArrowLeft size={15} /> กลับไปรายชื่อลูกค้า
      </button>

      {busy ? (
        <div className="py-16 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : err ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-8 justify-center">
          <AlertTriangle size={14} /> {err}
        </div>
      ) : customer ? (
        <div>
          <CustomerHeader customer={customer} />

          <div className="flex gap-1 overflow-x-auto mb-4 border-b border-slate-200">
            <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={<Hash size={15} />} label="ภาพรวม" />
            <TabButton active={tab === 'purchases'} onClick={() => setTab('purchases')} icon={<ShoppingCart size={15} />} label="การซื้อ" disabled />
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageCircle size={15} />} label="แชท" disabled />
            <TabButton active={tab === 'payments'} onClick={() => setTab('payments')} icon={<Wallet size={15} />} label="การชำระเงิน" disabled />
            <TabButton active={tab === 'notes'} onClick={() => setTab('notes')} icon={<StickyNote size={15} />} label="โน้ต" disabled />
          </div>

          {tab === 'overview' && <Overview customer={customer} />}
          {tab === 'purchases' && <ComingSoon label="ประวัติการซื้อจะแสดงหลังนำเข้ารายงานยอดขายจาก Express" />}
          {tab === 'chat' && <ComingSoon label="ประวัติแชทจะเชื่อมกับคอนโซล Minerva" />}
          {tab === 'payments' && <ComingSoon label="ประวัติการชำระเงินจะดึงจาก Juno" />}
          {tab === 'notes' && <ComingSoon label="โน้ตและข้อควรระวังจะเปิดใช้งานในเฟสถัดไป" />}
        </div>
      ) : null}
    </div>
  );
}

function CustomerHeader({ customer: c }: { customer: VenusCustomer }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-slate-800">{c.name || '(ไม่มีชื่อ)'}</h2>
          {c.nameEn && <div className="text-sm text-slate-400">{c.nameEn}</div>}
          <div className="text-xs text-slate-400 font-mono mt-1">{c.code}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {c.custType && <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">{c.custType}</span>}
          {c.repCode && <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">พนักงานขาย {c.repCode}</span>}
          {c.zone && <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">เขต {c.zone}</span>}
          <CreditChip norm={c.creditTermsNorm} />
        </div>
      </div>
    </div>
  );
}

function Overview({ customer: c }: { customer: VenusCustomer }) {
  const rows: { icon: React.ReactNode; label: string; value: string }[] = [
    { icon: <MapPin size={15} />, label: 'ที่อยู่', value: c.address || '—' },
    { icon: <Phone size={15} />, label: 'โทร.', value: c.phone || '—' },
    { icon: <User size={15} />, label: 'ผู้ติดต่อ', value: c.contact || '—' },
    { icon: <Hash size={15} />, label: 'เลขที่บ/ช', value: c.acctNo || '—' },
    { icon: <Truck size={15} />, label: 'ขนส่งโดย', value: c.shipBy || '—' },
    {
      icon: <Clock size={15} />,
      label: 'เครดิต',
      value: c.creditDays != null ? `${c.creditDays} วัน${c.creditTerms ? ` (${c.creditTerms})` : ''}` : c.creditTerms || '—',
    },
    { icon: <CreditCard size={15} />, label: 'วงเงินเครดิต', value: c.creditLimit || '—' },
  ];
  if (c.priceType) rows.push({ icon: <Hash size={15} />, label: 'ประเภทราคา', value: c.priceType });
  if (c.discount) rows.push({ icon: <Hash size={15} />, label: 'ส่วนลด', value: c.discount });

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="text-sm font-semibold text-slate-500 mb-3">ข้อมูลหลัก</h3>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-2">
            <span className="text-slate-400 mt-0.5 shrink-0">{r.icon}</span>
            <div className="min-w-0">
              <dt className="text-xs text-slate-400">{r.label}</dt>
              <dd className="text-sm text-slate-700 break-words">{r.value}</dd>
            </div>
          </div>
        ))}
      </dl>
      {c.note && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-xs text-slate-400 mb-1">หมายเหตุจากการนำเข้า</div>
          <div className="text-sm text-slate-600 whitespace-pre-wrap">{c.note}</div>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active, onClick, icon, label, disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
        disabled
          ? 'border-transparent text-slate-300 cursor-not-allowed'
          : active
          ? 'border-rose-600 text-rose-700'
          : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {icon} {label}
      {disabled && <span className="text-[10px] text-slate-300 ml-1">(เร็วๆ นี้)</span>}
    </button>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-400">
      <div className="text-sm font-semibold mb-1">เร็วๆ นี้</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
