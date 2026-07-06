import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, CalendarRange, TrendingUp, TrendingDown, PackageSearch, ShieldAlert, RefreshCw, Sparkles } from 'lucide-react';
import {
  getDashboard, recompute, generateCards, segmentColor, formatBaht, formatDate, trendArrow, trendColor, SEGMENTS,
  type DashboardResult,
} from './lib/api';

// Management lens (VENUS_BRIEF.md §8): segment distribution, at-risk list ranked by M
// ("lose the biggest first"), top movers, and the opportunity queue (reorder-due
// customers). Pure reads over CustomerStats via GET /api/venus/dashboard — nothing here
// recomputes; that only happens via the supervisor's POST /api/venus/recompute.
export default function Dashboard({ onOpen, canManage }: { onOpen: (code: string) => void; canManage?: boolean }) {
  const [data, setData] = useState<DashboardResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeErr, setRecomputeErr] = useState('');

  function load() {
    setBusy(true);
    setErr('');
    getDashboard()
      .then(setData)
      .catch(() => setErr('โหลดแดชบอร์ดไม่สำเร็จ'))
      .finally(() => setBusy(false));
  }
  useEffect(() => { load(); }, []);

  async function onRecompute() {
    setRecomputing(true);
    setRecomputeErr('');
    try {
      await recompute();
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setRecomputeErr(msg === 'forbidden' ? 'เฉพาะหัวหน้าเท่านั้น' : 'คำนวณใหม่ไม่สำเร็จ');
    } finally {
      setRecomputing(false);
    }
  }

  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState('');
  async function onGenerateCards() {
    setGenerating(true);
    setGenMsg('');
    try {
      const r = await generateCards({ full: true });
      setGenMsg(
        r.started
          ? `เริ่มสร้างคำแนะนำ AI ทั้งหมดในเบื้องหลังแล้ว (ลูกค้าที่มีสัญญาณ ${r.candidates ?? '~2,000'} ราย) — ใช้เวลาสักครู่ การ์ดจะทยอยขึ้นบนหน้าลูกค้า`
          : (r.skippedNoLlm ?? 0) > 0
          ? 'ยังไม่ได้ตั้งค่า AI key บนเซิร์ฟเวอร์ (ระบบยังทำงานได้ — จะแสดงเป็นแบดจ์สัญญาณแทน)'
          : (r.skippedError ?? 0) > 0
          ? 'AI ทำงานผิดพลาด (อาจต้องตรวจรุ่นโมเดล/คีย์) — แจ้งผู้ดูแลระบบ'
          : 'ไม่มีลูกค้าที่มีสัญญาณให้สร้างคำแนะนำ',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setGenMsg(msg === 'forbidden' ? 'เฉพาะหัวหน้าเท่านั้น' : 'สร้างคำแนะนำไม่สำเร็จ');
    } finally {
      setGenerating(false);
    }
  }

  if (busy) {
    return (
      <div className="py-16 flex justify-center text-slate-400">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }
  if (err || !data) {
    return (
      <div className="flex items-center gap-1 text-rose-600 text-sm py-8 justify-center">
        <AlertTriangle size={14} /> {err || 'ไม่มีข้อมูล'}
      </div>
    );
  }

  const maxSegmentCount = Math.max(1, ...SEGMENTS.map((s) => data.segmentCounts[s] ?? 0));

  return (
    <div className="space-y-4">
      {/* Data-coverage banner — a short window must never be misread as a real trend. */}
      <div className="bg-white rounded-2xl border border-slate-200 px-4 py-3 flex items-center gap-2 flex-wrap text-sm text-slate-600">
        <CalendarRange size={16} className="text-rose-500 shrink-0" />
        <span>
          ข้อมูลการขาย: <b>{formatDate(data.coverage.from)}</b> – <b>{formatDate(data.coverage.to)}</b>
        </span>
        <span className="ml-auto text-xs text-slate-400">
          ลูกค้าทั้งหมด {data.totalCustomers.toLocaleString('th-TH')} · มีข้อมูลการซื้อ {data.totalWithSales.toLocaleString('th-TH')} ราย
        </span>
        {canManage && (
          <button
            onClick={onRecompute}
            disabled={recomputing}
            title="คำนวณกลุ่มลูกค้า/สัญญาณใหม่จากข้อมูลล่าสุด (อาจใช้เวลาสักครู่)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold disabled:opacity-60 shrink-0"
          >
            {recomputing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {recomputing ? 'กำลังคำนวณ…' : 'คำนวณใหม่'}
          </button>
        )}
        {canManage && (
          <button
            onClick={onGenerateCards}
            disabled={generating}
            title="สร้างคำแนะนำ AI สำหรับลูกค้ารายมูลค่าสูงที่มีสัญญาณ (ใช้เวลาสักครู่)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold disabled:opacity-60 shrink-0"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {generating ? 'กำลังสร้าง…' : 'สร้างคำแนะนำ AI'}
          </button>
        )}
      </div>
      {recomputeErr && (
        <div className="flex items-center gap-1 text-rose-600 text-xs -mt-2 px-1">
          <AlertTriangle size={12} /> {recomputeErr}
        </div>
      )}
      {genMsg && <div className="text-xs -mt-2 px-1 text-slate-600">{genMsg}</div>}

      {/* Segment distribution */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-500 mb-3">การแบ่งกลุ่มลูกค้า (RFM)</h3>
        <div className="space-y-2">
          {SEGMENTS.map((s) => {
            const n = data.segmentCounts[s] ?? 0;
            return (
              <div key={s} className="flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium w-28 text-center shrink-0 ${segmentColor(s)}`}>{s}</span>
                <div className="flex-1 h-4 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${segmentColor(s).split(' ')[0]}`}
                    style={{ width: `${Math.max(2, (n / maxSegmentCount) * 100)}%` }}
                  />
                </div>
                <span className="text-sm font-semibold text-slate-700 w-10 text-right shrink-0">{n}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* At-risk list — the headline actionable list, ranked by revenue at stake. */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-500 mb-1 flex items-center gap-1.5">
          <ShieldAlert size={15} className="text-amber-500" /> เสี่ยงหาย — เรียงตามมูลค่าที่จะเสีย
        </h3>
        <p className="text-xs text-slate-400 mb-3">ลูกค้าที่เคยซื้อมาก/บ่อย แต่หายไปนาน — เริ่มจากรายที่มูลค่าสูงสุด</p>
        {data.atRisk.length === 0 ? (
          <div className="text-sm text-slate-300 py-4 text-center">ไม่มีลูกค้าที่เสี่ยงหายตอนนี้</div>
        ) : (
          <div className="space-y-1.5">
            {data.atRisk.map((r) => (
              <button
                key={r.code}
                onClick={() => onOpen(r.code)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-amber-50 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 truncate">{r.name || r.code}</div>
                  <div className="text-xs text-slate-400 font-mono">{r.code} · ซื้อ {r.f} ครั้ง</div>
                </div>
                <span className="text-sm font-bold text-amber-700 shrink-0">{formatBaht(r.m)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Top movers */}
      <section className="grid sm:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-500 mb-3 flex items-center gap-1.5">
            <TrendingUp size={15} className="text-emerald-500" /> ยอดขายพุ่งขึ้น
          </h3>
          <MoverList rows={data.topMovers.up} onOpen={onOpen} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-500 mb-3 flex items-center gap-1.5">
            <TrendingDown size={15} className="text-rose-500" /> ยอดขายลดลง
          </h3>
          <MoverList rows={data.topMovers.down} onOpen={onOpen} />
        </div>
      </section>

      {/* Opportunity queue */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-500 mb-1 flex items-center gap-1.5">
          <PackageSearch size={15} className="text-rose-500" /> คิวโอกาสขาย — ถึงรอบสั่งซื้อ
        </h3>
        <p className="text-xs text-slate-400 mb-3">เรียงตามสินค้าที่เลยรอบมากที่สุด</p>
        {data.opportunityQueue.length === 0 ? (
          <div className="text-sm text-slate-300 py-4 text-center">ไม่มีรายการถึงรอบสั่งซื้อตอนนี้</div>
        ) : (
          <div className="space-y-1.5">
            {data.opportunityQueue.slice(0, 30).map((r) => (
              <button
                key={r.code}
                onClick={() => onOpen(r.code)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-rose-50 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 truncate">{r.name || r.code}</div>
                  <div className="text-xs text-slate-400 font-mono truncate">
                    {r.code} · {r.reorderDue.length} รายการถึงรอบ
                  </div>
                </div>
                <span className="text-xs font-semibold text-rose-600 shrink-0">เลยรอบ {r.mostOverdue} วัน</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function MoverList({ rows, onOpen }: { rows: DashboardResult['topMovers']['up']; onOpen: (code: string) => void }) {
  if (rows.length === 0) return <div className="text-sm text-slate-300 py-4 text-center">ไม่มีข้อมูล</div>;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <button
          key={r.code}
          onClick={() => onOpen(r.code)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-50 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800 truncate">{r.name || r.code}</div>
            <div className="text-xs text-slate-400 font-mono">{r.code}</div>
          </div>
          <span className={`text-sm font-bold shrink-0 ${trendColor(r.trendDir)}`}>
            {trendArrow(r.trendDir)} {Math.abs(r.trendPct).toFixed(0)}%
          </span>
        </button>
      ))}
    </div>
  );
}
