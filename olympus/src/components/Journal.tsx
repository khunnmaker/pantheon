import { useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { getJournal } from '../lib/api';
import { bangkokTodayKey, longThaiDate } from '../lib/dates';
import type { HestiaJournalEntry } from '../types';
import JournalEditorModal from './JournalEditorModal';

const MOOD_EMOJI: Record<number, string> = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' };

// Journal tab: JournalList (cursor-paginated, newest first), JournalEntryCard, and
// JournalEditorModal for create/edit. No month/date filter UI yet in v1 — the API supports a
// from/to range (getJournal) so this is a natural follow-up without a schema/type change.
export default function Journal() {
  const [entries, setEntries] = useState<HestiaJournalEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editor, setEditor] = useState<{ entry?: HestiaJournalEntry } | null>(null);

  async function loadFirst() { const page = await getJournal({}); setEntries(page.entries); setNextCursor(page.nextCursor); }
  useEffect(() => { void loadFirst(); }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getJournal({ cursor: nextCursor });
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } finally { setLoadingMore(false); }
  }

  if (!entries) return <div className="py-16 text-center text-stone-400"><Loader2 className="mx-auto animate-spin" size={20}/></div>;

  return <div>
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-bold text-stone-800">บันทึกประจำวัน</h2>
      <button onClick={() => setEditor({})} className="btn-primary"><Plus size={16}/> บันทึกใหม่</button>
    </div>
    <div className="mt-4 space-y-3">
      {!entries.length && <div className="rounded-2xl border border-dashed border-stone-300 bg-white py-16 text-center text-sm text-stone-400">ยังไม่มีบันทึก</div>}
      {entries.map((entry) => <JournalEntryCard key={entry.id} entry={entry} onOpen={() => setEditor({ entry })}/>)}
    </div>
    {nextCursor && <button onClick={() => void loadMore()} disabled={loadingMore} className="btn mt-4 w-full border border-stone-200 bg-white">{loadingMore ? <Loader2 size={15} className="animate-spin"/> : 'โหลดเพิ่ม'}</button>}
    {editor && <JournalEditorModal entryDate={bangkokTodayKey()} entry={editor.entry} onClose={() => setEditor(null)}
      onSaved={async () => { setEditor(null); await loadFirst(); }}
      onDeleted={async () => { setEditor(null); await loadFirst(); }}/>}
  </div>;
}

function JournalEntryCard({ entry, onOpen }: { entry: HestiaJournalEntry; onOpen: () => void }) {
  return <button onClick={onOpen} className="flex w-full flex-col gap-1 rounded-2xl border border-stone-200 bg-white p-4 text-left hover:border-amber-300">
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold text-stone-500">{longThaiDate(entry.entryDate.slice(0, 10))}</span>
      {entry.mood && <span>{MOOD_EMOJI[entry.mood]}</span>}
      {entry.source === 'notion' && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-600">Notion</span>}
    </div>
    {entry.title && <div className="font-bold text-stone-800">{entry.title}</div>}
    <p className="line-clamp-2 whitespace-pre-line text-sm text-stone-600">{entry.bodyMarkdown}</p>
    {!!entry.tags.length && <div className="mt-1 flex flex-wrap gap-1">{entry.tags.map((tag) => <span key={tag} className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">#{tag}</span>)}</div>}
  </button>;
}
