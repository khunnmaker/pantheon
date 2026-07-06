import { useEffect, useState } from 'react';
import { Loader2, Plus, Search, AlertTriangle, Check, X, Pencil, Trash2 } from 'lucide-react';
import {
  getItems,
  getVendors,
  createItem,
  patchItem,
  deleteItem,
  flatSku,
  type SecretItem,
  type Vendor,
  type ItemInput,
} from '../lib/api';

// Items / Secret map — the alias(cloudItemId) → real item map. LOCAL-ONLY: this is the core
// secret table (real name, vendor, real SKU, cost). Dash-insensitive SKU search.
export default function Items() {
  const [items, setItems] = useState<SecretItem[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  async function load(query = q) {
    setError('');
    try {
      const { items } = await getItems(query);
      setItems(items);
    } catch {
      setError('โหลดรายการไม่สำเร็จ');
      setItems([]);
    }
  }
  async function loadVendors() {
    try {
      const { vendors } = await getVendors('');
      setVendors(vendors);
    } catch {
      /* handled by form emptiness */
    }
  }
  useEffect(() => {
    void load('');
    void loadVendors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(it: SecretItem) {
    if (!confirm(`ลบการแมป "${it.realName}"?`)) return;
    try {
      await deleteItem(it.id);
      void load();
    } catch {
      setError('ลบไม่สำเร็จ');
    }
  }

  const noVendors = vendors.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="ค้นหาชื่อจริง / รหัส / ผู้ขาย"
            className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        <button
          onClick={() => {
            setCreating(true);
            setEditId(null);
          }}
          disabled={noVendors}
          title={noVendors ? 'เพิ่มผู้ขายก่อน' : ''}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold disabled:opacity-50"
        >
          <Plus size={15} /> เพิ่มการแมป
        </button>
      </div>

      {noVendors && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
          ยังไม่มีผู้ขาย — ไปที่แท็บ “ผู้ขาย” เพื่อเพิ่มก่อน แล้วจึงแมปรายการเข้ากับผู้ขายได้
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {creating && (
        <ItemForm
          vendors={vendors}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {items === null ? (
        <div className="py-12 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400">ยังไม่มีการแมป</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">ชื่อจริง</th>
                  <th className="text-left font-medium px-3 py-2">รหัสลับ (cloud)</th>
                  <th className="text-left font-medium px-3 py-2">รหัสจริง</th>
                  <th className="text-left font-medium px-3 py-2">ผู้ขาย</th>
                  <th className="text-right font-medium px-3 py-2">ต้นทุน</th>
                  <th className="text-left font-medium px-3 py-2">ประเภท</th>
                  <th className="text-right font-medium px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) =>
                  editId === it.id ? (
                    <tr key={it.id} className="border-t border-slate-100 bg-orange-50/40">
                      <td colSpan={7} className="px-3 py-2">
                        <ItemForm
                          item={it}
                          vendors={vendors}
                          onCancel={() => setEditId(null)}
                          onSaved={() => {
                            setEditId(null);
                            void load();
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={it.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">{it.realName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{it.cloudItemId}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">
                        {it.realSku ? flatSku(it.realSku) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{it.vendor?.name ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {it.unitCost ? `${it.unitCost} ${it.currency}` : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {it.classification === 'special' ? (
                          <span className="text-xs rounded-full bg-rose-100 text-rose-700 px-2 py-0.5">
                            special
                          </span>
                        ) : (
                          <span className="text-xs rounded-full bg-slate-100 text-slate-500 px-2 py-0.5">
                            normal
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => {
                            setEditId(it.id);
                            setCreating(false);
                          }}
                          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-orange-700 mr-3"
                        >
                          <Pencil size={13} /> แก้ไข
                        </button>
                        <button
                          onClick={() => remove(it)}
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

function ItemForm({
  item,
  vendors,
  onCancel,
  onSaved,
}: {
  item?: SecretItem;
  vendors: Vendor[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<ItemInput>({
    cloudItemId: item?.cloudItemId ?? '',
    realName: item?.realName ?? '',
    vendorId: item?.vendorId ?? vendors[0]?.id ?? '',
    realSku: item?.realSku ?? '',
    unitCost: item?.unitCost ?? '',
    currency: item?.currency ?? 'THB',
    leadTime: item?.leadTime ?? '',
    moq: item?.moq ?? '',
    classification: item?.classification ?? 'normal',
    photoRef: item?.photoRef ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof ItemInput>(k: K, v: ItemInput[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  async function save() {
    if (!f.cloudItemId.trim() || !f.realName.trim() || !f.vendorId || busy) return;
    setBusy(true);
    setError('');
    try {
      if (item) {
        // cloudItemId is the unique key — not editable here.
        const { cloudItemId, ...rest } = f;
        void cloudItemId;
        await patchItem(item.id, rest);
      } else {
        await createItem(f);
      }
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error && e.message === 'cloudItemId already mapped'
          ? 'รหัสลับนี้ถูกแมปแล้ว'
          : 'บันทึกไม่สำเร็จ',
      );
      setBusy(false);
    }
  }

  const input =
    'w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400';
  const lbl = 'block text-xs font-semibold text-slate-500 mb-1';

  return (
    <div className={item ? '' : 'bg-white rounded-xl border border-slate-200 p-3 mb-3'}>
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <label className={lbl}>รหัสลับ (cloud item id) *</label>
          <input
            value={f.cloudItemId}
            onChange={(e) => set('cloudItemId', e.target.value)}
            disabled={!!item}
            placeholder="เว้นว่างจนกว่า cloud sync จะเติม (ตอนนี้พิมพ์เองได้)"
            className={`${input} font-mono ${item ? 'bg-slate-100 text-slate-400' : ''}`}
          />
        </div>
        <div>
          <label className={lbl}>ชื่อจริง *</label>
          <input
            autoFocus
            value={f.realName}
            onChange={(e) => set('realName', e.target.value)}
            className={input}
          />
        </div>
        <div>
          <label className={lbl}>ผู้ขาย *</label>
          <select
            value={f.vendorId}
            onChange={(e) => set('vendorId', e.target.value)}
            className={input}
          >
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={lbl}>รหัสจริง (SKU)</label>
          <input
            value={f.realSku ?? ''}
            onChange={(e) => set('realSku', e.target.value)}
            placeholder="07-10-09"
            className={`${input} font-mono`}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={lbl}>ต้นทุน/หน่วย</label>
            <input value={f.unitCost ?? ''} onChange={(e) => set('unitCost', e.target.value)} className={input} />
          </div>
          <div>
            <label className={lbl}>สกุลเงิน</label>
            <input value={f.currency ?? ''} onChange={(e) => set('currency', e.target.value)} className={input} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={lbl}>Lead time</label>
            <input value={f.leadTime ?? ''} onChange={(e) => set('leadTime', e.target.value)} className={input} />
          </div>
          <div>
            <label className={lbl}>MOQ</label>
            <input value={f.moq ?? ''} onChange={(e) => set('moq', e.target.value)} className={input} />
          </div>
        </div>
        <div>
          <label className={lbl}>ประเภท</label>
          <select
            value={f.classification}
            onChange={(e) => set('classification', e.target.value as ItemInput['classification'])}
            className={input}
          >
            <option value="normal">normal</option>
            <option value="special">special</option>
          </select>
        </div>
        <div>
          <label className={lbl}>รูปสินค้า (photoRef)</label>
          <input value={f.photoRef ?? ''} onChange={(e) => set('photoRef', e.target.value)} className={input} />
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mt-2">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={save}
          disabled={busy || !f.cloudItemId.trim() || !f.realName.trim() || !f.vendorId}
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
