import { useEffect } from 'react';
import { X } from 'lucide-react';
import { baht, type Payment } from './lib/api';

// Printable ¼-A4 cover letters — FIN staples one to every printed RE for the physical file.
// The owner may adjust the legal name later; keep it in ONE constant.
const COMPANY_HEADER = 'Prominent — ใบปะหน้าใบเสร็จ';

// Same Thai-locale short date used across the inbox/drawer (th-TH gives the Buddhist-era
// 2-digit year FIN expects, e.g. "03 ก.ค. 69").
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });

// One cover per RE: a payment carrying N RE numbers (one transfer paying several receipts)
// prints N covers, each showing exactly ONE RE (large) plus the shared payment details.
interface CoverItem {
  payment: Payment;
  reNumber: string;
}

// A4 portrait, 2×2 grid of A6 (105×148.5mm) quadrants with dashed cut guides. window.print()
// fires on mount; onDone fires after the browser's print dialog closes (afterprint) so the
// caller can drop back to the inbox. The screen view renders the exact same mm-sized pages
// (scrolled) so FIN can eyeball the layout before printing — no separate preview markup.
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

  // Expand each payment into one cover item per RE it carries (payments with none are
  // skipped — the caller already filters to reNumbers.length > 0, but stay defensive here).
  const items: CoverItem[] = payments.flatMap((p) =>
    p.reNumbers.length > 0 ? p.reNumbers.map((reNumber) => ({ payment: p, reNumber })) : [],
  );

  // group into pages of 4 (one A4 sheet = 2×2 quadrants)
  const pages: CoverItem[][] = [];
  for (let i = 0; i < items.length; i += 4) pages.push(items.slice(i, i + 4));

  return (
    <div className="print-covers">
      <style>{`
        @page { size: A4 portrait; margin: 0; }
        @media print {
          body * { visibility: hidden; }
          .print-covers, .print-covers * { visibility: visible; }
          .print-covers { position: absolute; top: 0; left: 0; }
          .print-covers-toolbar { display: none; }
        }
        .print-page {
          width: 210mm;
          height: 297mm;
          display: grid;
          grid-template-columns: 1fr 1fr;
          grid-template-rows: 1fr 1fr;
          page-break-after: always;
          background: white;
        }
        .print-page:last-child { page-break-after: auto; }
        .print-quadrant {
          width: 105mm;
          height: 148.5mm;
          box-sizing: border-box;
          padding: 8mm;
          border: 1px dashed #cbd5e1;
          margin: -0.5px; /* dashed guides shared between adjacent quadrants don't double up */
          display: flex;
          flex-direction: column;
          font-family: inherit;
          overflow: hidden;
        }
      `}</style>

      <div className="print-covers-toolbar sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between">
        <div className="text-sm text-slate-600">
          ตัวอย่างใบปะหน้า {items.length} ใบ ({pages.length} แผ่น) — กำลังเปิดหน้าต่างพิมพ์…
        </div>
        <button onClick={onDone} className="text-slate-400 hover:text-slate-600 flex items-center gap-1 text-sm">
          <X size={16} /> ปิด
        </button>
      </div>

      <div className="bg-slate-200 py-6 flex flex-col items-center gap-6">
        {pages.map((group, pi) => (
          <div key={pi} className="print-page shadow-lg">
            {group.map((item) => <Cover key={`${item.payment.id}-${item.reNumber}`} item={item} />)}
            {/* pad the last page to 4 quadrants so the grid + cut guides stay regular */}
            {Array.from({ length: 4 - group.length }).map((_, i) => (
              <div key={`blank-${i}`} className="print-quadrant" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Cover({ item: { payment: p, reNumber } }: { item: CoverItem }) {
  return (
    <div className="print-quadrant">
      <div className="text-[9px] font-bold text-slate-500 mb-2">{COMPANY_HEADER}</div>

      <div className="mb-2">
        <div className="text-[8px] text-slate-400">เลขที่ใบเสร็จ</div>
        <div className="text-2xl font-bold tracking-wide">RE {reNumber}</div>
      </div>

      <Row label="วันที่" value={fmtDate(p.createdAt)} />
      <Row label="ลูกค้า" value={<>{clamp(p.customerName)} {p.customerCode && <span className="text-slate-400">รหัส {p.customerCode}</span>}</>} />
      <Row label="ชื่อบนใบเสร็จ" value={clamp(p.receiptName)} />
      <Row label="ประเภทลูกค้า" value={p.customerType || '—'} />
      <Row label="จำนวนเงิน" value={<span className="font-bold">{baht(p.amountNum)}</span>} />
      <Row label="ช่องทาง" value={p.bank || '—'} />
      <Row label="พนักงานขาย" value={p.salesName || '—'} />

      <div className="mt-auto pt-3 text-[9px] text-slate-500">
        ผู้จัดทำ: ______________________
      </div>
    </div>
  );
}

// Two-line clamp (ellipsis) so a long Thai name can never blow out the ¼-A4 quadrant.
function clamp(text: string): React.ReactNode {
  return (
    <span
      style={{
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
    >
      {text || '—'}
    </span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px]">
      <span className="text-slate-400">{label}: </span>
      <span className="text-slate-800">{value}</span>
    </div>
  );
}
