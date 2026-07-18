import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Pencil, Plus, X } from 'lucide-react';
import {
  adminCreateCategory,
  adminListCategories,
  adminMoveCategory,
  adminUpdateCategory,
  describeCategoryError,
  type AdminCategory,
} from './lib/api';
import { groupByCategoryGroup } from './components/CategoryPicker';

// GM/CEO-only "จัดการหมวดหมู่" admin section (Ceres categories revamp Phase B, 2026-07-18) —
// lives inside the existing Settings screen (see Settings.tsx, which gates rendering this to
// gm/ceo only — messenger reaches Settings too via StaffHome, so that gate matters). Talks to
// the admin CRUD routes in api/src/routes/ceres/categories.ts. Styling copied verbatim from the
// neighboring MdTemplates.tsx dialog/list patterns (owner rule: match siblings).

export default function CategoryAdmin() {
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const [creating, setCreating] = useState(false);
  const [moveBusyId, setMoveBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    adminListCategories()
      .then((r) => setCategories(r.categories))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeGroups = groupByCategoryGroup(categories.filter((c) => c.active));
  const inactiveList = [...categories].filter((c) => !c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const groupNames = Array.from(new Set(categories.map((c) => c.group))).sort();

  async function move(id: string, direction: 'up' | 'down') {
    setError('');
    setMoveBusyId(id);
    try {
      await adminMoveCategory(id, direction);
      load();
    } catch {
      setError('ย้ายลำดับไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setMoveBusyId('');
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-500">จัดการหมวดหมู่</h3>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold"
        >
          <Plus size={15} /> เพิ่มหมวดหมู่
        </button>
      </div>

      {(creating || editing) && (
        <CategoryDialog
          category={editing}
          groups={groupNames}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : (
        <div className="space-y-4">
          {activeGroups.map((g) => (
            <div key={g.group}>
              <div className="text-xs font-semibold text-slate-400 mb-1.5">{g.group}</div>
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {g.items.map((c, i) => (
                  <CategoryRow
                    key={c.id}
                    category={c}
                    canMoveUp={i > 0}
                    canMoveDown={i < g.items.length - 1}
                    busy={moveBusyId === c.id}
                    onMove={(dir) => move(c.id, dir)}
                    onEdit={() => setEditing(c)}
                  />
                ))}
              </div>
            </div>
          ))}

          {inactiveList.length > 0 && (
            <div>
              <button
                onClick={() => setShowInactive((v) => !v)}
                className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-600 mb-1.5"
              >
                {showInactive ? <ChevronUp size={13} /> : <ChevronDown size={13} />} ปิดใช้งาน ({inactiveList.length})
              </button>
              {showInactive && (
                <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                  {inactiveList.map((c) => (
                    <CategoryRow
                      key={c.id}
                      category={c}
                      canMoveUp={false}
                      canMoveDown={false}
                      busy={false}
                      onMove={() => {}}
                      onEdit={() => setEditing(c)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CategoryRow({
  category,
  canMoveUp,
  canMoveDown,
  busy,
  onMove,
  onEdit,
}: {
  category: AdminCategory;
  canMoveUp: boolean;
  canMoveDown: boolean;
  busy: boolean;
  onMove: (direction: 'up' | 'down') => void;
  onEdit: () => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2.5 ${category.active ? '' : 'opacity-50'}`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-700 truncate">{category.name}</div>
        {category.needsCustomerNote && <div className="text-xs text-slate-400">ต้องระบุชื่อลูกค้า</div>}
      </div>
      {category.active && (
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => onMove('up')}
            disabled={!canMoveUp || busy}
            aria-label="ย้ายขึ้น"
            className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => onMove('down')}
            disabled={!canMoveDown || busy}
            aria-label="ย้ายลง"
            className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      )}
      <button onClick={onEdit} aria-label="แก้ไขหมวดหมู่" className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50">
        <Pencil size={14} />
      </button>
    </div>
  );
}

function CategoryDialog({
  category,
  groups,
  onClose,
  onSaved,
}: {
  category: AdminCategory | null;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [group, setGroup] = useState(category?.group ?? '');
  const [ceiling, setCeiling] = useState(category?.ceiling ?? '');
  const [needsCustomerNote, setNeedsCustomerNote] = useState(category?.needsCustomerNote ?? false);
  const [active, setActive] = useState(category?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!name.trim()) return setError('กรอกชื่อหมวดหมู่');
    if (!group.trim()) return setError('กรอกกลุ่มหมวดหมู่');
    setBusy(true);
    try {
      if (category) {
        await adminUpdateCategory(category.id, {
          name: name.trim(),
          group: group.trim(),
          ceiling: ceiling.trim(),
          needsCustomerNote,
          active,
        });
      } else {
        await adminCreateCategory({
          name: name.trim(),
          group: group.trim(),
          ceiling: ceiling.trim(),
          needsCustomerNote,
        });
      }
      onSaved();
    } catch (err) {
      setError(describeCategoryError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-lg">{category ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่'}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ชื่อหมวดหมู่"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />

          <input
            list="ceres-category-groups"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="กลุ่ม เช่น สำนักงาน/ธุรการ"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />
          <datalist id="ceres-category-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>

          <input
            inputMode="decimal"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
            placeholder="เพดานต่อรายการ (บาท) ถ้ามี"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />

          <label className="flex items-center gap-2 text-sm text-slate-600 px-1 py-1">
            <input
              type="checkbox"
              checked={needsCustomerNote}
              onChange={(e) => setNeedsCustomerNote(e.target.checked)}
              className="w-4 h-4"
            />
            ต้องระบุชื่อลูกค้า
          </label>

          {category && (
            <>
              <label className="flex items-center gap-2 text-sm text-slate-600 px-1 py-1">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4" />
                เปิดใช้งาน
              </label>
              <p className="text-xs text-slate-400 px-1">การเปลี่ยนชื่อจะไม่แก้ไขรายการเก่าที่เคยบันทึกไว้แล้ว</p>
            </>
          )}

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={submit}
              disabled={busy}
              className="flex-1 min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'บันทึก'}
            </button>
            <button onClick={onClose} disabled={busy} className="px-4 min-h-[44px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              ยกเลิก
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
