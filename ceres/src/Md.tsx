import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  CircleDollarSign,
  ClipboardCheck,
  Crown,
  Download,
  FileCheck2,
  History,
  Home,
  LayoutDashboard,
  ListChecks,
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
  listExpenses,
  listStaffRequests,
  logout as logoutSuite,
} from './lib/api';
import AppSwitcher from './AppSwitcher';
import MdBoard from './MdBoard';
import MdApproval, { type ApprovalPrefill } from './MdApproval';
import MdMoney from './MdMoney';
import MdClose from './MdClose';
import MdExpenses from './MdExpenses';
import MdTemplates from './MdTemplates';
import MdRecon from './MdRecon';
import CeoOverview, { WeeklyPackSection } from './CeoOverview';
import CeoHome from './CeoHome';
import MoreMenu, { type MoreMenuGroup } from './MoreMenu';
import NeeApprovalQueue from './NeeApprovalQueue';
import NeeFulfillmentQueue from './NeeFulfillmentQueue';
import NeeHome from './NeeHome';
import RequestSheet, { type RequestSheetPrefill } from './RequestSheet';
import Settings from './Settings';
import StaffHome from './StaffHome';

// v1 purge (2026-07-19) — MdRequests.tsx (the legacy list) is gone; every consumer that
// used to import todayStr() from it now carries this same one-liner locally, matching the
// pattern MdMoney.tsx/CeoHome.tsx/CeoOverview.tsx already use. See docs/CERES_V1_PURGE_PLAN.md.
function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
}

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
  | 'templates'
  | 'recon'
  | 'exports'
  | 'ceo-history'
  | 'legacy-fulfillment'
  | 'settings'
  | 'my-submit'
  | 'my-requests'
  // Legacy key only (CEO one-flow, 2026-07-21) — รอ CEO used to be its own leading desktop
  // tab around EscalationsSection; it's now folded into the ภาพรวม tab (EscalationsSection
  // renders at the top of CeoOverview/CeoHome, which already happens without help from this
  // key). Kept in the union purely so a stale/shared #ceo-queue hash redirects into ภาพรวม
  // instead of dead-ending — see `ceoQueueRedirect` below. Never a real destination anymore:
  // no tab points at it, gm never gets it (roleInappropriate, below).
  | 'ceo-queue'
  // Desktop-only (≥1024px) composed tabs (2026-07-18 flat-strip simplification) — each one
  // groups several of the individual keys above behind an internal segmented control. See the
  // desktop*Redirect consts + Cashbox/History/Other ComposedView components below, and
  // docs/CERES_DESKTOP_NAV.md for the full map. Not linked from any mobile UI (MoreMenu still
  // points at the individual keys), but included here so a stale hash never dead-ends.
  | 'cashbox'
  | 'history'
  | 'other';

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
  'templates',
  'recon',
  'exports',
  'ceo-history',
  'legacy-fulfillment',
  'settings',
  'my-submit',
  'my-requests',
  'ceo-queue',
  'cashbox',
  'history',
  'other',
];

const SECONDARY_VIEWS = new Set<View>([
  'board',
  'legacy-approval',
  'money',
  'close',
  'expenses',
  'templates',
  'recon',
  'exports',
  'ceo-history',
  'legacy-fulfillment',
  'settings',
  'my-submit',
  'my-requests',
  'cashbox',
  'history',
  'other',
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

// Sub-tab keys for the desktop-only composed views (2026-07-18 flat-strip simplification).
// Each mirrors a small cluster of the pre-existing individual View keys — see the
// desktop*Redirect consts in ManagementApp for how an old key (e.g. 'money') maps in and
// primes the right segment.
type CashboxTab = 'board' | 'money' | 'close';
type OtherTab = 'templates' | 'exports' | 'settings';

function ManagementApp({ isCeo }: { isCeo: boolean }) {
  const { agent, onLogout } = useCeres();
  const [view, setView] = useHashTab<View>(VIEW_KEYS, 'home');
  // v1 purge (2026-07-19) — MdTemplates's "สร้างคำขอจ่าย" now opens the v2 RequestSheet
  // prefilled instead of navigating to the deleted legacy requests screen. See
  // docs/CERES_V1_PURGE_PLAN.md Phase B item 5.
  const [templateRequestPrefill, setTemplateRequestPrefill] = useState<RequestSheetPrefill | null>(null);
  const [approvalPrefill, setApprovalPrefill] = useState<ApprovalPrefill | null>(null);
  const isDesktop = useIsDesktop();

  // A copied or stale hash must never expose a role-inappropriate primary screen.
  const roleInappropriate = isCeo
    ? view === 'approvals' || view === 'fulfillment'
    : view === 'ceo-history' || view === 'legacy-fulfillment' || view === 'ceo-queue';
  // Desktop gm has no big-button home (owner spec, 2026-07-18 desktop nav) — NeeHome's four
  // cards are a mobile-only front door, so a gm landing on (or hash-linking to) 'home' on a
  // ≥1024px viewport is redirected to their desktop default, the approval queue. CEO's 'home'
  // stays put: CeoOverview IS the desktop "ภาพรวม" tab (see ceoTabs below) once isDesktop.
  const desktopGmHomeRedirect = isDesktop && !isCeo && view === 'home';
  // Old individual keys folded into a desktop composed tab (2026-07-18) — each old destination
  // still works from mobile (its own render block below is untouched) and from a stale/shared
  // hash on desktop, it just lands on the composed tab that now contains it, with that tab's
  // internal segmented control primed to the right segment (see the *Tab state + syncing
  // useEffects below) instead of dead-ending.
  const desktopLegacyApprovalRedirect = isDesktop && !isCeo && view === 'legacy-approval';
  const desktopCeoHistoryRedirect = isDesktop && isCeo && view === 'ceo-history';
  // รอ CEO folded into ภาพรวม (CEO one-flow, 2026-07-21) — not gated on isDesktop like the
  // other *Redirect consts above: 'ceo-queue' was never a mobile destination either (see the
  // View type comment), so a stale/shared #ceo-queue hash should land on 'home' on ANY
  // viewport rather than only on desktop — mobile's CeoHome renders EscalationsSection near
  // its top too, so it's a reasonable landing there as well.
  const ceoQueueRedirect = isCeo && view === 'ceo-queue';
  const desktopCashboxRedirect = isDesktop && (view === 'board' || view === 'money' || view === 'close');
  const desktopHistoryRedirect = isDesktop && view === 'expenses';
  const desktopOtherRedirect = isDesktop && (view === 'templates' || view === 'exports' || view === 'settings');
  const activeView: View = roleInappropriate
    ? 'home'
    : desktopGmHomeRedirect
    ? 'approvals'
    : desktopLegacyApprovalRedirect
    ? 'approvals'
    : desktopCeoHistoryRedirect
    ? 'home'
    : ceoQueueRedirect
    ? 'home'
    : desktopCashboxRedirect
    ? 'cashbox'
    : desktopHistoryRedirect
    ? 'history'
    : desktopOtherRedirect
    ? 'other'
    : view;

  // ── Desktop-only (≥1024px) tab-strip badge counts — gated on isDesktop so mobile never
  // pays for the extra requests (mobile's NeeHome/CeoHome already fetch their own numbers for
  // their own cards; this is a separate, desktop-nav-only fetch, refreshed on every tab switch
  // for a reasonably "live" count without inventing a push channel). ─────────────────────────
  const [gmCounts, setGmCounts] = useState<{ approvals?: number; legacyApprovals?: number; fulfillment?: number; recon?: number }>({});
  useEffect(() => {
    if (!isDesktop || isCeo) return;
    let cancelled = false;
    listStaffRequests('queue', 200)
      .then((r) => { if (!cancelled) setGmCounts((c) => ({ ...c, approvals: r.requests.length })); })
      .catch(() => {});
    // Same call MdApproval itself makes by default (no partyId) — reused here for the อนุมัติ
    // tab's badge so the legacy expense-check queue counts toward the same red pill as the v2
    // request queue, with no new endpoint.
    listExpenses({ scope: 'all', status: 'pending' })
      .then((r) => { if (!cancelled) setGmCounts((c) => ({ ...c, legacyApprovals: r.expenses.length })); })
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

  // `queue` now feeds the ภาพรวม tab's pill (the old dedicated รอ CEO tab was folded into
  // ภาพรวม, CEO one-flow 2026-07-21 — see docs/CERES_DESKTOP_NAV.md). CeoOverview/CeoHome
  // fetch their own full escalations list once ภาพรวม is actually mounted; this effect exists
  // purely to keep the tab-strip pills fed while a different tab is showing.
  const [ceoBadges, setCeoBadges] = useState<{ queue?: number; fulfillment?: number; recon?: number }>({});
  const loadCeoBadges = useCallback(() => {
    getCeoOverview(todayStr())
      .then((d) => setCeoBadges((c) => ({ ...c, queue: d.escalations.length, recon: d.transferReconciliation.unmatched })))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!isCeo || !isDesktop) return;
    loadCeoBadges();
    listStaffRequests('all', 300)
      .then((r) => {
        const n = r.requests.filter((x) => x.approvalStatus === 'approved' && x.fulfillmentStatus === 'unfulfilled').length;
        setCeoBadges((c) => ({ ...c, fulfillment: n }));
      })
      .catch(() => {});
  }, [isDesktop, isCeo, view, loadCeoBadges]);

  // ── Internal segment state for the desktop composed tabs (กล่องเงินสด / ประวัติ / อื่นๆ) —
  // each defaults to its "ritual order" first segment, but re-primes itself whenever the raw
  // hash (`view`) lands directly on one of the old individual keys it now contains (e.g. a
  // MoreMenu/prefill flow that still does setView('money')), so that old flow still opens on
  // the right segment instead of always resetting to the default. ───────────────────────────
  const [cashboxTab, setCashboxTab] = useState<CashboxTab>('board');
  useEffect(() => {
    if (view === 'board' || view === 'money' || view === 'close') setCashboxTab(view);
  }, [view]);

  const [otherTab, setOtherTab] = useState<OtherTab>('templates');
  useEffect(() => {
    if (view === 'templates' || view === 'exports' || view === 'settings') setOtherTab(view);
  }, [view]);

  // ── One-shot "open the compose sheet immediately" flag for the ของฉัน tab. NeeHome/CeoHome's
  // big amber "ส่งคำขอเงิน" button (mobile-only front-door shortcut) still wants StaffHome's
  // request sheet to pop open right away, exactly like the old dedicated "ส่งคำขอ" tab did. The
  // desktop ของฉัน strip tab, by contrast, is a normal browsable landing (submit button + own
  // request list) and must NOT auto-pop a modal every time it's clicked. Set true only by
  // goToOwnRequest below, and cleared the moment we navigate away from 'my-submit'. ──────────
  const [autoOpenOwnRequest, setAutoOpenOwnRequest] = useState(false);
  useEffect(() => {
    if (view !== 'my-submit') setAutoOpenOwnRequest(false);
  }, [view]);
  function goToOwnRequest() {
    setAutoOpenOwnRequest(true);
    setView('my-submit');
  }

  function openTemplateRequest(prefill: RequestSheetPrefill) {
    setTemplateRequestPrefill(prefill);
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
      title: isCeo ? 'เครื่องมือปฏิบัติการ' : 'งานเงินสดและการปิดยอด',
      items: [
        { key: 'board', label: 'กระดานเงินสด', icon: <LayoutDashboard size={17} />, onClick: () => setView('board') },
        { key: 'legacy-approval', label: 'ตรวจใบเสร็จค่าใช้จ่าย', icon: <ClipboardCheck size={17} />, onClick: () => setView('legacy-approval') },
        { key: 'money', label: 'ฝากเงิน', icon: <ArrowLeftRight size={17} />, onClick: () => setView('money') },
        { key: 'close', label: 'ปิดยอดประจำวัน', icon: <FileCheck2 size={17} />, onClick: () => setView('close') },
        ...(isCeo
          ? [{ key: 'legacy-fulfillment', label: 'รอจ่าย', icon: <CircleDollarSign size={17} />, onClick: () => setView('legacy-fulfillment') }]
          : []),
      ],
    },
    {
      title: isCeo ? 'รายการและการตั้งค่า' : 'รายการ ประวัติ และส่งออก',
      items: [
        ...(!isCeo ? [{ key: 'expenses', label: 'ประวัติค่าใช้จ่าย', icon: <ListChecks size={17} />, onClick: () => setView('expenses') }] : []),
        { key: 'templates', label: 'รายการประจำ', icon: <Repeat size={17} />, onClick: () => setView('templates') },
        ...(!isCeo ? [
          { key: 'recon', label: 'กระทบยอดรายการโอน', icon: <Scale size={17} />, onClick: () => setView('recon') },
          { key: 'exports', label: 'ส่งออกข้อมูล', sub: 'ดาวน์โหลดไฟล์ CSV ตามช่วงวันที่', icon: <Download size={17} />, onClick: () => setView('exports') },
        ] : []),
        { key: 'settings', label: 'ตั้งค่า LINE', icon: <SettingsIcon size={17} />, onClick: () => setView('settings') },
      ],
    },
  ];

  // ── Desktop (≥1024px) FLAT tab strip (2026-07-18 simplification, tightened to 7/7 in the
  // 2026-07-21 CEO one-flow — no group captions, no divider bars; 7 tabs each for GM and CEO).
  // Every tab still maps onto an existing mobile destination or a composed view built from
  // existing components (see the Approvals/Cashbox/History/OtherComposedView components below
  // + docs/CERES_DESKTOP_NAV.md for the full map). Active tab = amber underline + bold, red
  // pill count badges — same look as before, just flattened. ────────────────────────────────
  type Tab = { key: View; label: string; icon: React.ReactNode; count?: number };
  const gmTabs: Tab[] = [
    { key: 'approvals', label: 'อนุมัติ', icon: <ClipboardCheck size={16} />, count: (gmCounts.approvals ?? 0) + (gmCounts.legacyApprovals ?? 0) },
    { key: 'fulfillment', label: 'รอจ่าย', icon: <CircleDollarSign size={16} />, count: gmCounts.fulfillment },
    { key: 'recon', label: 'โอน/สลิป', icon: <Scale size={16} />, count: gmCounts.recon },
    { key: 'cashbox', label: 'กล่องเงินสด', icon: <PiggyBank size={16} /> },
    { key: 'history', label: 'ประวัติ', icon: <History size={16} /> },
    { key: 'my-submit', label: 'ของฉัน', icon: <Send size={16} /> },
    { key: 'other', label: 'อื่นๆ', icon: <MoreHorizontal size={16} /> },
  ];
  // รอ CEO folded into ภาพรวม (CEO one-flow, 2026-07-21): the escalations queue now renders at
  // the top of CeoOverview itself, so its old leading tab is gone (8 → 7) and its red pill
  // count (ceoBadges.queue) moves onto ภาพรวม. "รอจ่าย" also unifies with GM's label — the old
  // CEO-only "จ่าย/ซื้อ" name for the same NeeFulfillmentQueue destination.
  const ceoTabs: Tab[] = [
    { key: 'home', label: 'ภาพรวม', icon: <LayoutDashboard size={16} />, count: ceoBadges.queue },
    { key: 'legacy-fulfillment', label: 'รอจ่าย', icon: <CircleDollarSign size={16} />, count: ceoBadges.fulfillment },
    { key: 'recon', label: 'โอน/สลิป', icon: <Scale size={16} />, count: ceoBadges.recon },
    { key: 'cashbox', label: 'กล่องเงินสด', icon: <PiggyBank size={16} /> },
    { key: 'history', label: 'ประวัติ', icon: <History size={16} /> },
    { key: 'my-submit', label: 'ของฉัน', icon: <Send size={16} /> },
    { key: 'other', label: 'อื่นๆ', icon: <MoreHorizontal size={16} /> },
  ];
  const desktopTabs = isCeo ? ceoTabs : gmTabs;

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

        {/* Desktop-only (≥1024px) flat tab strip — IS the nav on desktop: no big-button home,
            no bottom bar, no "more". Every top-level destination is a tab here, no group
            captions or divider bars (2026-07-18 simplification). Mobile never renders this
            (hidden below lg:), so the existing role homes + MoreMenu are completely untouched
            below lg:. Light Juno-styled strip (2026-07-18, owner preference over the dark-band
            experiment: "i like how Juno does better") — tab/badge classes mirror juno/src/Juno.tsx
            with amber standing in for Juno's emerald; inner container matches the header row's
            own max-w-5xl mx-auto px-4 so the tabs line up under the logo/logout row. */}
        <div className="hidden lg:block bg-white border-b border-slate-200">
          <div className="max-w-5xl mx-auto px-4 flex lg:flex-wrap gap-1">
            {desktopTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium border-b-2 whitespace-nowrap ${
                  activeView === t.key
                    ? 'border-amber-600 text-amber-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
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
          isDesktop ? (
            <CeoOverview showDailyOutflow onGoExpenses={() => setView('expenses')} />
          ) : (
            <CeoHome onGoOwnRequest={goToOwnRequest} />
          )
        ) : (
          <NeeHome
            onGoApprovals={() => setView('approvals')}
            onGoFulfillment={() => setView('fulfillment')}
            onGoRecon={() => setView('recon')}
            onGoBoard={() => setView('board')}
            onGoOwnRequest={goToOwnRequest}
          />
        ))}
        {activeView === 'approvals' && !isCeo && (
          isDesktop ? (
            <ApprovalsComposedView prefill={approvalPrefill} onConsumePrefill={() => setApprovalPrefill(null)} />
          ) : (
            <NeeApprovalQueue />
          )
        )}
        {activeView === 'fulfillment' && !isCeo && <NeeFulfillmentQueue />}
        {activeView === 'more' && <MoreMenu groups={moreGroups} />}
        {activeView === 'board' && <MdBoard onViewPendingParty={goToApprovalWithPrefill} />}
        {activeView === 'legacy-approval' && (
          <MdApproval prefill={approvalPrefill} onConsumePrefill={() => setApprovalPrefill(null)} />
        )}
        {activeView === 'money' && <MdMoney />}
        {activeView === 'close' && <MdClose />}
        {activeView === 'expenses' && <MdExpenses />}
        {activeView === 'templates' && <MdTemplates onCreateRequest={openTemplateRequest} />}
        {activeView === 'recon' && <MdRecon />}
        {activeView === 'exports' && <WeeklyPackSection />}
        {activeView === 'ceo-history' && isCeo && <CeoOverview onGoExpenses={() => setView('expenses')} />}
        {activeView === 'legacy-fulfillment' && isCeo && <NeeFulfillmentQueue />}
        {activeView === 'settings' && <Settings />}
        {activeView === 'my-submit' && (
          <StaffHome
            key="my-submit"
            embeddedView="home"
            openRequestOnMount={autoOpenOwnRequest}
            onOpenMine={() => setView('my-requests')}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {activeView === 'my-requests' && (
          <StaffHome key="my-requests" embeddedView="mine" onOpenSettings={() => setView('settings')} />
        )}
        {/* 'ceo-queue' is never activeView anymore — ceoQueueRedirect (above) always resolves
            it to 'home' — see the View type comment for why the key still exists. */}
        {activeView === 'cashbox' && (
          <CashboxComposedView sub={cashboxTab} onSubChange={setCashboxTab} onViewPendingParty={goToApprovalWithPrefill} />
        )}
        {activeView === 'history' && <HistoryComposedView />}
        {activeView === 'other' && (
          <OtherComposedView sub={otherTab} onSubChange={setOtherTab} onCreateRequest={openTemplateRequest} />
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

      {templateRequestPrefill && (
        <RequestSheet
          prefill={templateRequestPrefill}
          onClose={() => setTemplateRequestPrefill(null)}
          onSaved={() => setTemplateRequestPrefill(null)}
        />
      )}
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

// ── Desktop composed views (2026-07-18) — each composes EXISTING screens rather than
// rewriting them. See docs/CERES_DESKTOP_NAV.md for the rationale per tab. ───────────────────

// อนุมัติ (GM only): the v2 request queue on top, the legacy expense-check screen below it
// under its own section header, so GM only needs one tab to clear both approval lanes.
function ApprovalsComposedView({
  prefill,
  onConsumePrefill,
}: {
  prefill: ApprovalPrefill | null;
  onConsumePrefill: () => void;
}) {
  return (
    <div className="space-y-6">
      <NeeApprovalQueue />
      <div className="pt-4 border-t border-slate-200">
        <div className="text-sm font-semibold text-slate-500 mb-2">ตรวจใบเสร็จค่าใช้จ่าย</div>
        <MdApproval prefill={prefill} onConsumePrefill={onConsumePrefill} />
      </div>
    </div>
  );
}

// A compact inline pill-group segmented control (2026-07-18 restyle — owner: the old
// full-width grid of big buttons read as an oversized slab, esp. the 3-wide อื่นๆ row).
// Left-aligned at the top of the view content, sized to its content rather than the row.
function SegmentBar<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string; icon: React.ReactNode }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 mb-4 rounded-lg border border-slate-200 bg-white">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${
            value === o.key ? 'bg-amber-600 text-white font-medium' : 'text-slate-600 hover:bg-slate-50'
          }`}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}

// กล่องเงินสด: บอร์ด · เบิก·คืน · ปิดวัน — ritual order, defaults to บอร์ด.
function CashboxComposedView({
  sub,
  onSubChange,
  onViewPendingParty,
}: {
  sub: CashboxTab;
  onSubChange: (t: CashboxTab) => void;
  onViewPendingParty: (partyId: string) => void;
}) {
  return (
    <div>
      <SegmentBar
        value={sub}
        onChange={onSubChange}
        options={[
          { key: 'board', label: 'บอร์ด', icon: <PiggyBank size={15} /> },
          { key: 'money', label: 'ฝากเงิน', icon: <ArrowLeftRight size={15} /> },
          { key: 'close', label: 'ปิดวัน', icon: <FileCheck2 size={15} /> },
        ]}
      />
      {sub === 'board' && <MdBoard onViewPendingParty={onViewPendingParty} />}
      {sub === 'money' && <MdMoney />}
      {sub === 'close' && <MdClose />}
    </div>
  );
}

// ประวัติ: ค่าใช้จ่ายเท่านั้น (คำขอเดิม segment ถูกถอดออกพร้อมกับ MdRequests.tsx — v1 purge
// 2026-07-19, docs/CERES_V1_PURGE_PLAN.md Phase B item 1). No SegmentBar left since there's
// only one destination now; keeps the composed-tab wrapper so desktopHistoryRedirect still
// has somewhere to land.
function HistoryComposedView() {
  return <MdExpenses />;
}

// อื่นๆ: ประจำ · ส่งออก · ตั้งค่า.
function OtherComposedView({
  sub,
  onSubChange,
  onCreateRequest,
}: {
  sub: OtherTab;
  onSubChange: (t: OtherTab) => void;
  onCreateRequest: (prefill: RequestSheetPrefill) => void;
}) {
  return (
    <div>
      <SegmentBar
        value={sub}
        onChange={onSubChange}
        options={[
          { key: 'templates', label: 'ประจำ', icon: <Repeat size={15} /> },
          { key: 'exports', label: 'ส่งออก', icon: <Download size={15} /> },
          { key: 'settings', label: 'ตั้งค่า', icon: <SettingsIcon size={15} /> },
        ]}
      />
      {sub === 'templates' && <MdTemplates onCreateRequest={onCreateRequest} />}
      {sub === 'exports' && <WeeklyPackSection />}
      {sub === 'settings' && <Settings />}
    </div>
  );
}
