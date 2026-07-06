import { useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  Check,
  Cloud,
  CloudOff,
  RefreshCw,
  PackagePlus,
  Link2,
  Unlink,
} from 'lucide-react';
import {
  getConnection,
  connect,
  disconnect,
  sync,
  getResolvePreview,
  buildPos,
  type ConnectionStatus,
  type ResolvedLine,
  type UnresolvedLine,
  type UnresolvedReason,
} from '../lib/api';

// Sync — cloud connection + pull → resolve preview → build POs. This is the local node's only
// window to the cloud. Owner-only: authenticates by reusing his suite (supervisor) login.
const REASON_LABEL: Record<UnresolvedReason, string> = {
  needs_mapping: 'ต้องแมป (สินค้าทั่วไป — ยังไม่รู้ผู้ขาย)',
  unmapped_secret: 'ความลับยังไม่ได้แมป — เพิ่ม SecretMap ก่อน',
  unknown: 'ข้อมูลไม่ครบ',
};

export default function Sync() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [usingFixture, setUsingFixture] = useState(false);
  const [resolved, setResolved] = useState<ResolvedLine[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedLine[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function loadStatus() {
    try {
      const { status, usingFixture } = await getConnection();
      setStatus(status);
      setUsingFixture(usingFixture);
    } catch {
      setError('โหลดสถานะการเชื่อมต่อไม่สำเร็จ');
    }
  }
  async function loadPreview() {
    try {
      const { resolved, unresolved } = await getResolvePreview();
      setResolved(resolved);
      setUnresolved(unresolved);
    } catch {
      /* preview optional */
    }
  }
  useEffect(() => {
    void loadStatus();
    void loadPreview();
  }, []);

  async function doSync() {
    setBusy('sync');
    setError('');
    setMsg('');
    try {
      const r = await sync();
      setMsg(`ซิงค์แล้ว: ${r.synced} คำขอ${r.pruned ? ` (ลบค้าง ${r.pruned})` : ''}${r.usingFixture ? ' — ใช้ fixture' : ''}`);
      await loadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ซิงค์ไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  async function doBuild() {
    setBusy('build');
    setError('');
    setMsg('');
    try {
      const r = await buildPos();
      setMsg(
        `สร้างใบสั่งซื้อ ${r.created.length} ใบ (แยกตามผู้ขาย)${
          r.unresolvedCount ? ` · ยังแก้ไม่ได้ ${r.unresolvedCount} รายการ` : ''
        } — ดูที่แท็บ "ใบสั่งซื้อ"`,
      );
      await loadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'สร้างใบสั่งซื้อไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  async function doDisconnect() {
    if (!confirm('ตัดการเชื่อมต่อ cloud และลบ token ที่เก็บไว้?')) return;
    try {
      await disconnect();
      await loadStatus();
    } catch {
      setError('ตัดการเชื่อมต่อไม่สำเร็จ');
    }
  }

  return (
    <div className="space-y-4">
      {/* Connection card */}
      <ConnectionCard
        status={status}
        usingFixture={usingFixture}
        onConnected={loadStatus}
        onDisconnect={doDisconnect}
      />

      {/* Actions */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={doSync}
            disabled={busy !== null || (!status?.connected && !usingFixture)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'sync' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            ซิงค์คำขอจาก cloud
          </button>
          <button
            onClick={doBuild}
            disabled={busy !== null || resolved.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy === 'build' ? <Loader2 size={15} className="animate-spin" /> : <PackagePlus size={15} />}
            สร้างใบสั่งซื้อจากคำขอ
          </button>
          {!status?.connected && !usingFixture && (
            <span className="text-xs text-slate-400">เชื่อมต่อ cloud ก่อนจึงจะซิงค์ได้</span>
          )}
        </div>
        {msg && (
          <div className="flex items-center gap-1 text-emerald-700 text-sm mt-3">
            <Check size={14} /> {msg}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-sm mt-3">
            <AlertTriangle size={14} /> {error}
          </div>
        )}
      </div>

      {/* Resolve preview */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="font-semibold text-sm text-slate-700 mb-2">
            แก้ alias ได้แล้ว ({resolved.length}) — จะจัดกลุ่มตามผู้ขาย
          </div>
          {resolved.length === 0 ? (
            <div className="text-xs text-slate-400 py-4 text-center">ยังไม่มี — ซิงค์ก่อน</div>
          ) : (
            <ul className="text-sm divide-y divide-slate-100">
              {resolved.map((l) => (
                <li key={l.cloudRequestId} className="py-1.5 flex items-center justify-between gap-2">
                  <span className="truncate">
                    {l.realName}
                    {l.classification === 'special' && (
                      <span className="ml-1.5 text-xs rounded bg-purple-100 text-purple-700 px-1.5">
                        special
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {l.vendorName} · x{l.qty || '?'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-xl border border-rose-200 p-4">
          <div className="font-semibold text-sm text-rose-700 mb-2">
            ยังแก้ไม่ได้ ({unresolved.length}) — ไม่ถูกทิ้ง ต้องจัดการก่อน
          </div>
          {unresolved.length === 0 ? (
            <div className="text-xs text-slate-400 py-4 text-center">ไม่มีปัญหา</div>
          ) : (
            <ul className="text-sm divide-y divide-rose-50">
              {unresolved.map((l) => (
                <li key={l.cloudRequestId} className="py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{l.displayName}</span>
                    <span className="text-xs text-slate-500 whitespace-nowrap">x{l.qty || '?'}</span>
                  </div>
                  <div className="text-xs text-rose-600">{REASON_LABEL[l.reason]}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectionCard({
  status,
  usingFixture,
  onConnected,
  onDisconnect,
}: {
  status: ConnectionStatus | null;
  usingFixture: boolean;
  onConnected: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await connect({ baseUrl: baseUrl.trim(), email: email.trim(), password });
      setPassword('');
      setOpen(false);
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'เชื่อมต่อไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  const input =
    'w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400';
  const lbl = 'block text-xs font-semibold text-slate-500 mb-1';

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {status?.connected ? (
            <Cloud size={18} className="text-emerald-600" />
          ) : (
            <CloudOff size={18} className="text-slate-400" />
          )}
          <div>
            <div className="font-semibold text-sm text-slate-700">
              {status?.connected ? 'เชื่อมต่อ cloud แล้ว' : 'ยังไม่ได้เชื่อมต่อ cloud'}
              {usingFixture && (
                <span className="ml-2 text-xs rounded bg-amber-100 text-amber-700 px-1.5 py-0.5">
                  fixture mode
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500">
              {status?.connected
                ? `${status.baseUrl}${status.agentName ? ` · ${status.agentName}` : ''}`
                : usingFixture
                  ? 'อ่านจากไฟล์ fixture (ทดสอบออฟไลน์)'
                  : 'ใส่ URL ของ api และเข้าสู่ระบบด้วยบัญชี supervisor'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status?.connected ? (
            <button
              onClick={onDisconnect}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600"
            >
              <Unlink size={13} /> ตัดการเชื่อมต่อ
            </button>
          ) : (
            <button
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
            >
              <Link2 size={14} /> เชื่อมต่อ
            </button>
          )}
        </div>
      </div>

      {open && !status?.connected && (
        <div className="mt-3 pt-3 border-t border-slate-100 grid sm:grid-cols-2 gap-2">
          <div className="sm:col-span-2">
            <label className={lbl}>Cloud API base URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-minerva-api.up.railway.app"
              className={input}
            />
          </div>
          <div>
            <label className={lbl}>อีเมล (supervisor)</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          </div>
          <div>
            <label className={lbl}>รหัสผ่าน</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          {error && (
            <div className="sm:col-span-2 flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={13} /> {error}
            </div>
          )}
          <div className="sm:col-span-2">
            <button
              onClick={submit}
              disabled={busy || !baseUrl.trim() || !email.trim() || !password}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} เข้าสู่ระบบ &amp; บันทึก
            </button>
            <span className="ml-2 text-xs text-slate-400">
              รหัสผ่านไม่ถูกเก็บ — เก็บเฉพาะ token ในไฟล์ในเครื่อง
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
