import { useEffect, useState } from 'react';
import {
  ShieldCheck, LogIn, LogOut, Loader2, AlertTriangle, Check, X, Clock, ClipboardList,
  Users, CheckCircle2, FileText, Ban, Tags, Search, Save, ChevronLeft, ChevronRight, Trash2, KeyRound,
} from 'lucide-react';
import {
  loginStaff, setStaffSession, getStaffToken, getStoredStaff, clearStaffSession,
  adminListClinics, adminApproveClinic, adminRejectClinic, adminDeleteClinic, adminResetClinicPassword,
  adminListOrders, adminOrderTransition,
  adminListEnrichment, adminSaveEnrichment, mediaUrl, formatBaht, orderNoLabel,
  type Agent, type AdminClinic, type AdminOrder, type ClinicStatus, type OrderStatus,
  type EnrichRow, type EnrichInput,
} from './lib/api';

export default function Admin() {
  const [agent, setAgent] = useState<Agent | null>(() => (getStaffToken() ? getStoredStaff() : null));
  const [tab, setTab] = useState<'clinics' | 'orders' | 'enrichment'>('clinics');

  if (!agent) return <StaffLogin onLogin={setAgent} />;

  // Order-desk staff (a staff member with the 'diana' app grant) manage orders + product info
  // but NOT clinic approval — that unlocks pricing, so it stays supervisor-only (matches the API).
  const isSupervisor = agent.role === 'supervisor';
  const activeTab = tab === 'clinics' && !isSupervisor ? 'orders' : tab;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="flex items-center gap-2 text-indigo-700 font-bold"><ShieldCheck size={20} /> Diana · ทีมงาน</span>
          <div className="flex-1" />
          <span className="text-xs text-slate-500">{agent.name}</span>
          <button onClick={() => { clearStaffSession(); setAgent(null); }} className="text-slate-500 hover:text-rose-600"><LogOut size={18} /></button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-4">
        <div className="flex gap-1 mb-4 bg-slate-100 rounded-xl p-1 text-sm w-fit">
          {isSupervisor && <Tab active={activeTab === 'clinics'} onClick={() => setTab('clinics')} icon={<Users size={15} />}>คลินิก</Tab>}
          <Tab active={activeTab === 'orders'} onClick={() => setTab('orders')} icon={<ClipboardList size={15} />}>ออเดอร์</Tab>
          <Tab active={activeTab === 'enrichment'} onClick={() => setTab('enrichment')} icon={<Tags size={15} />}>ข้อมูลสินค้า</Tab>
        </div>
        {activeTab === 'clinics' ? <ClinicsPanel /> : activeTab === 'orders' ? <OrdersPanel /> : <EnrichmentPanel />}
      </div>
    </div>
  );
}

function Tab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg font-semibold ${active ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500'}`}>{icon}{children}</button>
  );
}

// ── Clinics (approval) ──────────────────────────────────────────────────────
function ClinicsPanel() {
  const [filter, setFilter] = useState<ClinicStatus>('pending');
  const [clinics, setClinics] = useState<AdminClinic[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  function load() {
    setClinics(null); setError('');
    adminListClinics(filter).then(({ clinics: c }) => setClinics(c)).catch(() => setError('โหลดรายการไม่สำเร็จ'));
  }
  useEffect(load, [filter]);

  async function approve(c: AdminClinic) {
    const code = window.prompt(`อนุมัติ "${c.clinicName}" — ใส่รหัสลูกค้า Express (ถ้ามี เช่น ร103) หรือเว้นว่าง:`, c.customerCode ?? '');
    if (code === null) return;
    setBusyId(c.id);
    try { await adminApproveClinic(c.id, code.trim() || undefined); load(); } catch { setError('อนุมัติไม่สำเร็จ'); } finally { setBusyId(''); }
  }
  async function reject(c: AdminClinic) {
    const note = window.prompt(`ปฏิเสธ "${c.clinicName}" — เหตุผล (ถ้ามี):`, '');
    if (note === null) return;
    setBusyId(c.id);
    try { await adminRejectClinic(c.id, note.trim()); load(); } catch { setError('ปฏิเสธไม่สำเร็จ'); } finally { setBusyId(''); }
  }
  async function del(c: AdminClinic) {
    if (!window.confirm(`ลบบัญชี "${c.clinicName}" (${c.email}) และคำสั่งซื้อทั้งหมดอย่างถาวร?\nการกระทำนี้ย้อนกลับไม่ได้ — ใช้สำหรับลบบัญชีทดสอบ`)) return;
    setBusyId(c.id);
    try { await adminDeleteClinic(c.id); load(); } catch { setError('ลบไม่สำเร็จ'); } finally { setBusyId(''); }
  }
  async function resetPw(c: AdminClinic) {
    if (!window.confirm(`รีเซ็ตรหัสผ่านของ "${c.clinicName}"?`)) return;
    setBusyId(c.id);
    try {
      const { tempPassword } = await adminResetClinicPassword(c.id);
      // window.prompt shows the value in a copyable field — staff read/paste it to the caller over LINE.
      window.prompt('รหัสผ่านชั่วคราว — คัดลอกส่งให้ลูกค้าทาง LINE:', tempPassword);
    } catch { setError('รีเซ็ตรหัสผ่านไม่สำเร็จ'); } finally { setBusyId(''); }
  }

  return (
    <>
      <FilterBar options={['pending', 'approved', 'rejected']} value={filter} onChange={(v) => setFilter(v as ClinicStatus)} labels={{ pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ปฏิเสธ' }} />
      {error && <ErrorLine>{error}</ErrorLine>}
      {!clinics ? <Spinner /> : clinics.length === 0 ? <Empty>ไม่มีรายการ</Empty> : (
        <div className="space-y-2">
          {clinics.map((c) => (
            <div key={c.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{c.clinicName} {c.customerCode && <span className="text-xs text-indigo-600 font-mono">({c.customerCode})</span>}</div>
                <div className="text-xs text-slate-500">{c.contactName} · {c.phone || '—'} · {c.email}</div>
                <div className="text-xs text-slate-400 mt-0.5">สมัคร {new Date(c.createdAt).toLocaleString('th-TH')}{c.pdpaConsentAt ? ' · ยินยอม PDPA' : ''}</div>
                {c.status === 'rejected' && c.rejectNote && <div className="text-xs text-rose-500 mt-0.5">เหตุผล: {c.rejectNote}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {c.status === 'pending' ? (
                  <>
                    <button disabled={busyId === c.id} onClick={() => approve(c)} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm flex items-center gap-1 disabled:opacity-50"><Check size={15} /> อนุมัติ</button>
                    <button disabled={busyId === c.id} onClick={() => reject(c)} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-sm flex items-center gap-1 disabled:opacity-50"><X size={15} /> ปฏิเสธ</button>
                  </>
                ) : (
                  <StatusChip status={c.status} />
                )}
                <button disabled={busyId === c.id} onClick={() => resetPw(c)} title="รีเซ็ตรหัสผ่าน" aria-label="รีเซ็ตรหัสผ่าน" className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"><KeyRound size={16} /></button>
                <button disabled={busyId === c.id} onClick={() => del(c)} title="ลบบัญชี (ถาวร)" aria-label="ลบบัญชี" className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function StatusChip({ status }: { status: ClinicStatus }) {
  const m: Record<ClinicStatus, { t: string; c: string; i: React.ReactNode }> = {
    pending: { t: 'รออนุมัติ', c: 'bg-amber-50 text-amber-700', i: <Clock size={13} /> },
    approved: { t: 'อนุมัติแล้ว', c: 'bg-emerald-50 text-emerald-700', i: <Check size={13} /> },
    rejected: { t: 'ปฏิเสธ', c: 'bg-slate-100 text-slate-500', i: <X size={13} /> },
  };
  const s = m[status];
  return <span className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 shrink-0 ${s.c}`}>{s.i}{s.t}</span>;
}

// ── Orders (queue) ──────────────────────────────────────────────────────────
function OrdersPanel() {
  const [filter, setFilter] = useState<OrderStatus>('submitted');
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  function load() {
    setOrders(null); setError('');
    adminListOrders(filter).then(({ orders: o }) => setOrders(o)).catch(() => setError('โหลดออเดอร์ไม่สำเร็จ'));
  }
  useEffect(load, [filter]);

  async function act(id: string, action: 'confirm' | 'invoice' | 'cancel') {
    setBusyId(id);
    try { await adminOrderTransition(id, action); load(); } catch { setError('ทำรายการไม่สำเร็จ'); } finally { setBusyId(''); }
  }

  return (
    <>
      <FilterBar options={['submitted', 'confirmed', 'invoiced', 'cancelled']} value={filter} onChange={(v) => setFilter(v as OrderStatus)} labels={{ submitted: 'รอยืนยัน', confirmed: 'ยืนยันแล้ว', invoiced: 'ออกใบแจ้งหนี้', cancelled: 'ยกเลิก' }} />
      {error && <ErrorLine>{error}</ErrorLine>}
      {!orders ? <Spinner /> : orders.length === 0 ? <Empty>ไม่มีออเดอร์</Empty> : (
        <div className="space-y-2">
          {orders.map((o) => {
            const known = o.lines.filter((l) => l.unitPrice > 0).reduce((s, l) => s + l.unitPrice * l.qty, 0);
            return (
              <div key={o.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-1">
                  <div className="font-semibold">{o.clinicAccount.clinicName} {o.clinicAccount.customerCode && <span className="text-xs text-indigo-600 font-mono">({o.clinicAccount.customerCode})</span>}</div>
                  <div className="text-xs text-slate-400 font-mono">{orderNoLabel(o.orderNo, o.id)}</div>
                </div>
                <div className="text-xs text-slate-500 mb-2">{o.clinicAccount.email} · {new Date(o.createdAt).toLocaleString('th-TH')}</div>
                <div className="space-y-0.5 mb-2">
                  {o.lines.map((l) => (
                    <div key={l.id} className="flex justify-between text-sm">
                      <span className="text-slate-600"><span className="font-mono text-xs text-slate-400">{l.sku}</span> {l.nameSnapshot} ×{l.qty}</span>
                      <span className="text-slate-500">{l.unitPrice > 0 ? formatBaht(l.unitPrice * l.qty) : 'รอยืนยัน'}</span>
                    </div>
                  ))}
                </div>
                {(o.taxName || o.taxId) && <div className="text-xs text-slate-400 mb-1">ใบกำกับ: {o.taxName} {o.taxId} {o.taxAddress}</div>}
                {o.note && <div className="text-xs text-slate-400 mb-2">หมายเหตุ: {o.note}</div>}
                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <span className="text-sm font-semibold">รวม (ที่ทราบ) {formatBaht(known)}</span>
                  <div className="flex gap-2">
                    {o.status === 'submitted' && (
                      <button disabled={busyId === o.id} onClick={() => act(o.id, 'confirm')} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm flex items-center gap-1 disabled:opacity-50"><CheckCircle2 size={15} /> ยืนยัน</button>
                    )}
                    {o.status === 'confirmed' && (
                      <button disabled={busyId === o.id} onClick={() => act(o.id, 'invoice')} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm flex items-center gap-1 disabled:opacity-50"><FileText size={15} /> ออกใบแจ้งหนี้</button>
                    )}
                    {(o.status === 'submitted' || o.status === 'confirmed') && (
                      <button disabled={busyId === o.id} onClick={() => act(o.id, 'cancel')} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-sm flex items-center gap-1 disabled:opacity-50"><Ban size={15} /> ยกเลิก</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Enrichment editor (brand/category/description per product) ──────────────
function EnrichmentPanel() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<EnrichRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  function load() {
    setRows(null); setError('');
    adminListEnrichment({ q: debounced, page, pageSize: 20 })
      .then((d) => { setRows(d.items); setTotal(d.total); })
      .catch(() => setError('โหลดรายการไม่สำเร็จ'));
  }
  useEffect(load, [debounced, page]);
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <>
      <div className="relative mb-3 max-w-md">
        <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาสินค้า / รหัส เพื่อแก้ไขแบรนด์·หมวดหมู่·คำอธิบาย" className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty>ไม่พบสินค้า</Empty> : (
        <>
          <div className="space-y-2">
            {rows.map((r) => <EnrichRowCard key={r.sku} row={r} onSaved={load} />)}
          </div>
          <div className="flex items-center justify-center gap-3 py-4 text-sm">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="p-2 rounded-lg border border-slate-300 disabled:opacity-40"><ChevronLeft size={16} /></button>
            <span className="text-slate-500">หน้า {page} / {totalPages} · {total} รายการ</span>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="p-2 rounded-lg border border-slate-300 disabled:opacity-40"><ChevronRight size={16} /></button>
          </div>
        </>
      )}
    </>
  );
}

function EnrichRowCard({ row, onSaved }: { row: EnrichRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(row.brand);
  const [category, setCategory] = useState(row.category);
  const [categoryEn, setCategoryEn] = useState(row.categoryEn);
  const [descTh, setDescTh] = useState(row.descriptionTh);
  const [descEn, setDescEn] = useState(row.descriptionEn);
  const [specs, setSpecs] = useState(row.specs.join('\n'));
  const [warningTh, setWarningTh] = useState(row.warningTh);
  const [warningEn, setWarningEn] = useState(row.warningEn);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true); setSaved(false);
    const input: EnrichInput = {
      brand: brand.trim(), category: category.trim(), categoryEn: categoryEn.trim(),
      descriptionTh: descTh.trim(), descriptionEn: descEn.trim(),
      specs: specs.split('\n').map((s) => s.trim()).filter(Boolean),
      warningTh: warningTh.trim(), warningEn: warningEn.trim(),
    };
    try { await adminSaveEnrichment(row.sku, input); setSaved(true); onSaved(); } catch { /* surfaced by list reload */ } finally { setBusy(false); }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 text-left">
        <img src={mediaUrl(row.photo)} alt="" onError={(e) => { (e.currentTarget.style.visibility = 'hidden'); }} className="w-12 h-12 rounded-lg object-contain bg-slate-50 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-mono text-slate-400">{row.sku} · {formatBaht(row.price)}</div>
          <div className="text-sm line-clamp-1">{row.nameTh || row.nameEn}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {row.brand && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">{row.brand}</span>}
            {row.category ? <span className="text-[10px] text-slate-500">{row.category}</span> : <span className="text-[10px] text-amber-600">ยังไม่จัดหมวด</span>}
            {row.source === 'manual' && <span className="text-[10px] text-emerald-600">· แก้ด้วยมือ</span>}
            {row.warningTh && <span className="text-[10px] text-amber-700">· ⚠ มีคำเตือน</span>}
          </div>
        </div>
        <span className="text-xs text-slate-400 shrink-0">{open ? 'ปิด' : 'แก้ไข'}</span>
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2">
          <EField label="แบรนด์"><input value={brand} onChange={(e) => setBrand(e.target.value)} className={efCls} /></EField>
          <EField label="หมวดหมู่ (ไทย)"><input value={category} onChange={(e) => setCategory(e.target.value)} className={efCls} /></EField>
          <EField label="หมวดหมู่ (อังกฤษ/SEO)"><input value={categoryEn} onChange={(e) => setCategoryEn(e.target.value)} className={efCls} /></EField>
          <div />
          <EField label="คำอธิบาย (ไทย)" full><textarea value={descTh} onChange={(e) => setDescTh(e.target.value)} rows={2} className={efCls} /></EField>
          <EField label="คำอธิบาย (อังกฤษ)" full><textarea value={descEn} onChange={(e) => setDescEn(e.target.value)} rows={2} className={efCls} /></EField>
          <EField label="สเปก (บรรทัดละ 1 ข้อ)" full><textarea value={specs} onChange={(e) => setSpecs(e.target.value)} rows={3} className={efCls} /></EField>
          <EField label="สิ่งที่ควรรู้ (TH)" full><textarea value={warningTh} onChange={(e) => setWarningTh(e.target.value)} rows={2} placeholder="แสดงเป็นข้อความเตือนสีเหลืองอำพันบนหน้าร้านค้า — เว้นว่างถ้าไม่มี" className={efCls} /></EField>
          <EField label="สิ่งที่ควรรู้ (EN)" full><textarea value={warningEn} onChange={(e) => setWarningEn(e.target.value)} rows={2} placeholder="Shown as an amber warning callout on the storefront — leave blank if none" className={efCls} /></EField>
          <div className="col-span-2 flex items-center gap-2">
            <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm flex items-center gap-1 disabled:opacity-50">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} บันทึก
            </button>
            {saved && <span className="text-emerald-600 text-xs flex items-center gap-1"><Check size={13} /> บันทึกแล้ว</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const efCls = 'w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400';
function EField({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">{label}</label>
      {children}
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────
function FilterBar<T extends string>({ options, value, onChange, labels }: { options: T[]; value: T; onChange: (v: T) => void; labels: Record<string, string> }) {
  return (
    <div className="flex gap-2 mb-3 text-sm flex-wrap">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={`px-3 py-1 rounded-full ${value === o ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-300 text-slate-600'}`}>{labels[o]}</button>
      ))}
    </div>
  );
}
const Spinner = () => <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" /></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-center text-slate-400 py-12 text-sm">{children}</p>;
const ErrorLine = ({ children }: { children: React.ReactNode }) => <div className="flex items-center gap-1 text-rose-600 text-sm mb-3"><AlertTriangle size={14} /> {children}</div>;

// ── Staff login ─────────────────────────────────────────────────────────────
function StaffLogin({ onLogin }: { onLogin: (a: Agent) => void }) {
  const [email, setEmail] = useState('drm@prominent.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!email.trim() || !password || busy) return;
    setBusy(true); setError('');
    try {
      const { token, agent } = await loginStaff(email.trim(), password);
      setStaffSession(token, agent);
      onLogin(agent);
    } catch {
      setError('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-indigo-700 mb-1"><ShieldCheck size={24} /><h1 className="text-xl font-bold">Diana · ทีมงาน</h1></div>
        <p className="text-sm text-slate-500 mb-5">อนุมัติคลินิก + จัดการออเดอร์ · เข้าสู่ระบบ</p>
        <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
        <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
        {error && <div className="flex items-center gap-1 text-rose-600 text-xs mb-3"><AlertTriangle size={13} /> {error}</div>}
        <button onClick={submit} disabled={busy} className="w-full px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
        </button>
      </div>
    </div>
  );
}
