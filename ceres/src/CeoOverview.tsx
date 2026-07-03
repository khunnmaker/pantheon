import { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  ThumbsUp,
  X,
  AlertCircle,
  Flag,
  ShieldAlert,
  Download,
  ExternalLink,
} from 'lucide-react';
import {
  getCeoOverview,
  decideRequest,
  createMovement,
  downloadExpensesCsv,
  downloadMovementsCsv,
  downloadRequestsCsv,
  downloadReviewsCsv,
  downloadStatementLinesCsv,
  baht,
  type CeoOverview as CeoOverviewData,
} from './lib/api';
import { todayStr } from './MdRequests';

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}

const REQUEST_STATUS_LABEL: Record<string, string> = {
  requested: 'รอ AI',
  ai_approved: 'AI อนุมัติ',
  escalated: 'รอ CEO',
  ceo_approved: 'CEO อนุมัติ',
  rejected: 'ปฏิเสธ',
  cancelled: 'ยกเลิก',
  paid: 'จ่ายแล้ว',
};

export default function CeoOverview({ onGoExpenses }: { onGoExpenses?: () => void }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<CeoOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getCeoOverview(date)
      .then(setData)
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [date]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-lg font-bold">CEO</h2>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
      </div>

      {error ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {error}
        </div>
      ) : loading || !data ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : (
        <div className="space-y-4">
          <EscalationsSection escalations={data.escalations} onDecided={bump} />
          <CashSection cash={data.cash} onTopupDone={bump} />
          <AiReviewsSection aiReviews={data.aiReviews} />
          <FlaggedExpensesSection flaggedExpenses={data.flaggedExpenses} onGoExpenses={onGoExpenses} />
          <MissedBillsSection missedBills={data.missedBills} />
          <SettlementSection settlementToday={data.settlementToday} />
          <RequestCountsSection requestCounts={data.requestCounts} />
          <WeeklyPackSection />
        </div>
      )}
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-semibold text-slate-500 mb-2">{title}</div>
      {children}
    </div>
  );
}

function EscalationsSection({ escalations, onDecided }: { escalations: CeoOverviewData['escalations']; onDecided: () => void }) {
  return (
    <SectionCard title="รออนุมัติ">
      {escalations.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">ไม่มีรายการรออนุมัติ</div>
      ) : (
        <div className="space-y-2">
          {escalations.map((r) => (
            <EscalationCard key={r.id} r={r} onDecided={onDecided} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function EscalationCard({ r, onDecided }: { r: CeoOverviewData['escalations'][number]; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  async function decide(decision: 'approve' | 'reject') {
    if (decision === 'reject' && !note.trim()) return setError('กรอกเหตุผลที่ปฏิเสธ');
    setBusy(true);
    setError('');
    try {
      await decideRequest(r.id, decision, note.trim() || undefined);
      onDecided();
    } catch {
      setError('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-amber-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sm">{r.payee}</span>
        <span className="font-bold">{baht(r.amountNum)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1">
        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{r.entity}</span>
        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{r.category}</span>
        <span className="text-xs text-slate-400">โดย {r.requestedByName}</span>
      </div>
      {r.detail && <div className="text-xs text-slate-500 mt-1">{r.detail}</div>}
      {r.aiReview && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">{r.aiReview.reasoning}</div>
      )}

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mt-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {rejecting ? (
        <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="เหตุผลที่ปฏิเสธ (จำเป็น)"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={() => decide('reject')}
              disabled={busy}
              className="flex-1 min-h-[40px] rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} ยืนยันปฏิเสธ
            </button>
            <button onClick={() => setRejecting(false)} disabled={busy} className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              กลับ
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 mt-2 pt-2 border-t border-slate-100">
          <button
            onClick={() => decide('approve')}
            disabled={busy}
            className="flex-1 min-h-[40px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ThumbsUp size={14} />} อนุมัติ
          </button>
          <button
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="flex-1 min-h-[40px] rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
          >
            <X size={14} /> ปฏิเสธ
          </button>
        </div>
      )}
    </div>
  );
}

function CashSection({ cash, onTopupDone }: { cash: CeoOverviewData['cash']; onTopupDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [amount, setAmount] = useState(String(cash.box.suggestedTopup));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setAmount(String(cash.box.suggestedTopup));
  }, [cash.box.suggestedTopup]);

  async function submit() {
    setError('');
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return setError('กรอกจำนวนเงินให้ถูกต้อง');
    setBusy(true);
    try {
      await createMovement({ type: 'topup', amount, note: 'เติมตามคำแนะนำ' });
      setConfirming(false);
      onTopupDone();
    } catch {
      setError('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="เงินสด">
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-400">ยอดเงินกล่อง</div>
            <div className="text-xl font-bold text-amber-700">{baht(cash.box.balance)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">เงินค้างกับพนักงาน</div>
            <div className="text-xl font-bold">{baht(cash.outstandingTotal)}</div>
          </div>
        </div>

        {cash.box.belowFloor && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            <div className="flex items-start gap-2 mb-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>
                ต่ำกว่าเกณฑ์ {baht(cash.box.floor)} — แนะนำเติม {baht(cash.box.suggestedTopup)}
              </span>
            </div>

            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mb-2">
                <AlertTriangle size={12} /> {error}
              </div>
            )}

            {confirming ? (
              <div className="space-y-2">
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-amber-300 text-sm bg-white"
                />
                <div className="flex gap-2">
                  <button
                    onClick={submit}
                    disabled={busy}
                    className="flex-1 min-h-[40px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : `ยืนยันเติม ${baht(Number(amount) || 0)}`}
                  </button>
                  <button onClick={() => setConfirming(false)} disabled={busy} className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-white">
                    ยกเลิก
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="w-full min-h-[40px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold"
              >
                บันทึกเติมเงิน {baht(cash.box.suggestedTopup)}
              </button>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

const VERDICT_META: Record<string, { label: string; cls: string }> = {
  approve: { label: 'อนุมัติ', cls: 'bg-emerald-100 text-emerald-700' },
  ok: { label: 'ปกติ', cls: 'bg-emerald-100 text-emerald-700' },
  escalate: { label: 'ส่งต่อ CEO', cls: 'bg-amber-100 text-amber-700' },
  flagged: { label: 'ติดธง', cls: 'bg-amber-100 text-amber-700' },
  reject: { label: 'ปฏิเสธ', cls: 'bg-rose-100 text-rose-700' },
};

function AiReviewsSection({ aiReviews }: { aiReviews: CeoOverviewData['aiReviews'] }) {
  return (
    <SectionCard title="AI ตัดสินวันนี้">
      {aiReviews.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">ยังไม่มี</div>
      ) : (
        <div className="space-y-2">
          {aiReviews.map((a) => {
            const meta = VERDICT_META[a.verdict] ?? { label: a.verdict, cls: 'bg-slate-100 text-slate-600' };
            return (
              <div key={a.id} className="bg-white rounded-xl border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold truncate">{a.subject?.payee || a.subject?.partyName || a.subjectType}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${meta.cls}`}>{meta.label}</span>
                </div>
                {a.subject && (
                  <div className="text-xs text-slate-400 mt-0.5">
                    {baht(Number(a.subject.amount))}
                    {a.subject.category ? ` · ${a.subject.category}` : ''}
                  </div>
                )}
                <div className="text-xs text-slate-600 mt-1">{a.reasoning}</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {a.model} · {a.policyVersion}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function FlaggedExpensesSection({ flaggedExpenses, onGoExpenses }: { flaggedExpenses: CeoOverviewData['flaggedExpenses']; onGoExpenses?: () => void }) {
  return (
    <SectionCard title="รายการติดธง">
      {flaggedExpenses.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">ไม่มีรายการติดธง</div>
      ) : (
        <div className="space-y-2">
          {flaggedExpenses.map((e) => (
            <div key={e.id} className="bg-white rounded-xl border border-amber-200 p-3 flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Flag size={13} className="text-amber-600 shrink-0" />
                  <span className="font-semibold truncate">{e.partyName}</span>
                </div>
                <div className="text-xs text-slate-400">
                  {e.category} · {baht(e.amountNum)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {e.receiptUrl && (
                  <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-600">
                    <ExternalLink size={15} />
                  </a>
                )}
                {onGoExpenses && (
                  <button onClick={onGoExpenses} className="text-xs text-amber-700 underline underline-offset-2">
                    ดูรายการ
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function MissedBillsSection({ missedBills }: { missedBills: CeoOverviewData['missedBills'] }) {
  return (
    <SectionCard title="บิลที่เลยกำหนด">
      {missedBills.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">ไม่มีบิลค้าง</div>
      ) : (
        <div className="space-y-2">
          {missedBills.map((d) => (
            <div key={d.template.id} className="bg-white rounded-xl border border-rose-200 p-3 flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-1.5">
                <ShieldAlert size={14} className="text-rose-600" />
                <span className="font-semibold">{d.template.payee}</span>
              </div>
              <span className="text-xs text-slate-500">ครบกำหนด {d.dueDate}</span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function SettlementSection({ settlementToday }: { settlementToday: CeoOverviewData['settlementToday'] }) {
  return (
    <SectionCard title="ปิดยอดวันนี้">
      {!settlementToday ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">ยังไม่ปิดยอด</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">ปิดโดย {settlementToday.closedByName}</span>
            <span className="font-bold">{baht(Number(settlementToday.boxAfter))}</span>
          </div>
          {settlementToday.note && <div className="text-xs text-slate-400 mt-1">{settlementToday.note}</div>}
        </div>
      )}
    </SectionCard>
  );
}

function RequestCountsSection({ requestCounts }: { requestCounts: CeoOverviewData['requestCounts'] }) {
  const entries = Object.entries(requestCounts).filter(([, n]) => n > 0);
  return (
    <SectionCard title="สรุปคำขอจ่ายเงิน">
      {entries.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">ไม่มีคำขอ</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map(([status, count]) => (
            <span key={status} className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-medium">
              {REQUEST_STATUS_LABEL[status] ?? status}: {count}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

const CSV_BUTTONS: { key: string; label: string; fn: (from: string, to: string) => Promise<void> }[] = [
  { key: 'expenses', label: 'ค่าใช้จ่าย', fn: downloadExpensesCsv },
  { key: 'movements', label: 'เงินเข้า-ออก', fn: downloadMovementsCsv },
  { key: 'requests', label: 'คำขอจ่ายเงิน', fn: downloadRequestsCsv },
  { key: 'reviews', label: 'การตัดสินของ AI', fn: downloadReviewsCsv },
  { key: 'statement-lines', label: 'รายการสเตทเมนท์', fn: downloadStatementLinesCsv },
];

function WeeklyPackSection() {
  const [from, setFrom] = useState(daysAgoStr(6));
  const [to, setTo] = useState(todayStr());
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');

  async function download(key: string, fn: (from: string, to: string) => Promise<void>) {
    setBusyKey(key);
    setError('');
    try {
      await fn(from, to);
    } catch {
      setError('ดาวน์โหลดไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusyKey('');
    }
  }

  return (
    <SectionCard title="ชุดตรวจสอบรายสัปดาห์">
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
          <span className="text-slate-400 text-sm">ถึง</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
        </div>

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs mb-2">
            <AlertTriangle size={12} /> {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {CSV_BUTTONS.map((b) => (
            <button
              key={b.key}
              onClick={() => download(b.key, b.fn)}
              disabled={busyKey === b.key}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {busyKey === b.key ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} {b.label}
            </button>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
