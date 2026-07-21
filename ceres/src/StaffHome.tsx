import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Crown,
  Home,
  ListChecks,
  Loader2,
  LogOut,
  Plus,
  Search,
  Send,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useHashTab } from '@pantheon/ui';
import {
  baht,
  getLineBind,
  getRequestLiquidation,
  listStaffRequests,
  logout as logoutSuite,
  type AdvanceLiquidation,
  type StaffRequest,
} from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import { MediaThumb } from './lib/media';
import AppSwitcher from './AppSwitcher';
import MyRequests, { statusMeta, TYPE_LABEL } from './MyRequests';
import RequestSheet from './RequestSheet';
import RequestDetail from './RequestDetail';
import ExpenseSheet from './ExpenseSheet';
import Settings from './Settings';

// Phase 4 — the staff front door. See docs/CERES_REVAMP_PLAN.md "Phase 4" — Staff
// frontend screens + acceptance criteria.
//
// 2026-07-19 (docs/CERES_STAFF_HOME_PLAN.md): หน้าแรก no longer mirrors คำขอของฉัน —
// it surfaces open-advance liquidation cards + a compact "รอดำเนินการ" list instead, and
// the bottom nav drops from 4 tabs to 3 (เพิ่มเติม removed; the v1 legacy self-entry was
// retired entirely 2026-07-19 — owner: everyone moves to v2 requests; and its one item, the v1 legacy
// self-entry flow, relocates to a low-key card at the bottom of คำขอของฉัน).

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? 'https://pantheon.prominentdental.com';

type View = 'home' | 'mine' | 'settings';

// Approval states that always show on หน้าแรก's "รอดำเนินการ" list, regardless of age.
const PENDING_APPROVAL_STATUSES: StaffRequest['approvalStatus'][] = ['legacy', 'pending_nee', 'pending_ceo'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Advances holding un-settled money — "จ่ายแล้ว" or "กำลังปิดยอด" — get an
// open-advance card on หน้าแรก (see plan "1.A").
const OPEN_ADVANCE_FULFILLMENT: StaffRequest['fulfillmentStatus'][] = ['paid', 'settling'];

export default function StaffHome({
  embeddedView,
  openRequestOnMount = false,
  onOpenMine,
  onOpenSettings,
}: {
  embeddedView?: 'home' | 'mine';
  openRequestOnMount?: boolean;
  onOpenMine?: () => void;
  onOpenSettings?: () => void;
} = {}) {
  const { bootstrap, agent, onLogout } = useCeres();
  const viewKeys: View[] = ['home', 'mine', 'settings'];
  const [view, setView] = useHashTab<View>(viewKeys, 'home');
  const activeView = embeddedView ?? view;

  const [requestSheetOpen, setRequestSheetOpen] = useState(openRequestOnMount);
  const [editingRequest, setEditingRequest] = useState<StaffRequest | null>(null);
  const [requestReloadKey, setRequestReloadKey] = useState(0);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');
  const [search, setSearch] = useState('');

  // ── หน้าแรก data (2026-07-19 redesign) ────────────────────────────────────────────────
  const [homeRequests, setHomeRequests] = useState<StaffRequest[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeError, setHomeError] = useState('');
  const [lineUnbound, setLineUnbound] = useState(false);
  const [liquidations, setLiquidations] = useState<Record<string, AdvanceLiquidation | null>>({});
  const [liquidationsLoading, setLiquidationsLoading] = useState(false);
  const [expenseSheetFor, setExpenseSheetFor] = useState<StaffRequest | null>(null);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(''), 2500);
    return () => clearTimeout(t);
  }, [successMsg]);

  function openNewRequest() {
    setEditingRequest(null);
    setRequestSheetOpen(true);
  }
  function openEdit(request: StaffRequest) {
    setEditingRequest(request);
    setRequestSheetOpen(true);
  }
  function openDetail(request: StaffRequest) {
    setDetailRequestId(request.id);
  }
  function goToSettings() {
    if (onOpenSettings) onOpenSettings();
    else setView('settings');
  }

  useEffect(() => {
    if (activeView !== 'home') return;
    setHomeLoading(true);
    setHomeError('');
    listStaffRequests('mine', 100)
      .then((r) => setHomeRequests(r.requests))
      .catch(() => setHomeError('โหลดคำขอไม่สำเร็จ'))
      .finally(() => setHomeLoading(false));
  }, [activeView, requestReloadKey]);

  useEffect(() => {
    if (activeView !== 'home') return;
    getLineBind()
      .then((state) => setLineUnbound(!state.bound))
      .catch(() => {});
  }, [activeView]);

  const openAdvances = homeRequests.filter(
    (r) => r.requestType === 'advance' && OPEN_ADVANCE_FULFILLMENT.includes(r.fulfillmentStatus),
  );
  const pendingRows = homeRequests.filter((r) => {
    if (PENDING_APPROVAL_STATUSES.includes(r.approvalStatus)) return true;
    if (r.approvalStatus === 'rejected') {
      const at = r.ceoDecision?.at || r.neeDecision?.at || r.createdAt;
      return Date.now() - new Date(at).getTime() <= SEVEN_DAYS_MS;
    }
    return false;
  });
  const openAdvanceIds = openAdvances.map((r) => r.id).join(',');

  // Per-advance GET /requests/:id/liquidation — same call RequestDetail makes. Staff hold
  // at most a few open advances, so parallel fetches are fine (no backend change).
  useEffect(() => {
    if (activeView !== 'home' || !openAdvanceIds) {
      setLiquidations({});
      return;
    }
    let cancelled = false;
    setLiquidationsLoading(true);
    const ids = openAdvanceIds.split(',');
    Promise.all(
      ids.map((id) =>
        getRequestLiquidation(id)
          .then((r) => [id, r.liquidation] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      setLiquidations(Object.fromEntries(pairs));
      setLiquidationsLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // requestReloadKey forces a refresh of an already-open advance's numbers after
    // เพิ่มค่าใช้จ่ายเบิก saves, even when its id set (openAdvanceIds) doesn't change.
  }, [activeView, openAdvanceIds, requestReloadKey]);

  return (
    <div className={embeddedView ? '' : 'min-h-screen bg-slate-100 font-sans text-slate-800 pb-20'}>
      {!embeddedView && <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-700 min-w-0">
            <AppSwitcher agent={agent} />
            <span className="text-slate-400 text-sm truncate">· {bootstrap.party?.name || bootstrap.agent.name}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {PORTAL_URL && (
              <a href={PORTAL_URL} title="กลับพอร์ทัล Pantheon" className="flex items-center gap-1 text-sm text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <button
              onClick={() => {
                void logoutSuite();
                onLogout();
              }}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-rose-600"
            >
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
      </header>}

      <main className={`max-w-md mx-auto ${embeddedView ? '' : 'p-4'}`}>
        {successMsg && (
          <div className="mb-3 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">
            {successMsg}
          </div>
        )}

        {activeView === 'home' && (
          <>
            <button
              onClick={openNewRequest}
              className="w-full min-h-[76px] rounded-2xl bg-amber-600 hover:bg-amber-700 text-white text-lg font-bold flex items-center justify-center gap-2.5 shadow-lg mb-5"
            >
              <Send size={24} /> ส่งคำขอเงิน
            </button>

            {lineUnbound && (
              <button
                onClick={goToSettings}
                className="w-full mb-3 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-sky-200 bg-sky-50 text-sky-800 text-xs text-left hover:bg-sky-100"
              >
                <Bell size={15} className="shrink-0" />
                <span className="flex-1">รับแจ้งเตือนผ่าน LINE เมื่อคำขอมีความคืบหน้า — ผูก LINE ได้ในตั้งค่า</span>
              </button>
            )}

            {homeError && (
              <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
                <AlertTriangle size={14} /> {homeError}
              </div>
            )}

            {homeLoading ? (
              <div className="py-8 flex justify-center text-slate-400">
                <Loader2 className="animate-spin" size={21} />
              </div>
            ) : (
              <>
                {openAdvances.length > 0 && (
                  <section className="mb-6">
                    <h2 className="font-bold text-base mb-2">เงินเบิกที่กำลังปิดยอด</h2>
                    <div className="space-y-2">
                      {openAdvances.map((r) => (
                        <OpenAdvanceCard
                          key={r.id}
                          request={r}
                          liquidation={liquidations[r.id]}
                          loading={liquidationsLoading}
                          onOpenDetail={() => openDetail(r)}
                          onAddExpense={() => setExpenseSheetFor(r)}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {pendingRows.length > 0 && (
                  <section className="mb-6">
                    <h2 className="font-bold text-base mb-2">รอดำเนินการ</h2>
                    <div className="space-y-2">
                      {pendingRows.map((r) => (
                        <PendingRequestRow key={r.id} request={r} onOpen={() => openDetail(r)} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}

            <button
              onClick={() => onOpenMine ? onOpenMine() : setView('mine')}
              className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white text-slate-600 text-sm font-semibold hover:bg-slate-50"
            >
              ดูคำขอทั้งหมด
            </button>
          </>
        )}

        {activeView === 'mine' && (
          <>
            <div className="relative mb-3">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาคำขอ (เหตุผล, หมวดหมู่, จำนวนเงิน)"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <MyRequests
              title="คำขอของฉันทั้งหมด"
              reloadKey={requestReloadKey}
              filterText={search}
              onEdit={openEdit}
              onOpenDetail={openDetail}
            />

          </>
        )}

        {activeView === 'settings' && <Settings />}
      </main>

      {/* bottom nav — 3 items (เพิ่มเติม removed 2026-07-19), persistent labels + ARIA names */}
      {!embeddedView && <nav
        aria-label="เมนูหลัก"
        className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="max-w-md mx-auto grid grid-cols-3">
          <NavButton active={view === 'home'} label="หน้าแรก" icon={<Home size={20} />} onClick={() => setView('home')} />
          <NavButton active={view === 'mine'} label="คำขอของฉัน" icon={<ListChecks size={20} />} onClick={() => setView('mine')} />
          <NavButton active={view === 'settings'} label="ตั้งค่า" icon={<SettingsIcon size={20} />} onClick={() => setView('settings')} />
        </div>
      </nav>}

      {requestSheetOpen && (
        <RequestSheet
          editing={editingRequest}
          onClose={() => setRequestSheetOpen(false)}
          onSaved={() => {
            setSuccessMsg(editingRequest ? 'แก้ไขคำขอเรียบร้อย' : 'ส่งคำขอแล้ว กำลังรอตรวจ');
            setRequestReloadKey((key) => key + 1);
          }}
        />
      )}

      {detailRequestId && (
        <RequestDetail
          requestId={detailRequestId}
          onClose={() => setDetailRequestId(null)}
          onChanged={() => setRequestReloadKey((key) => key + 1)}
        />
      )}

      {/* เพิ่มค่าใช้จ่ายเบิก from an open-advance card on หน้าแรก — same liquidation
          ExpenseSheet wiring as RequestDetail.tsx (advanceRequestId + defaultEntity +
          conditional defaultCategory), copied verbatim. */}
      {expenseSheetFor && (
        <ExpenseSheet
          editing={null}
          advanceRequestId={expenseSheetFor.id}
          defaultEntity={expenseSheetFor.entity}
          defaultCategory={expenseSheetFor.categoryGroups.length > 0 ? undefined : expenseSheetFor.category}
          partyId={bootstrap.role !== 'messenger' ? bootstrap.party?.id : undefined}
          onClose={() => setExpenseSheetFor(null)}
          onSaved={() => {
            setExpenseSheetFor(null);
            setSuccessMsg('เพิ่มค่าใช้จ่ายเบิกแล้ว');
            setRequestReloadKey((key) => key + 1);
          }}
        />
      )}
    </div>
  );
}

// One card per open advance (จ่ายแล้ว / กำลังปิดยอด) on หน้าแรก. Stat-tile grid + the
// เพิ่มค่าใช้จ่ายเบิก button are copied verbatim from RequestDetail.tsx's liquidation
// section — same classes, same conditional ค้าง amber highlight.
function OpenAdvanceCard({
  request,
  liquidation,
  loading,
  onOpenDetail,
  onAddExpense,
}: {
  request: StaffRequest;
  liquidation: AdvanceLiquidation | null | undefined;
  loading: boolean;
  onOpenDetail: () => void;
  onAddExpense: () => void;
}) {
  const status = statusMeta(request);
  return (
    <article className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button onClick={onOpenDetail} className="w-full p-3 flex items-center gap-3 text-left">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-base">{baht(request.amountNum)}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${status.cls}`}>
              {status.label}
            </span>
          </div>
          <div className="text-sm text-slate-600 truncate">
            {TYPE_LABEL[request.requestType]}
            {request.reason ? ` · ${request.reason}` : ''}
          </div>
        </div>
      </button>

      <div className="px-3 pb-3">
        {loading && !liquidation ? (
          <div className="py-6 flex justify-center text-slate-400">
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : liquidation ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs mb-3">
              <div className="bg-slate-50 rounded-lg p-2">
                <div className="text-slate-400">เบิกไป</div>
                <div className="font-bold">{baht(Number(liquidation.advanceAmount))}</div>
              </div>
              <div className="bg-slate-50 rounded-lg p-2">
                <div className="text-slate-400">ใช้ไป</div>
                <div className="font-bold">{baht(Number(liquidation.totals.approvedExpenses))}</div>
              </div>
              <div className="bg-slate-50 rounded-lg p-2">
                <div className="text-slate-400">คืนแล้ว</div>
                <div className="font-bold">{baht(Number(liquidation.totals.returned))}</div>
              </div>
              <div className={`rounded-lg p-2 ${liquidation.totals.settled ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                <div className={liquidation.totals.settled ? 'text-emerald-700' : 'text-amber-700'}>ค้าง</div>
                <div className={`font-bold ${liquidation.totals.settled ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {baht(Number(liquidation.totals.remainingOutstanding))}
                </div>
              </div>
            </div>

            <button
              onClick={onAddExpense}
              className="w-full mt-1 min-h-[42px] rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 text-sm font-semibold flex items-center justify-center gap-1"
            >
              <Plus size={15} /> เพิ่มค่าใช้จ่ายเบิก
            </button>
          </>
        ) : (
          <div className="text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle size={12} /> โหลดข้อมูลปิดยอดไม่สำเร็จ
          </div>
        )}
      </div>
    </article>
  );
}

// Compact row (no stat tiles) for หน้าแรก's "รอดำเนินการ" list — รอตรวจ/รอ GM/รอ CEO plus
// recent ไม่อนุมัติ. Classes copied verbatim from MyRequests.tsx's collapsed row.
function PendingRequestRow({ request, onOpen }: { request: StaffRequest; onOpen: () => void }) {
  const status = statusMeta(request);
  return (
    <button
      onClick={onOpen}
      className="w-full bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3 text-left"
    >
      <MediaThumb id={request.requestPhotoUploadId} size={48} alt="รูปแนบคำขอ" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-base">{baht(request.amountNum)}</span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${status.cls}`}>
            {status.label}
          </span>
        </div>
        <div className="text-sm text-slate-600 truncate">
          {TYPE_LABEL[request.requestType]}
          {request.reason ? ` · ${request.reason}` : ''}
        </div>
      </div>
    </button>
  );
}

function NavButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] ${active ? 'text-amber-700' : 'text-slate-400'}`}
    >
      {icon}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}
