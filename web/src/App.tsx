import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

type Health = { status: string; service?: string; time?: string };

// M0 shell — confirms the web app builds and can reach the API health check.
// The full agent console (ported from line_ai_reply_prototype.jsx) lands in M1.
export default function App() {
  const [api, setApi] = useState<'loading' | 'ok' | 'down'>('loading');
  const [detail, setDetail] = useState<Health | null>(null);

  const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

  useEffect(() => {
    fetch(`${apiUrl}/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Health) => {
        setDetail(d);
        setApi('ok');
      })
      .catch(() => setApi('down'));
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-md w-full p-6">
        <div className="flex items-center gap-2 text-teal-700 mb-1">
          <Bot size={24} />
          <h1 className="text-xl font-bold">Minerva</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">
          LINE AI Customer-Reply Assistant · <span className="font-semibold">M0 scaffold</span>
        </p>

        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          {api === 'loading' && (
            <>
              <Loader2 size={16} className="animate-spin text-slate-400" /> ตรวจสอบ API…
            </>
          )}
          {api === 'ok' && (
            <>
              <CheckCircle2 size={16} className="text-emerald-600" />
              <span className="text-emerald-700 font-medium">API ทำงานปกติ</span>
              <span className="text-slate-400 ml-auto">{detail?.service}</span>
            </>
          )}
          {api === 'down' && (
            <>
              <XCircle size={16} className="text-rose-500" />
              <span className="text-rose-600 font-medium">เชื่อมต่อ API ไม่ได้</span>
              <span className="text-slate-400 ml-auto">:3000</span>
            </>
          )}
        </div>

        <p className="text-xs text-slate-400 mt-4">
          ขั้นต่อไป (M1): พอร์ตหน้าจอคอนโซลจากต้นแบบ + LINE webhook + login + คิวงานผ่าน WebSocket
        </p>
      </div>
    </div>
  );
}
