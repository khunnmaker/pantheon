import { useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  FileText,
  FileDown,
  ExternalLink,
  Check,
  Mail,
  MailCheck,
} from 'lucide-react';
import {
  getPurchaseOrders,
  generatePoPdf,
  poPdfUrl,
  type PurchaseOrder,
} from '../lib/api';
import MailCard from './MailCard';
import SendEmailModal from './SendEmailModal';

// Purchase Orders — draft POs (grouped by vendor) with a "Generate PDF" action per PO. The PDF is
// English-only, splits Taiwan vendors into normal/special, and embeds a product picture per line
// (placeholder when missing). Email send is a later chunk — this stops before send.
export default function PurchaseOrders() {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [emailPo, setEmailPo] = useState<PurchaseOrder | null>(null);

  async function load() {
    setError('');
    try {
      const { orders } = await getPurchaseOrders();
      setOrders(orders);
    } catch {
      setError('โหลดใบสั่งซื้อไม่สำเร็จ');
      setOrders([]);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function makePdf(po: PurchaseOrder) {
    setBusyId(po.id);
    setError('');
    try {
      await generatePoPdf(po.id);
      await load();
      // Open the freshly generated PDF in a new tab.
      window.open(poPdfUrl(po.id), '_blank');
    } catch {
      setError('สร้าง PDF ไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {/* SMTP mail status — must be configured before a PO can be emailed. */}
      <MailCard />

      <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
        ใบสั่งซื้อ (draft) จัดกลุ่มตามผู้ขาย · กด &quot;สร้าง PDF&quot; เพื่อออกไฟล์ (อังกฤษ, ไต้หวันแยก normal/special, มีรูปสินค้าต่อบรรทัด) แล้ว
        &quot;ตรวจ + ส่งอีเมล&quot; ไปยังผู้ขาย (ตรวจก่อนส่งทุกครั้ง ไม่ส่งอัตโนมัติ)
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {orders === null ? (
        <div className="py-12 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : orders.length === 0 ? (
        <div className="py-16 text-center text-slate-400">
          <FileText size={28} className="mx-auto mb-2 opacity-50" />
          <div className="text-sm">ยังไม่มีใบสั่งซื้อ — ไปที่แท็บ &quot;ซิงค์&quot; เพื่อสร้างจากคำขอ</div>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => {
            const isTaiwan = o.vendor?.isTaiwan ?? false;
            const normal = o.lines.filter((l) => l.classification !== 'special');
            const special = o.lines.filter((l) => l.classification === 'special');
            const open = expanded === o.id;
            return (
              <div key={o.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="font-semibold text-slate-700 flex items-center gap-2">
                      {o.vendor?.name ?? '(ไม่มีผู้ขาย)'}
                      {isTaiwan && (
                        <span className="text-xs rounded-full bg-amber-100 text-amber-700 px-2 py-0.5">
                          ไต้หวัน
                        </span>
                      )}
                      <span
                        className={`text-xs rounded-full px-2 py-0.5 ${
                          o.status === 'sent'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {o.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      {o.poNumber ?? '—'} · {o.lines.length} รายการ ·{' '}
                      {new Date(o.createdAt).toLocaleDateString('th-TH')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <button
                      onClick={() => setExpanded(open ? null : o.id)}
                      className="text-xs text-slate-500 hover:text-orange-700"
                    >
                      {open ? 'ซ่อน' : 'ดูบรรทัด'}
                    </button>
                    {o.pdfPath && (
                      <a
                        href={poPdfUrl(o.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                      >
                        <ExternalLink size={13} /> เปิด PDF
                      </a>
                    )}
                    <button
                      onClick={() => makePdf(o)}
                      disabled={busyId === o.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold disabled:opacity-50"
                    >
                      {busyId === o.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : o.pdfPath ? (
                        <Check size={13} />
                      ) : (
                        <FileDown size={13} />
                      )}
                      {o.pdfPath ? 'สร้างใหม่' : 'สร้าง PDF'}
                    </button>
                    {/* Review-then-send. Enabled once a PDF exists; disabled after 'sent'. */}
                    <button
                      onClick={() => setEmailPo(o)}
                      disabled={!o.pdfPath || o.status === 'sent'}
                      title={
                        o.status === 'sent'
                          ? 'ส่งแล้ว'
                          : !o.pdfPath
                            ? 'สร้าง PDF ก่อนจึงจะส่งได้'
                            : 'ตรวจแล้วส่งอีเมลไปยังผู้ขาย'
                      }
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-orange-300 text-orange-700 hover:bg-orange-50 text-xs font-semibold disabled:opacity-40"
                    >
                      {o.status === 'sent' ? <MailCheck size={13} /> : <Mail size={13} />}
                      {o.status === 'sent' ? 'ส่งแล้ว' : 'ตรวจ + ส่งอีเมล'}
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/50">
                    {isTaiwan ? (
                      <>
                        <LineTable title="NORMAL" lines={normal} />
                        <LineTable title="SPECIAL" lines={special} />
                      </>
                    ) : (
                      <LineTable lines={o.lines} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Review-then-send modal (mounted only when a PO is chosen). */}
      {emailPo && (
        <SendEmailModal
          po={emailPo}
          onClose={() => setEmailPo(null)}
          onSent={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

function LineTable({
  title,
  lines,
}: {
  title?: string;
  lines: PurchaseOrder['lines'];
}) {
  if (lines.length === 0) return null;
  return (
    <div className="mb-2">
      {title && <div className="text-xs font-semibold text-slate-500 mb-1">{title}</div>}
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-400">
          <tr>
            <th className="text-left font-medium py-1">รายการ</th>
            <th className="text-right font-medium py-1">จำนวน</th>
            <th className="text-left font-medium py-1 pl-3">รูป</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className="py-1.5">{l.realName}</td>
              <td className="py-1.5 text-right">{l.qty || '—'}</td>
              <td className="py-1.5 pl-3 text-xs text-slate-400">
                {l.photoRef ? '🖼' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
