import { useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  Banknote,
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
  Repeat,
  Scale,
  Settings as SettingsIcon,
  Wallet,
} from 'lucide-react';
import { useHashTab } from '@pantheon/ui';
import { useCeres } from './lib/bootstrapContext';
import { logout as logoutSuite } from './lib/api';
import MdBoard from './MdBoard';
import MdApproval, { type ApprovalPrefill } from './MdApproval';
import MdMoney from './MdMoney';
import MdClose from './MdClose';
import MdExpenses from './MdExpenses';
import MdRequests, { type RequestPrefill } from './MdRequests';
import MdTemplates from './MdTemplates';
import MdRecon from './MdRecon';
import CeoOverview, { WeeklyPackSection } from './CeoOverview';
import CeoHome from './CeoHome';
import MoreMenu, { type MoreMenuGroup } from './MoreMenu';
import NeeApprovalQueue from './NeeApprovalQueue';
import NeeFulfillmentQueue from './NeeFulfillmentQueue';
import NeeHome from './NeeHome';
import Settings from './Settings';

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
  | 'settings';

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
]);

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

  // A copied or stale hash must never expose a role-inappropriate primary screen.
  const roleInappropriate = isCeo
    ? view === 'approvals' || view === 'fulfillment'
    : view === 'ceo-history' || view === 'legacy-fulfillment';
  const activeView = roleInappropriate ? 'home' : view;

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

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-700">
            <Wallet size={22} />
            <span className="font-bold text-lg">Ceres</span>
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
      </header>

      <main className="max-w-5xl mx-auto p-4">
        {SECONDARY_VIEWS.has(activeView) && (
          <button
            onClick={() => setView('more')}
            className="mb-3 flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-amber-700"
          >
            <ArrowLeft size={16} /> กลับไปเมนูเพิ่มเติม
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
      </main>

      <nav aria-label="เมนูหลัก" className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]">
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
