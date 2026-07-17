import type { ReactNode } from 'react';
import { X } from 'lucide-react';

// Shared modal chrome for every Hestia form (goal, habit, journal entry) — mirrors
// apollo/src/CalendarView.tsx's local Shell, lifted to a shared component since Olympus has
// several independent modals that all need the identical overlay/close/scroll behavior.
export default function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-stone-200 px-5 py-4">
        <h2 className="text-lg font-bold">{title}</h2>
        <button aria-label="ปิด" onClick={onClose} className="rounded-lg p-1 text-stone-400 hover:bg-stone-100"><X/></button>
      </div>
      <div className="max-h-[calc(85vh-70px)] overflow-y-auto p-5">{children}</div>
    </div>
  </div>;
}
