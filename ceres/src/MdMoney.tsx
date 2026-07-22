import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, PiggyBank, CheckCircle2, Trash2 } from 'lucide-react';
import {
  createMovement,
  listMovements,
  baht,
  CERES_PURGE_CONFIRM_PHRASE,
  describePurgeError,
  purgeCashMovement,
  type Movement,
} from './lib/api';
import { useCeres } from './lib/bootstrapContext';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
}

const TYPE_META: Record<string, { label: string; cls: string }> = {
  advance: { label: 'เบิก', cls: 'bg-sky-100 text-sky-700' },
  refund: { label: 'คืน', cls: 'bg-emerald-100 text-emerald-700' },
  deposit: { label: 'ฝาก', cls: 'bg-slate-200 text-slate-600' },
  // Historical rows only — 'topup' is no longer a postable movement type (merged into 'deposit'
  // 2026-07-20), but old rows still carry it and must keep rendering sensibly.
  topup: { label: 'เติมเงิน', cls: 'bg-purple-100 text-purple-700' },
};

export default function MdMoney() {
  const { bootstrap } = useCeres();
  const purgeEnabled = bootstrap.role === 'ceo' && bootstrap.alphaPurgeEnabled;
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const today = todayStr();
    listMovements({ from: today, to: today })
      .then((r) => setMovements(r.movements))
      .catch(() => setMovements([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const bump = () => setRefreshKey((k) => k + 1);

  // Alpha hard-purge (CEO only, owner directive 2026-07-22) — a bare deposit row only (never
  // created by a request money event, so it's always safely hard-deletable on its own; see
  // api/src/ceres/purge.ts's purgeCashMovement — the button is only ever shown on 'deposit'
  // rows in the first place, see the render below).
  async function onPurgeMovement(m: Movement) {
    const typed = window.prompt(`ลบถาวร — ${baht(Number(m.amount))}\nพิมพ์ "${CERES_PURGE_CONFIRM_PHRASE}" เพื่อยืนยัน (ลบแบบถาวร กู้คืนไม่ได้ ไม่มีประวัติ)`);
    if (typed == null) return;
    if (typed.trim() !== CERES_PURGE_CONFIRM_PHRASE) { window.alert('พิมพ์ข้อความยืนยันไม่ตรง — ลบไม่สำเร็จ'); return; }
    setBusyId(m.id);
    try {
      await purgeCashMovement(m.id);
      setMovements((rs) => rs.filter((x) => x.id !== m.id));
      load();
    } catch (err) {
      window.alert(describePurgeError(err));
    } finally {
      setBusyId('');
    }
  }

  return (
    <div>
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="w-full max-w-md lg:w-96 lg:flex-none">
          <h2 className="text-lg font-bold mb-3">ฝากเงิน</h2>
          <DepositForm onDone={bump} />
        </div>

        <div className="w-full lg:flex-1">
          <h2 className="text-lg font-bold mb-3">รายการวันนี้</h2>
          {loading ? (
            <div className="py-8 flex justify-center text-slate-400">
              <Loader2 className="animate-spin" size={20} />
            </div>
          ) : movements.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 flex items-center justify-center text-slate-400 text-sm py-8">
              ยังไม่มีรายการวันนี้
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
              {movements.map((m) => (
                <div key={m.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${TYPE_META[m.type]?.cls || 'bg-slate-100 text-slate-600'}`}>
                      {TYPE_META[m.type]?.label || m.type}
                    </span>
                    {m.partyName && <span className="text-slate-600">{m.partyName}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{baht(Number(m.amount))}</span>
                    <span className="text-xs text-slate-400">
                      {new Date(m.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {purgeEnabled && m.type === 'deposit' && (
                      <button
                        onClick={() => onPurgeMovement(m)}
                        disabled={busyId === m.id}
                        className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        title="ลบถาวร"
                      >
                        {busyId === m.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FormShell({
  icon,
  title,
  busy,
  error,
  success,
  onSubmit,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  busy: boolean;
  error: string;
  success: boolean;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-3 text-slate-700 font-semibold">
        {icon} {title}
      </div>
      <div className="space-y-2">{children}</div>
      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mt-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-1 text-emerald-600 text-xs mt-2">
          <CheckCircle2 size={12} /> บันทึกแล้ว
        </div>
      )}
      <button
        onClick={onSubmit}
        disabled={busy}
        className="w-full mt-3 min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : 'บันทึก'}
      </button>
    </div>
  );
}

function DepositForm({ onDone }: { onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function submit() {
    setError('');
    setSuccess(false);
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) return setError('กรอกจำนวนเงินให้ถูกต้อง');
    setBusy(true);
    try {
      await createMovement({ type: 'deposit', amount, note: note.trim() || undefined });
      setAmount('');
      setNote('');
      setSuccess(true);
      onDone();
    } catch {
      setError('บันทึกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormShell icon={<PiggyBank size={18} className="text-slate-600" />} title="ฝากเข้ากล่อง" busy={busy} error={error} success={success} onSubmit={submit}>
      <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="จำนวนเงิน" className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="หมายเหตุ (ถ้ามี)" className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]" />
    </FormShell>
  );
}
