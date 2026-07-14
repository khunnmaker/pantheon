import { useEffect, useState } from 'react';
import { Loader2, Plus, Search, AlertTriangle, Check, X, Pencil } from 'lucide-react';
import { getItems, createItem, patchItem, flatSku, type MercuryItem } from '../lib/api';

// Items = the ordinary reorderable items master (list + CRUD). displayName + optional Vesta SKU.
// Secret items are a later phase; this view manages ordinary (non-secret) items.
export default function Items() {
  const [items, setItems] = useState<MercuryItem[] | null>(null);
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
  useEffect(() => { void load(''); /* eslint-disable-next-line */ }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="ค้นหาชื่อ / รหัส"
            className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
        >
          <Plus size={15} /> เพิ่มรายการ
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3"><AlertTriangle size={14} /> {error}</div>
      )}

      {creating && (
        <ItemForm
          onCancel={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load(); }}
        />
      )}

      {items === null ? (
        <div className="py-12 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={22} /></div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400">ยังไม่มีรายการ</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-3 py-2">ชื่อ</th>
                  <th className="text-left font-medium px-3 py-2">รหัส Vesta</th>
                  <th className="text-left font-medium px-3 py-2">ประเภท</th>
                  <th className="text-right font-medium px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) =>
                  editId === it.id ? (
                    <tr key={it.id} className="border-t border-slate-100 bg-orange-50/40">
                      <td colSpan={4} className="px-3 py-2">
                        <ItemForm
                          item={it}
                          onCancel={() => setEditId(null)}
                          onSaved={() => { setEditId(null); void load(); }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={it.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{it.displayName}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">
                        {it.vestaSku ? flatSku(it.vestaSku) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {it.isSecret ? (
                          <span className="text-xs rounded-full bg-slate-200 text-slate-600 px-2 py-0.5">ลับ</span>
                        ) : (
                          <span className="text-xs text-slate-400">ทั่วไป</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setEditId(it.id)}
                          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-orange-700"
                        >
                          <Pencil size={13} /> แก้ไข
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
  onCancel,
  onSaved,
}: {
  item?: MercuryItem;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(item?.displayName ?? '');
  const [vestaSku, setVestaSku] = useState(item?.vestaSku ?? '');
  const [active, setActive] = useState(item?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!displayName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      if (item) {
        await patchItem(item.id, {
          displayName: displayName.trim(),
          vestaSku: vestaSku.trim() || null,
          active,
        });
      } else {
        await createItem({
          displayName: displayName.trim(),
          vestaSku: vestaSku.trim() || undefined,
        });
      }
      onSaved();
    } catch {
      setError('บันทึกไม่สำเร็จ');
      setBusy(false);
    }
  }

  return (
    <div className={item ? '' : 'bg-white rounded-xl border border-slate-200 p-3 mb-3'}>
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1">ชื่อรายการ</label>
          <input
            autoFocus
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 mb-1">รหัส Vesta (ถ้ามี)</label>
          <input
            value={vestaSku}
            onChange={(e) => setVestaSku(e.target.value)}
            placeholder="07-10-09"
            className="w-full px-3 py-2 rounded-md border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
      </div>
      {item && (
        <label className="flex items-center gap-2 mt-2 text-sm text-slate-600">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          ใช้งาน (active)
        </label>
      )}
      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs mt-2"><AlertTriangle size={13} /> {error}</div>
      )}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={save}
          disabled={busy || !displayName.trim()}
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
