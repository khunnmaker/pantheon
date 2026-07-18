import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { baht, getReNames, type Payment } from './lib/api';
import { displayReceiptReference, normalizeBillReference } from './lib/receiptReferences';

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
  // ชื่อบนใบเสร็จ prints the name on the ACTUAL Express receipt (ReReceipt.customerName) rather
  // than the LINE display name prefilled into receiptName — so fetch the imported RE names for
  // every RE on these covers FIRST, then open the print dialog. An unimported RE simply isn't in
  // the map and the Cover falls back to receiptName; {} on failure = graceful, never blocks print.
  const [reNames, setReNames] = useState<Record<string, string>>({});
  const [namesReady, setNamesReady] = useState(false);
  useEffect(() => {
    const cores = [...new Set(payments.flatMap((p) => p.reNumbers))];
    let cancelled = false;
    (cores.length ? getReNames(cores) : Promise.resolve({}))
      .then((m) => { if (!cancelled) setReNames(m); })
      .catch(() => { /* fall back to receiptName */ })
      .finally(() => { if (!cancelled) setNamesReady(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!namesReady) return; // wait for the RE names so the printed page is final before the dialog
    const t = setTimeout(() => window.print(), 50); // let the DOM paint before the print dialog opens
    const handleAfterPrint = () => onDone();
    window.addEventListener('afterprint', handleAfterPrint);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesReady]);

  // One cover per payment carrying any supported document (RE, manual bill, or external ref).
  const items: Payment[] = payments.filter((p) => p.reNumbers.length + p.billNos.length > 0);

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
        {items.map((p) => <Cover key={p.id} payment={p} reNames={reNames} />)}
      </div>
    </div>
  );
}

function Cover({ payment: p, reNames }: { payment: Payment; reNames: Record<string, string> }) {
  const documentLabels = [
    ...p.reNumbers.map((value) => displayReceiptReference({ kind: 're', value })),
    ...p.billNos.map((value) => {
      const normalized = normalizeBillReference(value);
      return normalized ? displayReceiptReference(normalized) : value;
    }),
  ];
  const multi = documentLabels.length > 1;
  const reSize = documentLabels.length === 1 ? 'text-4xl' : documentLabels.length <= 3 ? 'text-2xl' : 'text-lg';
  const big = 'text-4xl font-bold leading-tight';
  // ชื่อบนใบเสร็จ = the customer name on the ACTUAL matched RE (first reNumber that's been
  // imported), falling back to the FIN-typed receiptName (which prefills from the LINE display
  // name) when this RE isn't in the imported set yet.
  const receiptDisplayName = p.reNumbers.map((re) => reNames[re]).find(Boolean) || p.receiptName;
  return (
    <div className="print-page shadow-lg">
      <div className="text-sm font-bold text-slate-500 mb-2">{COMPANY_HEADER}</div>

      {/* Every field is ONE line: label on the LEFT, value on the RIGHT (owner 2026-07-06). The
          three figures staff match a cover to its receipt on — RE, รหัสลูกค้า, จำนวนเงิน — share
          the same big size on the right. */}
      <Line
        label={`เลขที่เอกสาร${multi ? ` (${documentLabels.length} เลข)` : ''}`}
        valueClass={`${reSize} font-bold leading-tight`}
        value={
          <span className="inline-flex flex-wrap justify-end gap-x-3">
            {documentLabels.map((label) => <span key={label}>{label}</span>)}
          </span>
        }
      />
      <Line label="วันที่" value={fmtDate(p.createdAt)} />
      <Line label="ลูกค้า" value={p.customerName || '—'} />
      {p.customerCode && <Line label="รหัสลูกค้า" value={p.customerCode} valueClass={big} />}
      <Line label="ชื่อบนใบเสร็จ" value={receiptDisplayName || '—'} />
      <Line label="ประเภทลูกค้า" value={p.customerType || '—'} />
      <Line label="จำนวนเงิน" value={baht(p.amountNum)} valueClass={big} />
      <Line label="ช่องทาง" value={p.bank || '—'} />
      <Line label="พนักงานขาย" value={p.salesName || '—'} />

      <div className="mt-6 text-sm text-slate-500">
        ผู้จัดทำ: ______________________
      </div>
    </div>
  );
}

// One field per line: label on the LEFT, value on the RIGHT (justified). valueClass overrides the
// value size — RE / รหัสลูกค้า / จำนวนเงิน pass a big class; every other field defaults to text-base.
function Line({ label, value, valueClass = 'text-base' }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-4">
      <span className="text-sm text-slate-400 shrink-0">{label}</span>
      <span className={`text-slate-800 text-right min-w-0 ${valueClass}`}>{value}</span>
    </div>
  );
}
