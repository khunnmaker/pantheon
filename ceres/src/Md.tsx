import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  Banknote,
  Bell,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Crown,
  Download,
  FileCheck2,
  History,
  Home,
  LayoutDashboard,
  ListChecks,
  Loader2,
  LogOut,
  MoreHorizontal,
  PiggyBank,
  Repeat,
  Scale,
  Send,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useHashTab } from '@pantheon/ui';
import { useCeres } from './lib/bootstrapContext';
import {
  getTransferReconciliation,
  getCeoOverview,
  listStaffRequests,
  logout as logoutSuite,
  type CeoOverview as CeoOverviewData,
} from './lib/api';
import AppSwitcher from './AppSwitcher';
import MdBoard from './MdBoard';
import MdApproval, { type ApprovalPrefill } from './MdApproval';
import MdMoney from './MdMoney';
import MdClose from './MdClose';
import MdExpenses from './MdExpenses';
import MdRequests, { todayStr, type RequestPrefill } from './MdRequests';
import MdTemplates from './MdTemplates';
import MdRecon from './MdRecon';
import CeoOverview, { EscalationsSection, WeeklyPackSection } from './CeoOverview';
import CeoHome from './CeoHome';
import MoreMenu, { type MoreMenuGroup } from './MoreMenu';
import NeeApprovalQueue from './NeeApprovalQueue';
import NeeFulfillmentQueue from './NeeFulfillmentQueue';
import NeeHome from './NeeHome';
import Settings from './Settings';
import StaffHome from './StaffHome';

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? 'https://pantheon.prominentdental.com';

type View =
  | 'home'
  | 'approvals'
  | 'fulfillment'
  | 'more'
  | 'board'
  | 'legacy-approval'
  | 'money'
  | 'close'
  | 'expenses'
  | 'requests'
  | 'templates'
  | 'recon'
  | 'exports'
  | 'ceo-history'
  | 'legacy-fulfillment'
  | 'settings'
  | 'my-submit'
  | 'my-requests'
  // Desktop-only (≥1024px) CEO escalation queue — a focused single-purpose screen around the
  // same EscalationsSection CeoHome/CeoOverview already render, so the leading tab in the CEO's
  // desktop strip (ceoTabGroups, inside ManagementApp below) has somewhere dedicated to point.
  // Never reachable on mobile (not in moreGroups, not in SECONDARY_VIEWS) and gm never gets it
  // (roleInappropriate, below).
  | 'ceo-queue';

const VIEW_KEYS: View[] = [
  'home',
  'approvals',
  'fulfillment',
  'more',
  'board',
  'legacy-approval',
  'money',
  'close',
  'expenses',
  'requests',
  'templates',
  'recon',
  'exports',
  'ceo-history',
  'legacy-fulfillment',
  'settings',
  'my-submit',
  'my-requests',
  'ceo-queue',
];

const SECONDARY_VIEWS = new Set<View>([
  'board',
  'legacy-approval',
  'money',
  'close',
  'expenses',
  'requests',
  'templates',
  'recon',
  'exports',
  'ceo-history',
  'legacy-fulfillment',
  'settings',
  'my-submit',
  'my-requests',
]);

// Tracks Tailwind's own `lg:` breakpoint (min-width: 1024px) in JS, for the few nav decisions
// that are about WHICH CONTENT renders (not just which markup is visually hidden) — e.g. gm's
// desktop home→approvals redirect below. The two nav trees themselves (mobile bottom bar vs
// desktop tab strip) are still plain CSS (hidden/lg:flex), so this hook only gates state logic.
function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)';
  const [isDesktop, setIsDesktop] = useState<boolean>(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

export default function MdApp() {
  const { bootstrap } = useCeres();
  return bootstrap.role === 'ceo' ? <CeoApp /> : <NeeApp />;
}

export function NeeApp() {
  return <ManagementApp isCeo={false} />;
}

export function CeoApp() {
  return <ManagementApp isCeo />;
}

function ManagementApp({ isCeo }: { isCeo: boolean }) {
  const { agent, onLogout } = useCeres();
  const [view, setView] = useHashTab<View>(VIEW_KEYS, 'home');
  const [requestPrefill, setRequestPrefill] = useState<RequestPrefill | null>(null);
  const [approvalPrefill, setApprovalPrefill] = useState<ApprovalPrefill | null>(null);
  const isDesktop = useIsDesktop();

  // A copied or stale hash must never expose a role-inappropriate primary screen.
  const roleInappropriate = isCeo
    ? view === 'approvals' || view === 'fulfillment' || view === 'my-submit' || view === 'my-requests'
    : view === 'ceo-history' || view === 'legacy-fulfillment' || view === 'ceo-queue';
  // Desktop gm has no big-button home (owner spec, 2026-07-18 desktop nav) — NeeHome's four
  // cards are a mobile-only front door, so a gm landing on (or hash-linking to) 'home' on a
  // ≥1024px viewport is redirected to their desktop default, the approval queue. CEO's 'home'
  // stays put: CeoHome IS the desktop "oversight" tab (see ceoTabGroups below).
  const desktopGmHomeRedirect = isDesktop && !isCeo && view === 'home';
  const activeView = roleInappropriate ? 'home' : desktopGmHomeRedirect ? 'approvals' : view;

  // ── Desktop-only (≥1024px) tab-strip badge counts — gated on isDesktop so mobile never
  // pays for the extra requests (mobile's NeeHome/CeoHome already fetch their own numbers for
  // their own cards; this is a separate, desktop-nav-only fetch, refreshed on every tab switch
  // for a reasonably "live" count without inventing a push channel). ─────────────────────────
  const [gmCounts, setGmCounts] = useState<{ approvals?: number; fulfillment?: number; recon?: number }>({});
  useEffect(() => {
    if (!isDesktop || isCeo) return;
    let cancelled = false;
    listStaffRequests('queue', 200)
      .then((r) => { if (!cancelled) setGmCounts((c) => ({ ...c, approvals: r.requests.length })); })
      .catch(() => {});
    listStaffRequests('all', 300)
      .then((r) => {
        if (cancelled) return;
        const n = r.requests.filter((x) => x.approvalStatus === 'approved' && x.fulfillmentStatus === 'unfulfilled').length;
        setGmCounts((c) => ({ ...c, fulfillment: n }));
      })
      .catch(() => {});
    getTransferReconciliation()
      .then((r) => {
        if (cancelled) return;
        const n = r.transferEvents.filter((e) => e.reconciliationState === 'unmatched').length;
        setGmCounts((c) => ({ ...c, recon: n }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isDesktop, isCeo, view]);

  const [ceoBadges, setCeoBadges] = useState<{ queue?: number; fulfillment?: number; recon?: number }>({});
  const [ceoEscalations, setCeoEscalations] = useState<CeoOverviewData['escalations']>([]);
  const [ceoQueueLoading, setCeoQueueLoading] = useState(true);
  const [ceoQueueError, setCeoQueueError] = useState('');
  const loadCeoQueue = useCallback(() => {
    setCeoQueueLoading(true);
    setCeoQueueError('');
    getCeoOverview(todayStr())
      .then((d) => {
        setCeoEscalations(d.escalations);
        setCeoBadges((c) => ({ ...c, queue: d.escalations.length, recon: d.transferReconciliation.unmatched }));
      })
      .catch(() => setCeoQueueError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setCeoQueueLoading(false));
  }, []);
  useEffect(() => {
    // Also fires for a bare #ceo-queue deep link on a narrow viewport (not reachable from any
    // mobile UI, but a manually-typed/shared hash shouldn't spin forever) — everywhere else
    // this is a desktop-only fetch.
    if (!isCeo || !(isDesktop || view === 'ceo-queue')) return;
    loadCeoQueue();
    listStaffRequests('all', 300)
      .then((r) => {
        const n = r.requests.filter((x) => x.approvalStatus === 'approved' && x.fulfillmentStatus === 'unfulfilled').length;
        setCeoBadges((c) => ({ ...c, fulfillment: n }));
      })
      .catch(() => {});
  }, [isDesktop, isCeo, view, loadCeoQueue]);

  function goToRequestsWithPrefill(prefill: RequestPrefill) {
    setRequestPrefill(prefill);
    setView('requests');
  }

  function goToApprovalWithPrefill(partyId: string) {
    setApprovalPrefill({ partyId });
    setView('legacy-approval');
  }

  const moreGroups: MoreMenuGroup[] = [
    ...(isCeo
      ? [{
          title: 'ประวัติและส่งออก',
          items: [
            { key: 'ceo-history', label: 'ภาพรวมย้อนหลัง', sub: 'เลือกวันที่ ดูประวัติ และชุดตรวจสอบรายสัปดาห์', icon: <History size={17} />, onClick: () => setView('ceo-history') },
            { key: 'expenses', label: 'ประวัติค่าใช้จ่าย', icon: <ListChecks size={17} />, onClick: () => setView('expenses') },
            { key: 'recon', label: 'กระทบยอดรายการโอน', icon: <Scale size={17} />, onClick: () => setView('recon') },
            { key: 'exports', label: 'ส่งออกข้อมูล', sub: 'ดาวน์โหลดไฟล์ CSV ตามช่วงวันที่', icon: <Download size={17} />, onClick: () => setView('exports') },
          ],
        }]
      : []),
    {
      title: isCeo ? 'เครื่องมือปฏิบัติการเดิม' : 'งานเงินสดและการปิดยอด',
      items: [
        { key: 'board', label: 'กระดานเงินสด', icon: <LayoutDashboard size={17} />, onClick: () => setView('board') },
        { key: 'legacy-approval', label: 'ตรวจค่าใช้จ่ายเดิม', icon: <ClipboardCheck size={17} />, onClick: () => setView('legacy-approval') },
        { key: 'money', label: 'เบิก / คืนเงิน', icon: <ArrowLeftRight size={17} />, onClick: () => setView('money') },
        { key: 'close', label: 'ปิดยอดประจำวัน', icon: <FileCheck2 size={17} />, onClick: () => setView('close') },
        ...(isCeo
          ? [{ key: 'legacy-fulfillment', label: 'จ่าย / ซื้อ', icon: <CircleDollarSign size={17} />, onClick: () => setView('legacy-fulfillment') }]
          : []),
      ],
    },
    {
      title: isCeo ? 'รายการและการตั้งค่า' : 'รายการ ประวัติ และส่งออก',
      items: [
        ...(!isCeo ? [{ key: 'expenses', label: 'ประวัติค่าใช้จ่าย', icon: <ListChecks size={17} />, onClick: () => setView('expenses') }] : []),
        { key: 'requests', label: 'คำขอจ่ายเงินเดิม', icon: <Banknote size={17} />, onClick: () => setView('requests') },
        { key: 'templates', label: 'รายการประจำ', icon: <Repeat size={17} />, onClick: () => setView('templates') },
        ...(!isCeo ? [
          { key: 'recon', label: 'กระทบยอดรายการโอน', icon: <Scale size={17} />, onClick: () => setView('recon') },
          { key: 'exports', label: 'ส่งออกข้อมูล', sub: 'ดาวน์โหลดไฟล์ CSV ตามช่วงวันที่', icon: <Download size={17} />, onClick: () => setView('exports') },
        ] : []),
        { key: 'settings', label: 'ตั้งค่า LINE', icon: <SettingsIcon size={17} />, onClick: () => setView('settings') },
      ],
    },
  ];

  // ── Desktop (≥1024px) grouped tab strip — organized like Juno's (juno/src/Juno.tsx):
  // small muted group captions above each cluster, thin vertical dividers between groups,
  // active tab = amber underline + bold (Ceres's own brand color, matching the rest of this
  // header/nav rather than literally recoloring to Juno's emerald), red pill count badges on
  // queue tabs. Every group/tab here maps onto an EXISTING mobile destination (moreGroups
  // above, or NeeHome/CeoHome's shortcuts) — nothing new except the 'ceo-queue' screen, which
  // is just CeoHome/CeoOverview's own EscalationsSection given a dedicated tab. See
  // GROUPING.md at the repo root for the full mapping + rationale.
  type Tab = { key: View; label: string; icon: React.ReactNode; count?: number };
  const gmTabGroups: { caption: string; tabs: Tab[] }[] = [
    { caption: 'ขั้น 1 · คำขอ', tabs: [
      { key: 'approvals', label: 'อนุมัติ', icon: <ClipboardCheck size={16} />, count: gmCounts.approvals },
    ] },
    { caption: 'ขั้น 2 · จ่ายเงิน', tabs: [
      { key: 'fulfillment', label: 'รอจ่าย', icon: <CircleDollarSign size={16} />, count: gmCounts.fulfillment },
      { key: 'recon', label: 'โอน/สลิป', icon: <Scale size={16} />, count: gmCounts.recon },
    ] },
    { caption: 'กล่องเงินสด', tabs: [
      { key: 'board', label: 'บอร์ด', icon: <PiggyBank size={16} /> },
      { key: 'close', label: 'ปิดวัน', icon: <FileCheck2 size={16} /> },
    ] },
    { caption: 'ค่าใช้จ่ายเดิม', tabs: [
      { key: 'legacy-approval', label: 'ตรวจค่าใช้จ่าย', icon: <ClipboardList size={16} /> },
      { key: 'money', label: 'เบิก/คืนเงิน', icon: <ArrowLeftRight size={16} /> },
      { key: 'expenses', label: 'ประวัติค่าใช้จ่าย', icon: <ListChecks size={16} /> },
      { key: 'requests', label: 'คำขอจ่ายเงินเดิม', icon: <Banknote size={16} /> },
      { key: 'templates', label: 'รายการประจำ', icon: <Repeat size={16} /> },
    ] },
    { caption: 'ของฉัน', tabs: [
      { key: 'my-submit', label: 'ส่งคำขอ', icon: <Send size={16} /> },
      { key: 'my-requests', label: 'คำขอของฉัน', icon: <ListChecks size={16} /> },
    ] },
    { caption: 'สรุป', tabs: [
      { key: 'exports', label: 'ส่งออกข้อมูล', icon: <Download size={16} /> },
      { key: 'settings', label: 'ตั้งค่า LINE', icon: <SettingsIcon size={16} /> },
    ] },
  ];
  const ceoTabGroups: { caption: string; tabs: Tab[] }[] = [
    { caption: 'รอ CEO', tabs: [
      { key: 'ceo-queue', label: 'รอ CEO', icon: <Bell size={16} />, count: ceoBadges.queue },
    ] },
    { caption: 'ภาพรวม', tabs: [
      { key: 'home', label: 'วันนี้', icon: <LayoutDashboard size={16} /> },
      { key: 'ceo-history', label: 'ย้อนหลัง', icon: <History size={16} /> },
    ] },
    { caption: 'ขั้น 2 · จ่ายเงิน', tabs: [
      { key: 'legacy-fulfillment', label: 'จ่าย/ซื้อ', icon: <CircleDollarSign size={16} />, count: ceoBadges.fulfillment },
      { key: 'recon', label: 'โอน/สลิป', icon: <Scale size={16} />, count: ceoBadges.recon },
    ] },
    { caption: 'กล่องเงินสด', tabs: [
      { key: 'board', label: 'บอร์ด', icon: <PiggyBank size={16} /> },
      { key: 'close', label: 'ปิดวัน', icon: <FileCheck2 size={16} /> },
    ] },
    { caption: 'ค่าใช้จ่ายเดิม', tabs: [
      { key: 'legacy-approval', label: 'ตรวจค่าใช้จ่าย', icon: <ClipboardList size={16} /> },
      { key: 'money', label: 'เบิก/คืนเงิน', icon: <ArrowLeftRight size={16} /> },
      { key: 'expenses', label: 'ประวัติค่าใช้จ่าย', icon: <ListChecks size={16} /> },
      { key: 'requests', label: 'คำขอจ่ายเงินเดิม', icon: <Banknote size={16} /> },
      { key: 'templates', label: 'รายการประจำ', icon: <Repeat size={16} /> },
    ] },
    { caption: 'สรุป', tabs: [
      { key: 'exports', label: 'ส่งออกข้อมูล', icon: <Download size={16} /> },
      { key: 'settings', label: 'ตั้งค่า LINE', icon: <SettingsIcon size={16} /> },
    ] },
  ];
  const desktopTabGroups = isCeo ? ceoTabGroups : gmTabGroups;

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20 lg:pb-4">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-700">
            <AppSwitcher agent={agent} />
            <span className="text-slate-400 text-sm hidden sm:inline">· {isCeo ? 'CEO' : 'GM'}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {PORTAL_URL && (
              <a href={PORTAL_URL} title="กลับพอร์ทัล Pantheon" className="flex items-center gap-1 text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <span className="text-slate-500 hidden sm:inline">{agent.name}</span>
            <button
              onClick={() => {
                void logoutSuite();
                onLogout();
              }}
              aria-label="ออกจากระบบ"
              className="flex items-center gap-1 text-slate-500 hover:text-rose-600"
            >
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>

        {/* Desktop-only (≥1024px) grouped tab strip — see the gmTabGroups/ceoTabGroups
            comment above for the design rationale. IS the nav on desktop: no big-button
            home, no bottom bar, no "more" — every destination is a tab here. Mobile never
            renders this (hidden below lg:), so the existing role homes + MoreMenu are
            completely untouched below lg:. */}
        <div className="hidden lg:flex max-w-5xl mx-auto px-4 gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {desktopTabGroups.map((group, index) => (
            <div key={group.caption} className={`flex flex-col shrink-0 ${index > 0 ? 'border-l border-slate-200 pl-2' : ''}`}>
              <div className="text-[10px] leading-[13px] text-slate-400 whitespace-nowrap select-none">{group.caption}</div>
              <div className="flex gap-1">
                {group.tabs.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setView(t.key)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm border-b-2 whitespace-nowrap ${
                      activeView === t.key
                        ? 'border-amber-600 text-amber-700 font-bold'
                        : 'border-transparent text-slate-500 font-medium hover:text-slate-700'
                    }`}
                  >
                    {t.icon} {t.label}
                    {typeof t.count === 'number' && t.count > 0 && (
                      <span className="ml-1 px-1.5 rounded-full text-xs bg-rose-100 text-rose-700">{t.count}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4">
        {SECONDARY_VIEWS.has(activeView) && (
          <button
            onClick={() => setView(activeView === 'my-submit' || activeView === 'my-requests' ? 'home' : 'more')}
            className="lg:hidden mb-3 flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-amber-700"
          >
            <ArrowLeft size={16} /> {activeView === 'my-submit' || activeView === 'my-requests' ? 'กลับหน้าหลัก' : 'กลับไปเมนูเพิ่มเติม'}
          </button>
        )}

        {activeView === 'home' && (isCeo ? (
          <CeoHome />
        ) : (
          <NeeHome
            onGoApprovals={() => setView('approvals')}
            onGoFulfillment={() => setView('fulfillment')}
            onGoRecon={() => setView('recon')}
            onGoBoard={() => setView('board')}
            onGoOwnRequest={() => setView('my-submit')}
          />
        ))}
        {activeView === 'approvals' && !isCeo && <NeeApprovalQueue />}
        {activeView === 'fulfillment' && !isCeo && <NeeFulfillmentQueue />}
        {activeView === 'more' && <MoreMenu groups={moreGroups} />}
        {activeView === 'board' && <MdBoard onViewPendingParty={goToApprovalWithPrefill} />}
        {activeView === 'legacy-approval' && (
          <MdApproval prefill={approvalPrefill} onConsumePrefill={() => setApprovalPrefill(null)} />
        )}
        {activeView === 'money' && <MdMoney />}
        {activeView === 'close' && <MdClose />}
        {activeView === 'expenses' && <MdExpenses />}
        {activeView === 'requests' && (
          <MdRequests prefill={requestPrefill} onConsumePrefill={() => setRequestPrefill(null)} />
        )}
        {activeView === 'templates' && <MdTemplates onCreateRequest={goToRequestsWithPrefill} />}
        {activeView === 'recon' && <MdRecon />}
        {activeView === 'exports' && <WeeklyPackSection />}
        {activeView === 'ceo-history' && isCeo && <CeoOverview onGoExpenses={() => setView('expenses')} />}
        {activeView === 'legacy-fulfillment' && isCeo && <NeeFulfillmentQueue />}
        {activeView === 'settings' && <Settings />}
        {activeView === 'my-submit' && !isCeo && (
          <StaffHome
            key="my-submit"
            embeddedView="home"
            openRequestOnMount
            onOpenMine={() => setView('my-requests')}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {activeView === 'my-requests' && !isCeo && (
          <StaffHome key="my-requests" embeddedView="mine" onOpenSettings={() => setView('settings')} />
        )}
        {activeView === 'ceo-queue' && isCeo && (
          ceoQueueLoading ? (
            <div className="py-16 flex justify-center text-slate-400">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : ceoQueueError ? (
            <div className="py-16 flex items-center justify-center gap-1 text-rose-600 text-sm">
              <AlertTriangle size={15} /> {ceoQueueError}
            </div>
          ) : (
            <EscalationsSection escalations={ceoEscalations} onDecided={loadCeoQueue} />
          )
        )}
      </main>

      <nav aria-label="เมนูหลัก" className="lg:hidden fixed bottom-0 inset-x-0 z-20 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]">
        <div className={`max-w-5xl mx-auto grid ${isCeo ? 'grid-cols-2' : 'grid-cols-4'}`}>
          <NavButton active={activeView === 'home'} label="Home" icon={<Home size={20} />} onClick={() => setView('home')} />
          {!isCeo && <NavButton active={activeView === 'approvals'} label="Approvals" icon={<ClipboardCheck size={20} />} onClick={() => setView('approvals')} />}
          {!isCeo && <NavButton active={activeView === 'fulfillment'} label="Fulfillment" icon={<CircleDollarSign size={20} />} onClick={() => setView('fulfillment')} />}
          <NavButton active={activeView === 'more' || SECONDARY_VIEWS.has(activeView)} label="More" icon={<MoreHorizontal size={20} />} onClick={() => setView('more')} />
        </div>
      </nav>
    </div>
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
