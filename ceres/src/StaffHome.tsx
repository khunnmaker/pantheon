import { useEffect, useState } from 'react';
import { Crown, Home, ListChecks, LogOut, MoreHorizontal, Search, Send, Settings as SettingsIcon, Wallet } from 'lucide-react';
import { useHashTab } from '@pantheon/ui';
import { logout as logoutSuite, type StaffRequest } from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import MyRequests from './MyRequests';
import RequestSheet from './RequestSheet';
import RequestDetail from './RequestDetail';
import MoreMenu from './MoreMenu';
import Settings from './Settings';
import MessengerHome from './Messenger';

// Phase 4 — the staff front door. Replaces the old horizontally-scrolling tab bar with
// ONE primary action ("ส่งคำขอเงิน") plus recent requests, a searchable full history, a
// grouped "More" for the legacy advance-receipt flow, and LINE-binding Settings. See
// docs/CERES_REVAMP_PLAN.md "Phase 4" — Staff frontend screens + acceptance criteria.

const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? 'https://pantheon.prominentdental.com';

type View = 'home' | 'mine' | 'more' | 'settings' | 'legacy';

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
  const { bootstrap, onLogout } = useCeres();
  const viewKeys: View[] = ['home', 'mine', 'more', 'settings', 'legacy'];
  const [view, setView] = useHashTab<View>(viewKeys, 'home');
  const activeView = embeddedView ?? view;

  const [requestSheetOpen, setRequestSheetOpen] = useState(openRequestOnMount);
  const [editingRequest, setEditingRequest] = useState<StaffRequest | null>(null);
  const [requestReloadKey, setRequestReloadKey] = useState(0);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState('');
  const [search, setSearch] = useState('');

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

  return (
    <div className={embeddedView ? '' : 'min-h-screen bg-slate-100 font-sans text-slate-800 pb-20'}>
      {!embeddedView && <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-amber-700 min-w-0">
            <Wallet size={20} className="shrink-0" />
            <span className="font-bold text-base truncate">{bootstrap.party?.name || bootstrap.agent.name}</span>
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

            <MyRequests
              title="คำขอล่าสุด"
              reloadKey={requestReloadKey}
              limit={5}
              onEdit={openEdit}
              onOpenDetail={openDetail}
              onOpenSettings={() => onOpenSettings ? onOpenSettings() : setView('settings')}
            />

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

        {activeView === 'more' && (
          <MoreMenu
            groups={[
              {
                items: [
                  {
                    key: 'legacy',
                    label: 'ค่าใช้จ่ายเงินเบิกเดิม',
                    sub: 'บันทึกค่าใช้จ่ายหรือใบเสร็จจากเงินที่รับไปแล้ว',
                    icon: <ListChecks size={17} />,
                    onClick: () => setView('legacy'),
                  },
                ],
              },
            ]}
          />
        )}

        {activeView === 'settings' && <Settings />}
      </main>

      {activeView === 'legacy' && <MessengerHome embedded onBack={() => setView('more')} />}

      {/* bottom nav — 4 items, persistent labels + ARIA names (fixes the old scroller's a11y gap) */}
      {!embeddedView && <nav
        aria-label="เมนูหลัก"
        className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="max-w-md mx-auto grid grid-cols-4">
          <NavButton active={view === 'home'} label="หน้าแรก" icon={<Home size={20} />} onClick={() => setView('home')} />
          <NavButton active={view === 'mine'} label="คำขอของฉัน" icon={<ListChecks size={20} />} onClick={() => setView('mine')} />
          <NavButton active={view === 'more' || view === 'legacy'} label="เพิ่มเติม" icon={<MoreHorizontal size={20} />} onClick={() => setView('more')} />
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
