import { useEffect, useState } from 'react';
import { Crown, LogOut, Loader2, ExternalLink } from 'lucide-react';
import { clearSession, getBadges, type Agent, type Badges } from './lib/api';
import { tilesFor, type AppDef } from './lib/apps';

// The portal home: a tile grid, one tile per app this account is GRANTED (with a configured
// URL), each showing the deity name + Thai job label + a live pending-work badge. A tile opens
// the app's URL in the same tab. Tiles are grant-gated (tilesFor) so they match the caller's
// badges exactly. Phase 1: apps still ask for their own login when opened (SSO is Phase 3).
export default function Portal({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [badges, setBadges] = useState<Badges | null>(null);
  const [loading, setLoading] = useState(true);
  const tiles = tilesFor(agent);

  useEffect(() => {
    let alive = true;
    const load = () => getBadges()
      .then((b) => { if (alive) setBadges(b); })
      .catch(() => { /* badges are a hint; a fetch failure just shows no counts */ })
      .finally(() => { if (alive) setLoading(false); });
    load();
    // Refresh in the background so the counts stay fresh while the portal sits open.
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  function logout() {
    clearSession();
    onLogout();
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 to-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-violet-100 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-violet-700">
            <Crown size={22} />
            <span className="font-bold text-lg">The Pantheon</span>
            <span className="text-slate-400 text-sm hidden sm:inline">· พอร์ทัลทีมงาน</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500">{agent.name}</span>
            <button onClick={logout} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 sm:p-6">
        <p className="text-sm text-slate-500 mb-4">เลือกแอปที่ต้องการเปิด</p>
        {loading && !badges && (
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-4">
            <Loader2 size={15} className="animate-spin" /> กำลังโหลดงานที่ค้าง…
          </div>
        )}
        {tiles.length === 0 ? (
          <div className="text-slate-500 text-sm bg-white rounded-2xl border border-slate-200 p-6 text-center">
            ยังไม่มีแอปที่เปิดให้บัญชีนี้ (โปรดตั้งค่า URL ของแอปในระบบ)
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {tiles.map((app) => <Tile key={app.key} app={app} badges={badges} />)}
          </div>
        )}
      </main>
    </div>
  );
}

function Tile({ app, badges }: { app: AppDef; badges: Badges | null }) {
  const count = badges ? app.badge(badges) : null;
  return (
    <a
      href={app.url}
      className="group bg-white rounded-2xl border border-slate-200 hover:border-violet-300 hover:shadow-sm p-4 flex items-center gap-4 transition"
    >
      <div className={`w-11 h-11 rounded-xl bg-slate-50 flex items-center justify-center font-bold text-lg ${app.accent}`}>
        {app.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`font-bold ${app.accent}`}>{app.name}</span>
          <ExternalLink size={13} className="text-slate-300 group-hover:text-violet-400" />
        </div>
        <div className="text-xs text-slate-500 truncate">{app.job}</div>
      </div>
      {typeof count === 'number' && count > 0 && (
        <span className="shrink-0 min-w-[1.5rem] h-6 px-2 rounded-full bg-rose-100 text-rose-700 text-xs font-bold flex items-center justify-center">
          {count}
        </span>
      )}
    </a>
  );
}
