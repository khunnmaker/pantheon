import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { getBootstrap, clearSession, type Agent, type Bootstrap } from './lib/api';
import { CeresContext } from './lib/bootstrapContext';
import MessengerHome from './Messenger';
import MdApp from './Md';

export default function Ceres({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refreshBootstrap = useCallback(() => {
    setLoading(true);
    setError('');
    getBootstrap()
      .then(setBootstrap)
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshBootstrap();
  }, [refreshBootstrap]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center font-sans text-slate-800">
        <Loader2 className="animate-spin text-amber-600" size={28} />
      </div>
    );
  }

  if (error || !bootstrap) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center gap-3 font-sans text-slate-800 px-4">
        <div className="flex items-center gap-1 text-rose-600 text-sm">
          <AlertTriangle size={16} /> {error || 'โหลดข้อมูลไม่สำเร็จ'}
        </div>
        <button
          onClick={refreshBootstrap}
          className="flex items-center gap-1 px-4 py-2 rounded-xl bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700"
        >
          <RefreshCw size={15} /> ลองใหม่
        </button>
        <button
          onClick={() => {
            clearSession();
            onLogout();
          }}
          className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
        >
          ออกจากระบบ
        </button>
      </div>
    );
  }

  return (
    <CeresContext.Provider value={{ agent, bootstrap, onLogout, refreshBootstrap }}>
      {bootstrap.role === 'messenger' ? <MessengerHome /> : <MdApp />}
    </CeresContext.Provider>
  );
}
