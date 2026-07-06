import { useEffect } from 'react';
import { X } from 'lucide-react';
import { baht, type Payment } from './lib/api';

// Printable A6 cover letters — FIN staples one to every printed RE for the physical file.
// The owner may adjust the legal name later; keep it in ONE constant.
const COMPANY_HEADER = 'Prominent — ใบปะหน้าใบเสร็จ';

// Same Thai-locale short date used across the inbox/drawer (th-TH gives the Buddhist-era
// 2-digit year FIN expects, e.g. "03 ก.ค. 69").
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });

// One cover per RECEIPT (payment): a payment carrying N RE numbers prints a SINGLE cover that
// lists all N of them, because it's one physical receipt going into the file (owner decision
// 2026-07-06). Several separate receipts still print one cover each.
//
// One A6 page (105×148mm) PER cover (owner decision 2026-07-06 — was 4-up on A4). window.print()
// fires on mount; onDone fires after the browser's print dialog closes (afterprint) so the caller
// can drop back to the inbox. The screen view renders the exact same mm-sized pages (scrolled) so
// FIN can eyeball the layout before printing — no separate preview markup.
export default function PrintCovers({ payments, onDone }: { payments: Payment[]; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 50); // let the DOM paint before the print dialog opens
    const handleAfterPrint = () => onDone();
    window.addEventListener('afterprint', handleAfterPrint);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One cover per payment that carries at least one RE (the caller already filters to
  // reNumbers.length > 0, but stay defensive here) — one A6 page each.
  const items: Payment[] = payments.filter((p) => p.reNumbers.length > 0);

  return (
    <div className="print-covers">
      <style>{`
        @page { size: A6 portrait; margin: 0; }
        @media print {
          body * { visibility: hidden; }
          .print-covers, .print-covers * { visibility: visible; }
          .print-covers { position: absolute; top: 0; left: 0; }
          .print-covers-toolbar { display: none; }
        }
        .print-page {
          width: 105mm;
          box-sizing: border-box;
          padding: 7mm;
          page-break-after: always;
          break-after: page;
          background: white;
          display: flex;
          flex-direction: column;
          font-family: inherit;
        }
        .print-page:last-child { page-break-after: auto; break-after: auto; }
        /* Full A6-page look in the on-screen preview only. In PRINT the page has NO fixed height,
           so a cover flows to its natural height (~110mm) and can never be pushed past the 148mm
           sheet onto a 2nd page (the earlier height:148mm + mt-auto pinned ผู้จัดทำ to the exact
           bottom edge, which a hair of printer margin bumped over). */
        @media screen { .print-page { min-height: 148mm; } }
      `}</style>

      <div className="print-covers-toolbar sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between">
        <div className="text-sm text-slate-600">
          ตัวอย่างใบปะหน้า {items.length} แผ่น (A6 · ใบละ 1 แผ่น) — กำลังเปิดหน้าต่างพิมพ์…
        </div>
        <button onClick={onDone} className="text-slate-400 hover:text-slate-600 flex items-center gap-1 text-sm">
          <X size={16} /> ปิด
        </button>
      </div>

      <div className="bg-slate-200 py-6 flex flex-col items-center gap-6">
        {items.map((p) => <Cover key={p.id} payment={p} />)}
      </div>
    </div>
  );
}

function Cover({ payment: p }: { payment: Payment }) {
  const multi = p.reNumbers.length > 1;
  // one RE → text-4xl (matches รหัสลูกค้า + จำนวนเงิน); several REs scale down & wrap so they
  // can never blow the numbers off the page.
  const reSize = p.reNumbers.length === 1 ? 'text-4xl' : p.reNumbers.length <= 3 ? 'text-2xl' : 'text-lg';
  return (
    <div className="print-page shadow-lg">
      <div className="text-sm font-bold text-slate-500 mb-2">{COMPANY_HEADER}</div>

      <BigField label={`เลขที่ใบเสร็จ${multi ? ` (${p.reNumbers.length} เลข)` : ''}`}>
        <div className={`${reSize} font-bold tracking-wide leading-tight flex flex-wrap gap-x-3`}>
          {p.reNumbers.map((re) => <span key={re}>RE {re}</span>)}
        </div>
      </BigField>

      <Row label="วันที่" value={fmtDate(p.createdAt)} />
      <Row label="ลูกค้า" value={p.customerName || '—'} />

      {/* รหัสลูกค้า + จำนวนเงิน render as BIG figures at the SAME size as the RE number — these
          three are what staff match a cover against its receipt on (owner 2026-07-06). */}
      {p.customerCode && (
        <BigField label="รหัสลูกค้า">
          <div className="text-4xl font-bold tracking-wide leading-tight">{p.customerCode}</div>
        </BigField>
      )}

      <Row label="ชื่อบนใบเสร็จ" value={p.receiptName || '—'} />
      <Row label="ประเภทลูกค้า" value={p.customerType || '—'} />

      <BigField label="จำนวนเงิน">
        <div className="text-4xl font-bold tracking-tight leading-tight">{baht(p.amountNum)}</div>
      </BigField>

      <Row label="ช่องทาง" value={p.bank || '—'} />
      <Row label="พนักงานขาย" value={p.salesName || '—'} />

      <div className="mt-6 text-sm text-slate-500">
        ผู้จัดทำ: ______________________
      </div>
    </div>
  );
}

// A prominent figure block: a small label above a large value. Used for the three numbers staff
// match on — RE, รหัสลูกค้า, จำนวนเงิน — so they're visually parallel and equally big.
function BigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-xs text-slate-400">{label}</div>
      {children}
    </div>
  );
}

// One line per field: label + value inline, ellipsized if it would overflow the A6 width — so a
// long Thai name (customer / receipt) stays on its own single row instead of wrapping.
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mb-2 text-base whitespace-nowrap overflow-hidden text-ellipsis">
      <span className="text-slate-400">{label}: </span>
      <span className="text-slate-800">{value}</span>
    </div>
  );
}
