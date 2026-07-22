import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, AlertTriangle, RefreshCw, Trash2, Ban } from 'lucide-react';
import {
  listExpenses,
  deleteExpense,
  voidExpense,
  getFlagCounts,
  listStaffRequests,
  baht,
  CERES_PURGE_CONFIRM_PHRASE,
  describePurgeError,
  purgeExpenseEntry,
  purgeStaffRequest,
  type Expense,
  type ExpenseStatus,
  type StaffRequest,
} from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import FlagButton, { FlagBadge } from './FlagButton';
import { MediaThumb } from './lib/media';
import { REQUEST_TYPE_LABEL } from './lib/requestLabels';
import { APPROVAL_LABEL, FULFILLMENT_LABEL } from './RequestDetail';

// ประวัติ merged history (2026-07-22 fix) — before this, ประวัติ rendered MdExpenses ALONE, so a
// finished v2 money request (CeresPaymentRequest: paid/settling/settled, or rejected/void) never
// showed up anywhere once it left the approval/fulfillment queues — a real approved-and-paid
// reimbursement effectively vanished from every screen. This view merges CeresExpense rows with
// FINISHED CeresPaymentRequest rows into one date-desc list. Still-in-flight requests
// (pending_nee/pending_ceo/approved-unfulfilled/etc) are deliberately excluded — those live in
// อนุมัติ/เบิกล่วงหน้า, not here.
//
// Backend: no new endpoint. Reuses listExpenses(scope:'all') exactly as MdExpenses.tsx always
// has, plus listStaffRequests('all', ...) — already gm/ceo-gated the same way (see
// requestService.ts's listStaffRequests: scope 'all' throws 'forbidden' for any role but
// gm/ceo), so this merge needed zero backend changes and touches no money-mutation code.
//
// FINISHED filter (exact logic): a request row appears here iff
//   fulfillmentStatus is one of paid/settling/settled, OR approvalStatus is rejected or void.
// (approvalStatus 'void' is checked independently of fulfillmentStatus — CEO's any-state void
// can land on a request whose fulfillment was unfulfilled/paid/reversed/settled; all of those
// still show up here as a voided row per this OR.)
// 'reversed' is included even though it's transient (CEO reversed the money event but hasn't
// voided the request yet): no queue shows that state — toFulfill needs 'unfulfilled', advance
// liquidation needs paid/settling — so without it here the request would be invisible everywhere
// until the void lands, the exact bug class this view exists to close.
const FINISHED_FULFILLMENT = new Set(['paid', 'settling', 'settled', 'reversed']);
function isFinishedRequest(r: StaffRequest): boolean {
  return r.approvalStatus === 'rejected' || r.approvalStatus === 'void' || FINISHED_FULFILLMENT.has(r.fulfillmentStatus);
}

// Merged status filter reuses ExpenseStatus's 5 values verbatim (both domains happen to share
// this exact vocabulary) — request rows map onto it as: paid/settling → "approved" (money is
// out, not yet closed), settled → "settled", rejected/void map onto themselves. A request never
// matches "pending" here since isFinishedRequest() already excludes every in-flight state.
function requestMatchesStatusFilter(r: StaffRequest, status: ExpenseStatus | ''): boolean {
  if (!status) return true;
  switch (status) {
    case 'pending':
      return false;
    case 'approved':
      // 'reversed' rides this bucket too — money moved, request not yet voided; the row's own
      // chip still reads ย้อนกลับแล้ว so the state stays visible.
      return r.fulfillmentStatus === 'paid' || r.fulfillmentStatus === 'settling' || r.fulfillmentStatus === 'reversed';
    case 'settled':
      return r.fulfillmentStatus === 'settled';
    case 'rejected':
      return r.approvalStatus === 'rejected';
    case 'void':
      return r.approvalStatus === 'void';
    default:
      return true;
  }
}

// Same wording MdExpenses.tsx uses, except "approved" is relabeled to make clear it now also
// covers paid/settling requests (task spec: "อนุมัติแล้ว/จ่ายแล้ว").
const STATUS_META: Record<ExpenseStatus, { label: string; cls: string }> = {
  pending: { label: 'รอตรวจ', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: 'อนุมัติแล้ว/จ่ายแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  settled: { label: 'ปิดยอดแล้ว', cls: 'bg-slate-200 text-slate-500' },
  rejected: { label: 'ตีกลับ', cls: 'bg-rose-100 text-rose-700' },
  void: { label: 'ยกเลิกแล้ว', cls: 'bg-slate-100 text-slate-400' },
};

// A request row's OWN status chip is more specific than the filter bucket above (จ่ายแล้ว vs
// กำลังปิดยอด vs ปิดยอดแล้ว read distinctly) — sourced straight from RequestDetail's exported
// maps so the wording can never drift from the request's own detail/timeline view.
function requestStatusChip(r: StaffRequest): { label: string; cls: string } {
  if (r.approvalStatus === 'rejected' || r.approvalStatus === 'void') return APPROVAL_LABEL[r.approvalStatus];
  return FULFILLMENT_LABEL[r.fulfillmentStatus] ?? APPROVAL_LABEL[r.approvalStatus];
}

// Bangkok-local calendar day ("YYYY-MM-DD") from an ISO instant — same UTC+7 math the backend's
// thaiDayRange/thaiDayKey use (routes/ceres/common.ts), kept independent here since this is a
// pure client-side filter (requests carry no server-side date query param to reuse).
const TH_OFFSET_MS = 7 * 3600 * 1000;
function thaiDateKey(iso: string): string {
  return new Date(new Date(iso).getTime() + TH_OFFSET_MS).toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

function LaneChip({ kind }: { kind: 'expense' | 'request' }) {
  return kind === 'request' ? (
    <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[10px] font-semibold shrink-0">คำขอ</span>
  ) : (
    <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold shrink-0">ค่าใช้จ่าย</span>
  );
}

// Sortable merge keeps the two record types intact (own render component per kind) rather than
// flattening into one loose shape — same "compose existing pieces" spirit as the desktop
// composed views in Md.tsx. `date` is the field this whole view sorts/filters by: expenses use
// spentAt (transaction date, already precise); finished requests use updatedAt — the terminal
// state (paid/settling/settled/rejected/void) is exactly what bumped it last, so it doubles as
// "when this became history-worthy" without an extra per-row fetch of money events.
// Advance-liquidation nesting (2026-07-22 follow-up, same day as the merge above): a
// liquidation expense (CeresExpense.advanceRequestId set) renders UNDER the advance request
// it closes rather than as an independent top-level row. 'request' items therefore carry
// their nested liquidation children (already-fetched/filtered Expense rows); 'expense' items
// carry whether they're a liquidation whose parent ISN'T being shown here (fallback chip —
// see the `rows` useMemo below for exactly when that happens).
type MergedItem =
  | { kind: 'expense'; date: string; key: string; data: Expense; fromAdvance: boolean }
  | { kind: 'request'; date: string; key: string; data: StaffRequest; liquidations: Expense[] };

// Shared confirmation UX for every ลบถาวร button — window.prompt asking the user
// to type the exact Thai confirm phrase; wrong/cancelled input aborts without calling the
// server at all (the typed value IS the request's confirm body field, so a mistyped phrase
// simply 400s if it somehow slips through — but we abort client-side first to save the
// round-trip and give an immediate "you typed it wrong" signal).
function promptPurgeConfirm(label: string): string | null {
  const typed = window.prompt(
    `ลบถาวร — ${label}\nพิมพ์ "${CERES_PURGE_CONFIRM_PHRASE}" เพื่อยืนยัน (ลบแบบถาวร กู้คืนไม่ได้ ไม่มีประวัติ)`,
  );
  if (typed == null) return null;
  return typed.trim() === CERES_PURGE_CONFIRM_PHRASE ? typed.trim() : '';
}

export default function MdHistory() {
  const { bootstrap } = useCeres();
  const isCeo = bootstrap.role === 'ceo';
  const purgeEnabled = isCeo && bootstrap.alphaPurgeEnabled;
  const [status, setStatus] = useState<ExpenseStatus | ''>('');
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [requests, setRequests] = useState<StaffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [flagCounts, setFlagCounts] = useState<Record<string, number>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      listExpenses({
        scope: 'all',
        status: status || undefined,
        partyId: partyId || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
      // Unfiltered fetch (max page size) — listStaffRequests has no status/party/date query
      // params, so the status/person/date filters below apply to requests entirely client-side.
      listStaffRequests('all', 500),
    ])
      .then(([expRes, reqRes]) => {
        setExpenses(expRes.expenses);
        const finished = reqRes.requests.filter(isFinishedRequest);
        setRequests(finished);
        Promise.all([
          getFlagCounts('expense', expRes.expenses.map((e) => e.id)),
          getFlagCounts('request', finished.map((r) => r.id)),
        ])
          .then(([expCounts, reqCounts]) => {
            const merged: Record<string, number> = {};
            for (const [id, n] of Object.entries(expCounts)) merged[`expense:${id}`] = n;
            for (const [id, n] of Object.entries(reqCounts)) merged[`request:${id}`] = n;
            setFlagCounts(merged);
          })
          .catch(() => {});
      })
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [status, partyId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // Hard-delete a still-pending draft (nothing has counted it yet).
  async function onDelete(r: Expense) {
    if (!window.confirm(`ลบรายการนี้? (${r.partyName} · ${baht(r.amountNum)})\nลบได้เฉพาะรายการที่ยังรอตรวจ`)) return;
    setBusyId(r.id);
    try {
      await deleteExpense(r.id);
      setExpenses((rs) => rs.filter((x) => x.id !== r.id));
    } catch {
      window.alert('ลบไม่สำเร็จ');
    } finally {
      setBusyId('');
    }
  }

  // Void an already-approved/settled/rejected entry: it's kept but excluded from every
  // total/board/settlement and shown struck-through with the reason.
  async function onVoid(r: Expense) {
    const reason = window.prompt(`ยกเลิกรายการนี้? (${r.partyName} · ${baht(r.amountNum)})\nกรอกเหตุผล — รายการจะถูกตีเส้นทับและไม่นับในยอดใดๆ`);
    if (reason == null) return;
    const trimmed = reason.trim();
    if (!trimmed) { window.alert('ต้องกรอกเหตุผล'); return; }
    setBusyId(r.id);
    try {
      const res = await voidExpense(r.id, trimmed);
      setExpenses((rs) => rs.map((x) => (x.id === r.id ? res.expense : x)));
    } catch {
      window.alert('ยกเลิกไม่สำเร็จ');
    } finally {
      setBusyId('');
    }
  }

  // Alpha hard-purge (CEO only): removes the row and its whole graph — no soft-delete, no
  // audit trail. Any status (pending/approved/settled/rejected/void).
  async function onPurgeExpense(r: Expense) {
    const confirmed = promptPurgeConfirm(`${r.partyName} · ${baht(r.amountNum)}`);
    if (confirmed == null) return;
    if (!confirmed) { window.alert('พิมพ์ข้อความยืนยันไม่ตรง — ลบไม่สำเร็จ'); return; }
    setBusyId(r.id);
    try {
      await purgeExpenseEntry(r.id);
      setExpenses((rs) => rs.filter((x) => x.id !== r.id));
      load();
    } catch (err) {
      window.alert(describePurgeError(err));
    } finally {
      setBusyId('');
    }
  }

  async function onPurgeRequest(r: StaffRequest) {
    const confirmed = promptPurgeConfirm(`${r.requestedByName} · ${baht(r.amountNum)}`);
    if (confirmed == null) return;
    if (!confirmed) { window.alert('พิมพ์ข้อความยืนยันไม่ตรง — ลบไม่สำเร็จ'); return; }
    setBusyId(r.id);
    try {
      await purgeStaffRequest(r.id);
      setRequests((rs) => rs.filter((x) => x.id !== r.id));
      load();
    } catch (err) {
      window.alert(describePurgeError(err));
    } finally {
      setBusyId('');
    }
  }

  const rows: MergedItem[] = useMemo(() => {
    const filteredRequests = requests.filter((r) => {
      if (!requestMatchesStatusFilter(r, status)) return false;
      if (partyId && r.requesterPartyId !== partyId) return false;
      const day = thaiDateKey(r.updatedAt);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });

    // `requests` (NOT filteredRequests) is the lookup universe for "does this liquidation's
    // parent advance exist in this view at all" — it's every FINISHED request this agent can
    // see (isFinishedRequest already applied in load()), unfiltered by the status/person/date
    // controls. A parent misses this map only when it's still in-flight (not finished yet) or
    // beyond the 500-row request fetch cap — exactly the two "fallback" cases in the spec.
    const finishedById = new Map(requests.map((r) => [r.id, r]));

    // Group already-fetched expenses (server-side filtered by the same status/party/date
    // controls as everything else in this view) by the advance they liquidate.
    const childrenByAdvance = new Map<string, Expense[]>();
    for (const e of expenses) {
      if (!e.advanceRequestId) continue;
      const list = childrenByAdvance.get(e.advanceRequestId) ?? [];
      list.push(e);
      childrenByAdvance.set(e.advanceRequestId, list);
    }
    for (const list of childrenByAdvance.values()) {
      list.sort((a, b) => (a.spentAt < b.spentAt ? 1 : a.spentAt > b.spentAt ? -1 : 0));
    }

    // A parent advance shows here if it passes the normal request filters OR it has at least
    // one liquidation in the (already current-filtered) expenses set — the latter is what
    // makes filtering by the CHILD's person/date still surface the pair, per owner spec,
    // even when the parent's own fields wouldn't independently pass that same filter.
    const shownRequestIds = new Set(filteredRequests.map((r) => r.id));
    for (const advanceId of childrenByAdvance.keys()) {
      if (finishedById.has(advanceId)) shownRequestIds.add(advanceId);
    }

    const requestItems: MergedItem[] = [...shownRequestIds].map((id) => {
      const r = finishedById.get(id)!;
      return { kind: 'request', date: r.updatedAt, key: `request:${r.id}`, data: r, liquidations: childrenByAdvance.get(r.id) ?? [] };
    });

    // Top-level expenses: everything EXCEPT a liquidation whose parent is being rendered
    // above (it nests there instead, see RequestHistoryCard). A liquidation whose parent
    // ISN'T shown (filtered out, still in-flight, or beyond the fetch cap) stays top-level
    // exactly as before — nothing may become invisible — flagged with a small chip so it's
    // still clear it belongs to an advance.
    const expenseItems: MergedItem[] = expenses
      .filter((e) => !e.advanceRequestId || !shownRequestIds.has(e.advanceRequestId))
      .map((e): MergedItem => ({ kind: 'expense', date: e.spentAt, key: `expense:${e.id}`, data: e, fromAdvance: !!e.advanceRequestId }));

    const items: MergedItem[] = [...expenseItems, ...requestItems];
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return items;
  }, [expenses, requests, status, partyId, from, to]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">ประวัติ</h2>
        <button onClick={load} className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus | '')} className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white">
          <option value="">ทุกสถานะ</option>
          <option value="pending">รอตรวจ</option>
          <option value="approved">อนุมัติแล้ว/จ่ายแล้ว</option>
          <option value="settled">ปิดยอดแล้ว</option>
          <option value="rejected">ตีกลับ/ปฏิเสธ</option>
          <option value="void">ยกเลิกแล้ว</option>
        </select>
        <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white">
          <option value="">ทุกคน</option>
          {bootstrap.parties.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ตั้งแต่วันที่" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ถึงวันที่" />
      </div>

      {error ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {error}
        </div>
      ) : loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10">ไม่มีรายการ</div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) =>
            row.kind === 'expense' ? (
              <ExpenseHistoryCard
                key={row.key}
                e={row.data}
                busy={busyId === row.data.id}
                flagCount={flagCounts[row.key]}
                isCeo={isCeo}
                purgeEnabled={purgeEnabled}
                onFlagged={load}
                onDelete={onDelete}
                onVoid={onVoid}
                onPurge={onPurgeExpense}
                fromAdvance={row.fromAdvance}
              />
            ) : (
              <RequestHistoryCard
                key={row.key}
                request={row.data}
                busy={busyId === row.data.id}
                flagCount={flagCounts[row.key]}
                purgeEnabled={purgeEnabled}
                onFlagged={load}
                onPurge={onPurgeRequest}
                liquidations={row.liquidations}
                busyId={busyId}
                flagCounts={flagCounts}
                isCeo={isCeo}
                onDeleteExpense={onDelete}
                onVoidExpense={onVoid}
                onPurgeExpense={onPurgeExpense}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ExpenseHistoryCard({
  e: r,
  busy,
  flagCount,
  isCeo,
  purgeEnabled,
  onFlagged,
  onDelete,
  onVoid,
  onPurge,
  // `compact` = rendered nested under a parent RequestHistoryCard ("รายการปิดยอด"): tighter
  // wrapper, smaller thumbnail, no own LaneChip (the section heading + parent card already
  // say "this is an expense under an advance") — same markup/actions otherwise, just sized
  // down, so this stays ONE component instead of a forked nested copy.
  // `fromAdvance` = top-level rendering (compact=false) of a liquidation whose parent advance
  // isn't shown in this view right now (filtered out / still in-flight / beyond fetch cap) —
  // renders the "จากเบิกล่วงหน้า" fallback chip so the link to its advance stays visible.
  compact,
  fromAdvance,
}: {
  e: Expense;
  busy: boolean;
  flagCount?: number;
  isCeo: boolean;
  purgeEnabled: boolean;
  onFlagged: () => void;
  onDelete: (r: Expense) => void;
  onVoid: (r: Expense) => void;
  onPurge: (r: Expense) => void;
  compact?: boolean;
  fromAdvance?: boolean;
}) {
  const voided = r.status === 'void';
  return (
    <div className={compact
      ? `rounded-lg border border-slate-100 bg-slate-50/70 p-2 ${voided ? 'opacity-60' : ''}`
      : `bg-white rounded-xl border border-slate-200 p-3 ${voided ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2 text-[11px] text-slate-400 mb-1.5">
        {!compact && <LaneChip kind="expense" />}
        <span>{fmtDate(r.spentAt)}</span>
        {fromAdvance && !compact && (
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold shrink-0">จากเบิกล่วงหน้า</span>
        )}
      </div>
      <div className="flex items-start gap-3">
        {r.receiptUrl && (
          <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="shrink-0">
            <img src={r.receiptUrl} alt="ใบเสร็จ" className={compact ? 'w-10 h-10 object-cover rounded-lg border border-slate-200' : 'w-14 h-14 object-cover rounded-lg border border-slate-200'} />
          </a>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`font-semibold text-sm flex items-center gap-1.5 ${voided ? 'line-through' : ''}`}>
              {r.partyName} <FlagBadge count={flagCount} />
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${STATUS_META[r.status].cls}`}>
              {STATUS_META[r.status].label}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className={`text-sm text-slate-500 ${voided ? 'line-through' : ''}`}>{r.category}</span>
            <span className={`font-bold ${voided ? 'line-through text-slate-400' : ''}`}>{baht(r.amountNum)}</span>
          </div>
          {r.customerNote && <div className="text-xs text-slate-400">ลูกค้า: {r.customerNote}</div>}
          {r.duplicateReceipt && (
            <div className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 text-[11px] font-medium">
              <AlertTriangle size={10} /> ใบเสร็จซ้ำ
            </div>
          )}
          {r.status === 'rejected' && r.rejectReason && (
            <div className="text-xs text-rose-600 mt-1">เหตุผล: {r.rejectReason}</div>
          )}
          {voided && r.voidReason && (
            <div className="text-xs text-slate-500 mt-1">ยกเลิกเพราะ: {r.voidReason}</div>
          )}

          {/* ติดธง — anyone; Delete (pending drafts) stays gm/ceo; ยกเลิก (void) is CEO-ONLY —
              unchanged from MdExpenses.tsx's own convention (owner directive 2026-07-21).
              ลบถาวร — CEO-only alpha hard-purge, ANY status incl. already-voided
              (owner directive, 2026-07-22), only rendered when the alpha flag is on. */}
          <div className="flex justify-end items-center gap-3 mt-2">
            {!voided && <FlagButton targetType="expense" targetId={r.id} onFlagged={onFlagged} />}
            {!voided && (r.status === 'pending' ? (
              <button
                onClick={() => onDelete(r)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} ลบ
              </button>
            ) : isCeo ? (
              <button
                onClick={() => onVoid(r)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />} ยกเลิก
              </button>
            ) : null)}
            {purgeEnabled && (
              <button
                onClick={() => onPurge(r)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} ลบถาวร
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Finished v2 request row — READ-ONLY besides ติดธง (owner spec: history is display + flag
// only; any actual mutation on a request — void, refund, etc — stays in RequestDetail/the
// approval+fulfillment queues where it already lives, not duplicated here). ลบถาวร
// is the one exception — CEO-only alpha hard-purge, ANY status (owner directive, 2026-07-22).
function RequestHistoryCard({
  request: r,
  busy,
  flagCount,
  purgeEnabled,
  onFlagged,
  onPurge,
  // Liquidation expenses nested under this advance (2026-07-22 follow-up) — passed down from
  // MdHistory's `rows` grouping rather than recomputed here. The handful of extra props below
  // (busyId/flagCounts/isCeo + the three expense action callbacks) are exactly what
  // ExpenseHistoryCard needs; threading them through here lets the nested rows reuse that
  // component (same actions: flag, delete/void/purge per role) instead of duplicating markup.
  liquidations,
  busyId,
  flagCounts,
  isCeo,
  onDeleteExpense,
  onVoidExpense,
  onPurgeExpense,
}: {
  request: StaffRequest;
  busy: boolean;
  flagCount?: number;
  purgeEnabled: boolean;
  onFlagged: () => void;
  onPurge: (r: StaffRequest) => void;
  liquidations?: Expense[];
  busyId: string;
  flagCounts: Record<string, number>;
  isCeo: boolean;
  onDeleteExpense: (r: Expense) => void;
  onVoidExpense: (r: Expense) => void;
  onPurgeExpense: (r: Expense) => void;
}) {
  const voided = r.approvalStatus === 'void';
  const chip = requestStatusChip(r);
  const rejectReason = r.approvalStatus === 'rejected' ? (r.ceoDecision?.note || r.neeDecision?.note || '') : '';
  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-3 ${voided ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 text-[11px] text-slate-400 mb-1.5">
        <LaneChip kind="request" />
        <span>{fmtDate(r.updatedAt)}</span>
      </div>
      <div className="flex items-start gap-3">
        <MediaThumb id={r.requestPhotoUploadId} size={56} alt="หลักฐานคำขอ" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`font-semibold text-sm flex items-center gap-1.5 ${voided ? 'line-through' : ''}`}>
              {r.requestedByName} <FlagBadge count={flagCount} />
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${chip.cls}`}>{chip.label}</span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className={`text-sm text-slate-500 ${voided ? 'line-through' : ''}`}>{REQUEST_TYPE_LABEL[r.requestType]}</span>
            <span className={`font-bold ${voided ? 'line-through text-slate-400' : ''}`}>{baht(r.amountNum)}</span>
          </div>
          {r.category && <div className="text-xs text-slate-400">{r.category}</div>}
          {rejectReason && <div className="text-xs text-rose-600 mt-1">เหตุผล: {rejectReason}</div>}
          {voided && r.voidReason && (
            <div className="text-xs text-slate-500 mt-1">ยกเลิกเพราะ: {r.voidReason}</div>
          )}

          <div className="flex justify-end items-center gap-3 mt-2">
            <FlagButton targetType="request" targetId={r.id} onFlagged={onFlagged} />
            {purgeEnabled && (
              <button
                onClick={() => onPurge(r)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} ลบถาวร
              </button>
            )}
          </div>
        </div>
      </div>

      {/* รายการปิดยอด — liquidation expenses for this advance (advanceRequestId points here).
          Compact/nested ExpenseHistoryCard, indented, date-desc within the group. Rendered
          only when non-empty so a plain finished request with no liquidations yet looks
          exactly as it did before this feature. */}
      {liquidations && liquidations.length > 0 && (
        <div className="mt-3 pt-2 border-t border-slate-100">
          <div className="text-[11px] font-semibold text-slate-400 mb-1.5">รายการปิดยอด</div>
          <div className="pl-3 border-l-2 border-slate-100 space-y-1.5">
            {liquidations.map((le) => (
              <ExpenseHistoryCard
                key={`expense:${le.id}`}
                e={le}
                compact
                busy={busyId === le.id}
                flagCount={flagCounts[`expense:${le.id}`]}
                isCeo={isCeo}
                purgeEnabled={purgeEnabled}
                onFlagged={onFlagged}
                onDelete={onDeleteExpense}
                onVoid={onVoidExpense}
                onPurge={onPurgeExpense}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
