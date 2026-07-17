import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { createJournalEntry, deleteJournalEntry, updateJournalEntry } from '../lib/api';
import type { HestiaJournalEntry } from '../types';
import ModalShell from './Shell';

const MOODS = [1, 2, 3, 4, 5];
const MOOD_EMOJI: Record<number, string> = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' };

// Journal form order (plan §4): entryDate first (identity), then title, mood/tags, body.
// Markdown textarea in v1 — rendered as plain text (JournalEntryCard), no markdown dependency.
export default function JournalEditorModal({ entryDate, entry, onClose, onSaved, onDeleted }: {
  entryDate: string; entry?: HestiaJournalEntry; onClose: () => void; onSaved: () => void; onDeleted?: () => void;
}) {
  const [date, setDate] = useState(entry?.entryDate.slice(0, 10) ?? entryDate);
  const [title, setTitle] = useState(entry?.title ?? '');
  const [mood, setMood] = useState<number | null>(entry?.mood ?? null);
  const [tagsText, setTagsText] = useState((entry?.tags ?? []).join(', '));
  const [body, setBody] = useState(entry?.bodyMarkdown ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!body.trim() || busy) return;
    setBusy(true); setError('');
    const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      if (entry) await updateJournalEntry(entry.id, { entryDate: date, title, mood, tags, bodyMarkdown: body });
      else await createJournalEntry({ entryDate: date, title, mood, tags, bodyMarkdown: body });
      onSaved();
    } catch { setError('บันทึกไม่สำเร็จ'); } finally { setBusy(false); }
  }
  async function remove() {
    if (!entry || !confirm('ลบบันทึกนี้หรือไม่?')) return;
    setBusy(true);
    try { await deleteJournalEntry(entry.id); onDeleted?.(); } finally { setBusy(false); }
  }

  return <ModalShell title={entry ? 'แก้ไขบันทึก' : 'บันทึกใหม่'} onClose={onClose}>
    <label className="label">วันที่</label>
    <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)}/>
    <label className="label">หัวข้อ</label>
    <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="(ไม่บังคับ)"/>
    <label className="label">อารมณ์</label>
    <div className="flex gap-1.5">
      {MOODS.map((m) => (
        <button key={m} type="button" onClick={() => setMood(mood === m ? null : m)}
          className={`grid h-9 w-9 place-items-center rounded-full text-lg ${mood === m ? 'bg-amber-100 ring-2 ring-amber-400' : 'bg-stone-50 hover:bg-stone-100'}`}>
          {MOOD_EMOJI[m]}
        </button>
      ))}
    </div>
    <label className="label">แท็ก (คั่นด้วยจุลภาค)</label>
    <input className="input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="งาน, ครอบครัว"/>
    <label className="label">เนื้อหา</label>
    <textarea className="input min-h-40" value={body} onChange={(e) => setBody(e.target.value)}/>
    {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    <div className="mt-5 flex flex-wrap gap-2">
      {entry && <button onClick={() => void remove()} disabled={busy} className="btn text-rose-600 hover:bg-rose-50"><Trash2 size={16}/> ลบ</button>}
      <button onClick={() => void save()} disabled={busy || !body.trim()} className="btn-primary ml-auto">{busy && <Loader2 size={15} className="animate-spin"/>} บันทึก</button>
    </div>
  </ModalShell>;
}
