import { useEffect } from 'react';
import { X } from 'lucide-react';
import { baht, type ManualBill } from './lib/api';

const money = (value: string): number => {
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const fmtBillDate = (value: string): string => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || '—';
  return new Date(`${value}T00:00:00+07:00`).toLocaleDateString('th-TH', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok',
  });
};

export default function PrintBill({ bills, onDone }: { bills: ManualBill[]; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => window.print(), 50);
    const afterPrint = () => onDone();
    window.addEventListener('afterprint', afterPrint);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', afterPrint);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="print-bills">
      <style>{`
        @page { size: A5 portrait; margin: 0; }
        @media print {
          body * { visibility: hidden; }
          .print-bills, .print-bills * { visibility: visible; }
          .print-bills { position: absolute; inset: 0 auto auto 0; }
          .print-bills-toolbar { display: none; }
        }
        .manual-bill-page {
          width: 148mm;
          min-height: 210mm;
          box-sizing: border-box;
          padding: 10mm;
          background: white;
          page-break-after: always;
          break-after: page;
          font-family: Tahoma, sans-serif;
          color: #1e293b;
        }
        .manual-bill-page:last-child { page-break-after: auto; break-after: auto; }
        .manual-bill-table { width: 100%; border-collapse: collapse; }
        .manual-bill-table th, .manual-bill-table td { border: 1px solid #94a3b8; padding: 2mm 1.5mm; }
        .manual-bill-table th { background: #f1f5f9; font-size: 10px; }
        .manual-bill-table td { font-size: 10px; vertical-align: top; }
        .manual-bill-page.dense { padding: 7mm; }
        .manual-bill-page.dense header { padding-bottom: 1.5mm; }
        .manual-bill-page.dense .manual-bill-table { margin-top: 2mm; }
        .manual-bill-page.dense .manual-bill-table th,
        .manual-bill-page.dense .manual-bill-table td { padding: .25mm .6mm; font-size: 7px; line-height: 1.1; }
        .manual-bill-page.dense .signature-block { padding-top: 6mm; }
      `}</style>

      <div className="print-bills-toolbar sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between">
        <span className="text-sm text-slate-600">ตัวอย่างบิลเงินสด {bills.length} ใบ (A5)</span>
        <button onClick={onDone} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><X size={16} /> ปิด</button>
      </div>

      <div className="bg-slate-200 py-6 flex flex-col items-center gap-6">
        {bills.map((bill) => <BillPage key={bill.id} bill={bill} />)}
      </div>
    </div>
  );
}

function BillPage({ bill }: { bill: ManualBill }) {
  return (
    <section className={`manual-bill-page shadow-lg flex flex-col ${bill.items.length > 20 ? 'dense' : ''}`}>
      {/* TODO owner review: legal company header copied from diana/src/company.ts. */}
      <header className="text-center border-b-2 border-slate-700 pb-3">
        <div className="text-lg font-bold">Prominent Co., Ltd.</div>
        <div className="text-[10px] mt-1">55 ซอยอินทามระ 19 แขวงสามเสนใน เขตพญาไท กรุงเทพฯ 10400</div>
        <div className="text-[10px]">โทร. 0-2616-1866</div>
        <h1 className="text-xl font-bold mt-3">บิลเงินสด</h1>
      </header>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mt-3">
        <div><span className="text-slate-500">เลขที่บิล:</span> <b>{bill.billNo}</b></div>
        <div className="text-right"><span className="text-slate-500">วันที่:</span> {fmtBillDate(bill.billedAt)}</div>
        <div className="col-span-2"><span className="text-slate-500">ผู้ซื้อ:</span> {bill.buyerName || '—'}</div>
        <div><span className="text-slate-500">โทรศัพท์:</span> {bill.buyerPhone || '—'}</div>
        <div className="col-span-2"><span className="text-slate-500">ที่อยู่:</span> {bill.buyerAddress || '—'}</div>
      </div>

      <table className="manual-bill-table mt-4">
        <thead>
          <tr>
            <th className="w-[8%]">ลำดับ</th>
            <th className="text-left">รายการ</th>
            <th className="w-[12%]">จำนวน</th>
            <th className="w-[18%]">หน่วยละ</th>
            <th className="w-[20%]">จำนวนเงิน</th>
          </tr>
        </thead>
        <tbody>
          {bill.items.map((item, index) => (
            <tr key={`${item.sku ?? item.name}-${index}`}>
              <td className="text-center">{index + 1}</td>
              <td>{item.sku && <span className="text-slate-500 mr-1">{item.sku}</span>}{item.name}</td>
              <td className="text-center">{item.qty}</td>
              <td className="text-right">{money(item.unitPrice).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
              <td className="text-right">{money(item.amount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4} className="text-right font-bold">รวมทั้งสิ้น</td>
            <td className="text-right font-bold">{baht(money(bill.amount))}</td>
          </tr>
        </tbody>
      </table>

      {bill.note && <div className="mt-3 text-[10px]"><span className="text-slate-500">หมายเหตุ:</span> {bill.note}</div>}

      <div className="signature-block mt-auto pt-14 grid grid-cols-2 gap-12 text-center text-[11px]">
        <div><div className="border-b border-slate-500 h-6" /><div className="mt-2">ผู้รับเงิน</div></div>
        <div><div className="border-b border-slate-500 h-6" /><div className="mt-2">ผู้ซื้อ</div></div>
      </div>
    </section>
  );
}
