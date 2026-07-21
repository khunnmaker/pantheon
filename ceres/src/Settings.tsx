import { useEffect, useState } from 'react';
import { Bell, CheckCircle2, Loader2, MessageCircleMore, RefreshCw } from 'lucide-react';
import { generateLineBind, getLineBind, type LineBindState } from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import CategoryAdmin from './CategoryAdmin';

// Phase 4 — optional LINE binding UI, reusing the SUITE-WIDE Agent.lineUserId/
// lineBindCode fields Apollo already writes (api/src/line/staffBind.ts). No Ceres
// action ever requires this; it only unlocks the four request-status LINE pushes
// (see api/src/ceres/notifyRequester.ts). There's no unbind endpoint yet — only
// GET/POST /api/staff/line-bind exist — so this screen shows bind state and lets the
// user (re)generate a code, matching what the backend actually supports today.

export default function Settings() {
  const { agent, bootstrap } = useCeres();
  const [state, setState] = useState<LineBindState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [genBusy, setGenBusy] = useState(false);

  function load() {
    setLoading(true);
    setError('');
    getLineBind()
      .then(setState)
      .catch(() => setError('โหลดสถานะไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function generate() {
    setGenBusy(true);
    setError('');
    try {
      const result = await generateLineBind();
      setState(result);
    } catch {
      setError('สร้างรหัสไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setGenBusy(false);
    }
  }

  const roleLabel = bootstrap.role === 'ceo' ? 'CEO' : bootstrap.role === 'gm' ? 'GM' : 'ทีมงาน';

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-semibold text-slate-500 mb-2">บัญชี</h3>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="font-semibold text-base">{agent.name}</div>
          <div className="text-sm text-slate-500">{agent.email}</div>
          <div className="text-xs text-slate-400 mt-1">สิทธิ์: {roleLabel}</div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-500">แจ้งเตือนผ่าน LINE</h3>
          <button
            onClick={load}
            disabled={loading}
            aria-label="โหลดสถานะใหม่"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-white disabled:opacity-50"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          {loading ? (
            <div className="py-6 flex justify-center text-slate-400">
              <Loader2 className="animate-spin" size={20} />
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
                  {state?.bound ? <CheckCircle2 size={20} /> : <Bell size={20} />}
                </div>
                <div className="flex-1">
                  {state?.bound ? (
                    <>
                      <div className="font-semibold text-sm text-emerald-700">ผูก LINE แล้ว</div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        รับแจ้งเตือนอัตโนมัติเมื่อคำขออนุมัติ ไม่อนุมัติ จ่ายเงิน หรือซื้อของแล้ว
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="font-semibold text-sm">ยังไม่ผูก LINE</div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        ผูกบัญชีเพื่อรับแจ้งเตือนสถานะคำขอทาง LINE — ไม่บังคับ ใช้งาน Ceres ได้ตามปกติแม้ไม่ผูก
                      </p>
                    </>
                  )}
                </div>
              </div>

              {error && <div className="text-xs text-rose-600 mt-3">{error}</div>}

              {!state?.bound && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  {state?.code ? (
                    <>
                      <p className="text-xs text-slate-500 mb-2 flex items-center gap-1">
                        <MessageCircleMore size={13} className="shrink-0" />
                        ส่งข้อความนี้ (พิมพ์ตามทุกตัวอักษร) ไปที่ LINE OA ของบริษัท
                      </p>
                      <div className="rounded-xl bg-slate-900 px-4 py-3 text-center font-mono text-lg font-bold tracking-wider text-white select-all">
                        CERES-{state.code}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-slate-500 mb-2">
                      กดสร้างรหัสผูกด้านล่าง แล้วส่งรหัสนั้นไปที่ LINE OA ของบริษัทเพื่อยืนยันตัวตน
                    </p>
                  )}
                  <button
                    onClick={generate}
                    disabled={genBusy}
                    className="w-full mt-3 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {genBusy ? <Loader2 size={15} className="animate-spin" /> : null}
                    {state?.code ? 'สร้างรหัสใหม่' : 'สร้างรหัสผูก LINE'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* GM/CEO only — messenger also reaches this Settings screen via StaffHome's own
          "ตั้งค่า" tab, so this gate is load-bearing, not decorative. */}
      {(bootstrap.role === 'gm' || bootstrap.role === 'ceo') && <CategoryAdmin />}
    </div>
  );
}
