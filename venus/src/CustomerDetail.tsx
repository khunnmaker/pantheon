import { useEffect, useState } from 'react';
import {
  ArrowLeft, Loader2, AlertTriangle, MapPin, Phone, User, CreditCard, Truck, Hash,
  ShoppingCart, MessageCircle, Wallet, StickyNote, Clock, ChevronDown, ChevronUp,
  ShieldAlert, PackageSearch, TrendingUp, TrendingDown,
} from 'lucide-react';
import {
  getCustomer, trendArrow, trendColor, formatBaht, formatDate,
  type VenusCustomer, type CustomerStats, type Purchase, type ProductCycle, type CustomerPrecautions,
} from './lib/api';
import { CreditChip, SegmentChip } from './CustomerList';

type Tab = 'overview' | 'purchases' | 'chat' | 'payments' | 'notes';

// The rep-lens card: header (name/code/credit/segment/trend) + ภาพรวม (RFM + active
// signals) + การซื้อ (purchase timeline + per-product cycle table), both now backed by the
// enriched GET /api/venus/customers/:code (customer + stats + purchases + productCycles +
// precautions). แชท/การชำระเงิน/โน้ต stay stubbed — those are later phases (Juno wiring,
// Minerva deep-link, free-text notes) and must not fake data (VENUS_BRIEF.md §7-8).
export default function CustomerDetail({ code, onBack }: { code: string; onBack: () => void }) {
  const [customer, setCustomer] = useState<VenusCustomer | null>(null);
  const [stats, setStats] = useState<CustomerStats | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [productCycles, setProductCycles] = useState<ProductCycle[]>([]);
  const [precautions, setPrecautions] = useState<CustomerPrecautions | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    setBusy(true);
    setErr('');
    setCustomer(null);
    setTab('overview');
    getCustomer(code)
      .then((r) => {
        setCustomer(r.customer);
        setStats(r.stats);
        setPurchases(r.purchases);
        setProductCycles(r.productCycles);
        setPrecautions(r.precautions);
      })
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
          <CustomerHeader customer={customer} stats={stats} />

          <div className="flex gap-1 overflow-x-auto mb-4 border-b border-slate-200">
            <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={<Hash size={15} />} label="ภาพรวม" />
            <TabButton active={tab === 'purchases'} onClick={() => setTab('purchases')} icon={<ShoppingCart size={15} />} label="การซื้อ" />
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageCircle size={15} />} label="แชท" disabled />
            <TabButton active={tab === 'payments'} onClick={() => setTab('payments')} icon={<Wallet size={15} />} label="การชำระเงิน" disabled />
            <TabButton active={tab === 'notes'} onClick={() => setTab('notes')} icon={<StickyNote size={15} />} label="โน้ต" disabled />
          </div>

          {tab === 'overview' && <Overview customer={customer} stats={stats} precautions={precautions} />}
          {tab === 'purchases' && <Purchases purchases={purchases} productCycles={productCycles} />}
          {tab === 'chat' && <ComingSoon label="ประวัติแชทจะเชื่อมกับคอนโซล Minerva" />}
          {tab === 'payments' && <ComingSoon label="ประวัติการชำระเงินจะดึงจาก Juno" />}
          {tab === 'notes' && <ComingSoon label="โน้ตและข้อควรระวังจะเปิดใช้งานในเฟสถัดไป" />}
        </div>
      ) : null}
    </div>
  );
}

function CustomerHeader({ customer: c, stats }: { customer: VenusCustomer; stats: CustomerStats | null }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-slate-800">{c.name || '(ไม่มีชื่อ)'}</h2>
          {c.nameEn && <div className="text-sm text-slate-400">{c.nameEn}</div>}
          <div className="text-xs text-slate-400 font-mono mt-1">{c.code}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {stats?.segment && <SegmentChip segment={stats.segment} />}
          {stats?.trendDir && stats.trendDir !== 'flat' && (
            <span className={`text-xs px-2 py-1 rounded-full bg-slate-50 font-semibold flex items-center gap-1 ${trendColor(stats.trendDir)}`}>
              {trendArrow(stats.trendDir)} {Math.abs(stats.trendPct ?? 0).toFixed(0)}%
            </span>
          )}
          {c.custType && <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">{c.custType}</span>}
          {c.repCode && <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">พนักงานขาย {c.repCode}</span>}
          {c.zone && <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600">เขต {c.zone}</span>}
          <CreditChip norm={c.creditTermsNorm} />
        </div>
      </div>
    </div>
  );
}

function Overview({
  customer: c, stats, precautions,
}: {
  customer: VenusCustomer;
  stats: CustomerStats | null;
  precautions: CustomerPrecautions | null;
}) {
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

  const reorderCount = stats?.reorderDue?.length ?? 0;

  return (
    <div className="space-y-4">
      {/* RFM + trend + active signals — rules-computed badges, no AI narration yet
          (VENUS_BRIEF.md §7: "the rules layer is the product; AI is the narrator", a
          later phase — do not fake a suggestion card here). */}
      {stats ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-500 mb-3">คะแนน RFM และสัญญาณ</h3>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-4">
            <RfmStat label="ล่าสุด (R)" value={stats.r != null ? `${stats.r} วัน` : '—'} />
            <RfmStat label="ความถี่ (F)" value={stats.f != null ? `${stats.f} ครั้ง` : '—'} />
            <RfmStat label="มูลค่า (M)" value={formatBaht(stats.m)} />
            <RfmStat label="คะแนน RFM" value={stats.rfmScore ?? '—'} />
            <RfmStat
              label="แนวโน้ม 90 วัน"
              value={stats.trendDir ? `${trendArrow(stats.trendDir)} ${Math.abs(stats.trendPct ?? 0).toFixed(0)}%` : '—'}
              valueClass={trendColor(stats.trendDir)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {stats.segment === 'เสี่ยงหาย' && (
              <SignalBadge icon={<ShieldAlert size={13} />} tone="warn">
                เสี่ยงหาย — หายไป {stats.r} วัน ทั้งที่เคยซื้อบ่อย/มูลค่าสูง
              </SignalBadge>
            )}
            {reorderCount > 0 && (
              <SignalBadge icon={<PackageSearch size={13} />} tone="rose">
                ถึงรอบสั่ง {reorderCount} รายการ
              </SignalBadge>
            )}
            {stats.trendDir === 'up' && (stats.trendPct ?? 0) > 20 && (
              <SignalBadge icon={<TrendingUp size={13} />} tone="ok">
                ยอดซื้อพุ่งขึ้น {(stats.trendPct ?? 0).toFixed(0)}%
              </SignalBadge>
            )}
            {stats.trendDir === 'down' && (stats.trendPct ?? 0) < -20 && (
              <SignalBadge icon={<TrendingDown size={13} />} tone="warn">
                ยอดซื้อลดลง {Math.abs(stats.trendPct ?? 0).toFixed(0)}%
              </SignalBadge>
            )}
            {reorderCount === 0 && stats.segment !== 'เสี่ยงหาย' && stats.trendDir !== 'down' && (
              <span className="text-xs text-slate-300">ไม่มีสัญญาณเด่นตอนนี้</span>
            )}
          </div>
          {reorderCount > 0 && stats.reorderDue && (
            <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
              {stats.reorderDue.map((r) => (
                <div key={r.sku} className="text-xs text-slate-600 flex items-center justify-between">
                  <span>ถึงรอบสั่ง: <span className="font-mono">{r.sku}</span></span>
                  <span className="text-rose-600 font-medium">เลยรอบ {r.dueSinceDays} วัน (ปกติทุก {r.medianGapDays} วัน)</span>
                </div>
              ))}
            </div>
          )}
          {stats.dataFrom && stats.dataTo && (
            <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-300">
              คำนวณจากข้อมูล {formatDate(stats.dataFrom)} – {formatDate(stats.dataTo)}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-5 text-center text-slate-400 text-sm">
          ยังไม่มีข้อมูลยอดขายสำหรับลูกค้ารายนี้ — ยังไม่คำนวณ RFM
        </div>
      )}

      {/* Precautions — only the credit flag is wired today; the other three (payment
          behavior, churn evidence narration, complaint tags) are later phases. */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-500 mb-3">ข้อควรระวัง</h3>
        <div className="space-y-2 text-sm">
          <PrecautionRow label="การชำระเงิน" value={precautions?.credit ?? null} />
          <PrecautionRow label="พฤติกรรมการจ่าย" value={precautions?.payment} soonLabel="รอเชื่อมข้อมูลจาก Juno" />
          <PrecautionRow label="เสี่ยงหาย" value={precautions?.churn} soonLabel="เพิ่มหลักฐานประกอบในเฟสถัดไป" />
          <PrecautionRow label="เคยมีปัญหา" value={precautions?.complaints} soonLabel="รอระบบแท็กจากประวัติแชท" />
        </div>
      </div>

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
    </div>
  );
}

function RfmStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="text-center px-2 py-2 rounded-xl bg-slate-50">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${valueClass ?? 'text-slate-700'}`}>{value}</div>
    </div>
  );
}

function SignalBadge({ icon, tone, children }: { icon: React.ReactNode; tone: 'warn' | 'rose' | 'ok'; children: React.ReactNode }) {
  const cls = tone === 'warn' ? 'bg-amber-100 text-amber-700' : tone === 'rose' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700';
  return (
    <span className={`text-xs px-2 py-1 rounded-full font-medium flex items-center gap-1 ${cls}`}>
      {icon} {children}
    </span>
  );
}

function PrecautionRow({ label, value, soonLabel }: { label: string; value: string | null | undefined; soonLabel?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-slate-500 shrink-0">{label}</span>
      {value ? (
        <span className="text-slate-800 font-medium text-right">{value}</span>
      ) : (
        <span className="text-slate-300 text-xs text-right">{soonLabel ?? 'ยังไม่มีข้อมูล'}</span>
      )}
    </div>
  );
}

function Purchases({ purchases, productCycles }: { purchases: Purchase[]; productCycles: ProductCycle[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(docNo: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(docNo)) next.delete(docNo); else next.add(docNo);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-500 mb-3">สรุปสินค้าที่เคยซื้อ</h3>
        {productCycles.length === 0 ? (
          <div className="text-sm text-slate-300 py-4 text-center">ยังไม่มีประวัติการซื้อ</div>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="text-xs text-slate-400 text-left">
                  <th className="px-2 py-1.5 font-medium">สินค้า</th>
                  <th className="px-2 py-1.5 font-medium text-center">ซื้อกี่ครั้ง</th>
                  <th className="px-2 py-1.5 font-medium">ซื้อล่าสุด</th>
                  <th className="px-2 py-1.5 font-medium text-right">สถานะรอบซื้อ</th>
                </tr>
              </thead>
              <tbody>
                {productCycles.map((p) => (
                  <tr key={p.sku} className="border-t border-slate-50">
                    <td className="px-2 py-1.5">
                      <div className="text-slate-700">{p.name || '(ไม่ทราบชื่อ)'}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{p.sku}</div>
                    </td>
                    <td className="px-2 py-1.5 text-center text-slate-600">{p.count}</td>
                    <td className="px-2 py-1.5 text-slate-600">{formatDate(p.lastPurchase)}</td>
                    <td className="px-2 py-1.5 text-right">
                      {p.reorderStatus === 'due' && p.reorderDue ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-medium">
                          ถึงรอบสั่ง (เลย {p.reorderDue.dueSinceDays} วัน)
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">ปกติ</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-500 mb-3">ประวัติการซื้อ (ล่าสุด {purchases.length} รายการ)</h3>
        {purchases.length === 0 ? (
          <div className="text-sm text-slate-300 py-4 text-center">ยังไม่มีประวัติการซื้อ</div>
        ) : (
          <div className="space-y-1.5">
            {purchases.map((doc) => {
              const isOpen = expanded.has(doc.docNo);
              return (
                <div key={doc.docNo} className="border border-slate-100 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggle(doc.docNo)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 ${doc.void ? 'opacity-50' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800 flex items-center gap-2">
                        {formatDate(doc.date)}
                        {doc.void && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">ยกเลิก</span>}
                      </div>
                      <div className="text-xs text-slate-400 font-mono">{doc.docNo} · {doc.lines.length} รายการ</div>
                    </div>
                    <span className="text-sm font-bold text-slate-700 shrink-0">{formatBaht(doc.total)}</span>
                    {isOpen ? <ChevronUp size={16} className="text-slate-300" /> : <ChevronDown size={16} className="text-slate-300" />}
                  </button>
                  {isOpen && (
                    <div className="border-t border-slate-100 px-3 py-2 bg-slate-50/50">
                      {doc.lines.map((l, i) => (
                        <div key={i} className="flex items-center justify-between text-xs py-1">
                          <div className="min-w-0 flex-1">
                            <span className="text-slate-600">{l.name || l.sku || '(ไม่ทราบสินค้า)'}</span>
                            <span className="text-slate-400 ml-1 font-mono">{l.sku}</span>
                          </div>
                          <span className="text-slate-400 mx-2 shrink-0">x{l.qty}</span>
                          <span className="text-slate-600 font-medium shrink-0">{formatBaht(l.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
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
