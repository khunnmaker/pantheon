import { useEffect, useState } from 'react';
import { Loader2, Plus, Search, AlertTriangle, Check, X, Pencil, Trash2 } from 'lucide-react';
import {
  getVendors,
  createVendor,
  patchVendor,
  deleteVendor,
  type Vendor,
  type VendorInput,
} from '../lib/api';

// Vendors master — list + create/edit/delete. LOCAL-ONLY (vendor names/emails are secret).
export default function Vendors() {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  async function load(query = q) {
    setError('');
    try {
      const { vendors } = await getVendors(query);
      setVendors(vendors);
    } catch {
      setError('โหลดผู้ขายไม่สำเร็จ');
      setVendors([]);
    }
  }
  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(v: Vendor) {
    if (!confirm(`ลบผู้ขาย "${v.name}"?`)) return;
    setError('');
    try {
      await deleteVendor(v.id);
      void load();
    } catch (e) {
      setError(e instanceof Error && e.message === 'vendor in use' ? 'ลบไม่ได้ — มีรายการ/ใบสั่งซื้ออ้างอิงผู้ขายนี้' : 'ลบไม่สำเร็จ');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="ค้นหาชื่อ / อีเมล / ประเทศ"
            className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        <button
          onClick={() => {
            setCreating(true);
            setEditId(null);
          }}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
        >
          <Plus size={15} /> เพิ่มผู้ขาย
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {creating && (
        <VendorForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {vendors === null ? (
        <div className="py-12 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : vendors.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400">ยังไม่มีผู้ขาย</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">ชื่อ</th>
                  <th className="text-left font-medium px-3 py-2">อีเมล</th>
                  <th className="text-left font-medium px-3 py-2">ประเทศ</th>
                  <th className="text-left font-medium px-3 py-2">ผู้ติดต่อ</th>
                  <th className="text-right font-medium px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) =>
                  editId === v.id ? (
                    <tr key={v.id} className="border-t border-slate-100 bg-orange-50/40">
                      <td colSpan={5} className="px-3 py-2">
                        <VendorForm
                          vendor={v}
                          onCancel={() => setEditId(null)}
                          onSaved={() => {
                            setEditId(null);
                            void load();
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={v.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        {v.name}
                        {v.isTaiwan && (
                          <span className="ml-2 text-xs rounded-full bg-amber-100 text-amber-700 px-2 py-0.5">
                            ไต้หวัน
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{v.email || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{v.country || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{v.contactName || '—'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => {
                            setEditId(v.id);
                            setCreating(false);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-orange-700 mr-3"
                        >
                          <Pencil size={13} /> แก้ไข
                        </button>
                        <button
                          onClick={() => remove(v)}
                          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-rose-600"
                        >
                          <Trash2 size={13} /> ลบ
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function VendorForm({
  vendor,
  onCancel,
  onSaved,
}: {
  vendor?: Vendor;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<VendorInput>({
    name: vendor?.name ?? '',
    email: vendor?.email ?? '',
    ccList: vendor?.ccList ?? '',
    country: vendor?.country ?? '',
    isTaiwan: vendor?.isTaiwan ?? false,
    contactName: vendor?.contactName ?? '',
    terms: vendor?.terms ?? '',
    notes: vendor?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof VendorInput>(k: K, v: VendorInput[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  async function save() {
    if (!f.name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      if (vendor) await patchVendor(vendor.id, f);
      else await createVendor(f);
      onSaved();
    } catch {
      setError('บันทึกไม่สำเร็จ');
      setBusy(false);
    }
  }

  const input =
    'w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400';
  const lbl = 'block text-xs font-semibold text-slate-500 mb-1';

  return (
    <div className={vendor ? '' : 'bg-white rounded-xl border border-slate-200 p-3 mb-3'}>
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <label className={lbl}>ชื่อผู้ขาย *</label>
          <input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} className={input} />
        </div>
        <div>
          <label className={lbl}>อีเมล</label>
          <input value={f.email} onChange={(e) => set('email', e.target.value)} className={input} />
        </div>
        <div>
          <label className={lbl}>CC (คั่นด้วยจุลภาค)</label>
          <input value={f.ccList} onChange={(e) => set('ccList', e.target.value)} className={input} />
        </div>
        <div>
          <label className={lbl}>ประเทศ</label>
          <input value={f.country} onChange={(e) => set('country', e.target.value)} className={input} />
        </div>
        <div>
          <label className={lbl}>ผู้ติดต่อ</label>
          <input value={f.contactName} onChange={(e) => set('contactName', e.target.value)} className={input} />
        </div>
        <div>
          <label className={lbl}>เงื่อนไข (terms)</label>
          <input value={f.terms} onChange={(e) => set('terms', e.target.value)} className={input} />
        </div>
        <div className="sm:col-span-2">
          <label className={lbl}>หมายเหตุ</label>
          <textarea
            value={f.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={2}
            className={input}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 mt-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={f.isTaiwan}
          onChange={(e) => set('isTaiwan', e.target.checked)}
        />
        ผู้ขายไต้หวัน (แยก normal / special ในใบสั่งซื้อ)
      </label>
      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mt-2">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={save}
          disabled={busy || !f.name.trim()}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} บันทึก
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-slate-500 hover:bg-slate-100 text-sm"
        >
          <X size={14} /> ยกเลิก
        </button>
      </div>
    </div>
  );
}
