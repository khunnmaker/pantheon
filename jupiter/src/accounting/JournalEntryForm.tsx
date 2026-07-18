// Manual journal-entry form (create + edit-draft), per docs/JUPITER_P2_PLAN.md §7's exact Thai
// field labels. Line grid: account selector searches code+name but always displays the code;
// รวมเดบิต/รวมเครดิต/ผลต่าง are computed with exact decimal-string arithmetic (./money.ts,
// BigInt satang — never parseFloat). Both "บันทึกร่าง" and "ตรวจสอบและผ่านรายการ" are disabled
// until the entry balances, because the API itself requires a balanced draft on save (not just
// on post) — see api/src/routes/jupiterLedger.ts validateReferences -> validateDraftLines.
//
// Line-level PARTNER pickers are included (the partner-ledger report reads partner from posted
// LINES on AR/AP accounts — a header-only partner would make new AR/AP entries invisible to the
// CPA's partner ledger): each line defaults to the header คู่ค้า until individually overridden,
// and lines whose account is asset_receivable / liability_payable hint amber when no partner is
// set. Line-level TAX pickers stay omitted for this phase (lines submit taxes: []), as do
// header dueDate/paymentReference (not in §7's label list) — sent as empty/null defaults.
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import {
  LedgerApiError, ledgerAccounts, ledgerCreateEntry, ledgerJournals, ledgerPostEntry, ledgerUpdateEntry,
  type AcctCompany, type JournalEntry, type JournalLineInput, type LedgerAccount, type LedgerJournal,
} from '../lib/api';
import { formatMoneyDisplay, isValidMoneyInput, isZeroMoney, normalizeMoney, subtractMoney, sumMoney } from './money';
import { AccountPicker, PartnerPicker, inputCls, labelCls } from './shared';

interface LineState {
  key: string;
  accountId: string;
  partnerId: string | null;
  // Once the user touches a line's partner it stops following the header คู่ค้า default.
  partnerTouched: boolean;
  label: string;
  debit: string;
  credit: string;
}

let lineKeySeq = 0;
function newLine(partnerId: string | null = null): LineState {
  lineKeySeq += 1;
  return { key: `L${lineKeySeq}`, accountId: '', partnerId, partnerTouched: false, label: '', debit: '', credit: '' };
}

const BANGKOK_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function bangkokAccountingDate(now = new Date()): string {
  const parts = Object.fromEntries(
    BANGKOK_DATE_FORMATTER.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const ERROR_TH: Record<string, string> = {
  unbalanced_entry: 'เดบิตและเครดิตไม่เท่ากัน — ตรวจสอบรายการอีกครั้ง',
  invalid_line: 'รายการบัญชีไม่ถูกต้อง (ต้องมีอย่างน้อย 2 บรรทัดที่มีจำนวนเงินและเลือกบัญชีแล้ว)',
  invalid_reference: 'บัญชี/สมุดรายวัน/คู่ค้าไม่ถูกต้อง หรือไม่ตรงกับบริษัทที่เลือก',
  invalid_entry_date: 'วันที่ลงบัญชีไม่ถูกต้อง',
  lock_date_violation: 'วันที่ลงบัญชีอยู่ก่อนวันที่ล็อกบัญชีของบริษัทนี้',
  paper_only_company: 'บริษัทนี้เป็นนิติบุคคลที่ไม่ได้ใช้งาน (paper only)',
  stale_version: 'รายการนี้ถูกแก้ไขโดยคนอื่นแล้ว กรุณาเปิดรายการนี้ใหม่',
  money_invalid: 'จำนวนเงินไม่ถูกต้อง',
};
function errText(e: unknown): string {
  if (e instanceof LedgerApiError && e.code) return ERROR_TH[e.code] ?? e.message;
  return String((e as Error)?.message ?? e);
}

export default function JournalEntryForm({
  companies, defaultCompany, existing, onSaved, onCancel,
}: {
  companies: AcctCompany[];
  defaultCompany: string;
  existing?: JournalEntry | null;
  onSaved: (entry: JournalEntry) => void;
  onCancel: () => void;
}) {
  const isEdit = Boolean(existing);
  const [companyCode, setCompanyCode] = useState(existing?.companyCode ?? defaultCompany);
  const [journalId, setJournalId] = useState(existing?.journalId ?? '');
  const [entryDate, setEntryDate] = useState(existing?.entryDate ?? bangkokAccountingDate());
  const [ref, setRef] = useState(existing?.ref ?? '');
  const [memo, setMemo] = useState(existing?.memo ?? '');
  const [partnerId, setPartnerId] = useState<string | null>(existing?.partnerId ?? null);
  const [documentNo, setDocumentNo] = useState(existing?.documentNo ?? '');
  const [documentDate, setDocumentDate] = useState(existing?.documentDate ?? '');
  const [taxInvoiceNo, setTaxInvoiceNo] = useState(existing?.taxInvoiceNo ?? '');
  const [taxInvoiceDate, setTaxInvoiceDate] = useState(existing?.taxInvoiceDate ?? '');
  const [whtCertificateNo, setWhtCertificateNo] = useState(existing?.whtCertificateNo ?? '');
  const [lines, setLines] = useState<LineState[]>(() => (
    existing
      ? existing.lines.map((l) => ({
        key: `L${l.lineNo}`,
        accountId: l.accountId,
        partnerId: l.partnerId,
        // A stored line partner that matches the header keeps following it; one that differs
        // (or was deliberately left empty against a set header) is an explicit override.
        partnerTouched: l.partnerId !== (existing.partnerId ?? null),
        label: l.label,
        debit: l.debit,
        credit: l.credit,
      }))
      : [newLine(), newLine()]
  ));

  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [journals, setJournals] = useState<LedgerJournal[]>([]);
  const [entryId, setEntryId] = useState<string | null>(existing?.id ?? null);
  const [version, setVersion] = useState<number>(existing?.version ?? 0);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);

  useEffect(() => {
    if (!companyCode) { setAccounts([]); setJournals([]); return; }
    let alive = true;
    Promise.all([ledgerAccounts(companyCode, true), ledgerJournals(companyCode, true)])
      .then(([a, j]) => { if (alive) { setAccounts(a); setJournals(j); } })
      .catch(() => { /* selectors just stay empty on failure */ });
    return () => { alive = false; };
  }, [companyCode]);

  // Accounts/journals are company-scoped — dropping the prior selections on a company change
  // (create mode only; editing an existing draft keeps its company fixed) avoids submitting an
  // account or journal that belongs to a different company.
  useEffect(() => {
    if (isEdit) return;
    setJournalId('');
    setLines((prev) => prev.map((l) => ({ ...l, accountId: '' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyCode]);

  function updateLine(key: string, patch: Partial<LineState>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, newLine(partnerId)]);
  }
  function removeLine(key: string) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.key !== key)));
  }

  // Header คู่ค้า is the visible default for every line that hasn't been individually
  // overridden — changing it re-defaults those lines (overridable per line in the grid).
  function setHeaderPartner(id: string | null) {
    setPartnerId(id);
    setLines((prev) => prev.map((l) => (l.partnerTouched ? l : { ...l, partnerId: id })));
  }

  // Amber hint for AR/AP lines: the partner-ledger report reads partner from posted lines on
  // receivable/payable accounts, so a missing line partner there hides the entry from the CPA's
  // partner ledger.
  const isArApAccount = (accountId: string) => {
    const type = accounts.find((a) => a.id === accountId)?.accountType;
    return type === 'asset_receivable' || type === 'liability_payable';
  };

  // Only lines with a chosen account count toward the entry — a still-blank scratch row is not
  // yet part of it (the server requires every submitted line to carry an account).
  const submittableLines = useMemo(() => lines.filter((l) => l.accountId.trim() !== ''), [lines]);
  const debitTotal = useMemo(() => sumMoney(submittableLines.map((l) => l.debit)), [submittableLines]);
  const creditTotal = useMemo(() => sumMoney(submittableLines.map((l) => l.credit)), [submittableLines]);
  const diff = useMemo(() => subtractMoney(debitTotal, creditTotal), [debitTotal, creditTotal]);
  const nonzeroCount = useMemo(
    () => submittableLines.filter((l) => !isZeroMoney(l.debit) || !isZeroMoney(l.credit)).length,
    [submittableLines],
  );
  const inputsValid = lines.every((l) => (!l.debit.trim() || isValidMoneyInput(l.debit)) && (!l.credit.trim() || isValidMoneyInput(l.credit)));
  const balanced = isZeroMoney(diff) && submittableLines.length >= 2 && nonzeroCount >= 2;
  const canSave = Boolean(companyCode && journalId && entryDate) && balanced && inputsValid;

  function buildLinesPayload(): JournalLineInput[] {
    return submittableLines.map((l, idx) => ({
      lineNo: idx + 1,
      accountId: l.accountId,
      partnerId: l.partnerId,
      label: l.label,
      debit: normalizeMoney(l.debit),
      credit: normalizeMoney(l.credit),
      taxes: [],
    }));
  }

  async function save(): Promise<JournalEntry | null> {
    setErr(null);
    if (!canSave) { setErr('กรอกข้อมูลให้ครบและตรวจสอบว่าเดบิตรวม = เครดิตรวมก่อนบันทึก'); return null; }
    setSaving(true);
    try {
      const body = {
        companyCode, journalId, entryDate, ref, memo, partnerId,
        documentNo, documentDate: documentDate || null, taxInvoiceNo, taxInvoiceDate: taxInvoiceDate || null,
        whtCertificateNo, lines: buildLinesPayload(),
      };
      const saved = entryId ? await ledgerUpdateEntry(entryId, { ...body, version }) : await ledgerCreateEntry(body);
      setEntryId(saved.id);
      setVersion(saved.version);
      onSaved(saved);
      return saved;
    } catch (e) {
      setErr(errText(e));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function postNow() {
    setPosting(true);
    setErr(null);
    try {
      const saved = await save();
      if (!saved) return;
      const posted = await ledgerPostEntry(saved.id, saved.version);
      onSaved(posted);
      setConfirmPost(false);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <section className="bg-white border border-[#E9E4F2] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-extrabold text-[15px] text-[#1E1A2B]">{isEdit ? 'แก้ไขรายการร่าง' : 'สร้างรายการบัญชีใหม่'}</div>
        <button onClick={onCancel} className="text-[#726C86] hover:text-[#403A54]"><X size={18} /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <div>
          <label className={labelCls}>บริษัท</label>
          <select value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} disabled={isEdit} className={inputCls}>
            <option value="">เลือกบริษัท</option>
            {companies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>วันที่ลงบัญชี</label>
          <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>สมุดรายวัน</label>
          <select value={journalId} onChange={(e) => setJournalId(e.target.value)} className={inputCls}>
            <option value="">เลือกสมุดรายวัน</option>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.code} · {j.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>เลขที่อ้างอิง</label>
          <input value={ref} onChange={(e) => setRef(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>คู่ค้า</label>
          <PartnerPicker value={partnerId} onChange={(id) => setHeaderPartner(id)} />
        </div>
        <div />
        <div>
          <label className={labelCls}>เลขที่เอกสาร</label>
          <input value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>วันที่เอกสาร</label>
          <input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} className={inputCls} />
        </div>
        <div />
        <div>
          <label className={labelCls}>เลขที่ใบกำกับภาษี</label>
          <input value={taxInvoiceNo} onChange={(e) => setTaxInvoiceNo(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>วันที่ใบกำกับภาษี</label>
          <input type="date" value={taxInvoiceDate} onChange={(e) => setTaxInvoiceDate(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>เลขที่หนังสือรับรองหัก ณ ที่จ่าย</label>
          <input value={whtCertificateNo} onChange={(e) => setWhtCertificateNo(e.target.value)} className={inputCls} />
        </div>
        <div className="sm:col-span-3">
          <label className={labelCls}>คำอธิบาย</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} className={inputCls} />
        </div>
      </div>

      <div className="mb-1 font-bold text-[13px] text-[#1E1A2B]">รายการบัญชี</div>
      <div className="border border-[#E9E4F2] rounded-lg overflow-hidden mb-2 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {['รหัสบัญชี / ชื่อบัญชี', 'คู่ค้า', 'คำอธิบาย', 'เดบิต', 'เครดิต', ''].map((h, i) => (
                <th key={h} className={`px-2.5 py-2 text-[10px] uppercase tracking-wide text-[#726C86] font-bold border-b border-[#F2EEF9] bg-[#FAF8FE] whitespace-nowrap ${i >= 3 && i <= 4 ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td className="px-2.5 py-1.5 border-b border-[#F2EEF9] min-w-[200px]">
                  <AccountPicker accounts={accounts} value={l.accountId} onChange={(id) => updateLine(l.key, { accountId: id })} />
                </td>
                <td className="px-2.5 py-1.5 border-b border-[#F2EEF9] min-w-[150px] align-top">
                  <PartnerPicker
                    value={l.partnerId}
                    onChange={(id) => updateLine(l.key, { partnerId: id, partnerTouched: true })}
                    placeholder="ไม่ระบุ"
                  />
                  {isArApAccount(l.accountId) && !l.partnerId && (
                    <div className="text-[10px] font-semibold text-[#B45309] mt-0.5">บัญชีลูกหนี้/เจ้าหนี้ — ควรระบุคู่ค้า</div>
                  )}
                </td>
                <td className="px-2.5 py-1.5 border-b border-[#F2EEF9] min-w-[160px]">
                  <input value={l.label} onChange={(e) => updateLine(l.key, { label: e.target.value })} className={inputCls} placeholder="คำอธิบายรายการ" />
                </td>
                <td className="px-2.5 py-1.5 border-b border-[#F2EEF9] w-32">
                  <input
                    value={l.debit}
                    onChange={(e) => updateLine(l.key, { debit: e.target.value, credit: e.target.value.trim() ? '0.00' : l.credit })}
                    className={`${inputCls} text-right tabular-nums ${l.debit.trim() && !isValidMoneyInput(l.debit) ? 'border-rose-400' : ''}`}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </td>
                <td className="px-2.5 py-1.5 border-b border-[#F2EEF9] w-32">
                  <input
                    value={l.credit}
                    onChange={(e) => updateLine(l.key, { credit: e.target.value, debit: e.target.value.trim() ? '0.00' : l.debit })}
                    className={`${inputCls} text-right tabular-nums ${l.credit.trim() && !isValidMoneyInput(l.credit) ? 'border-rose-400' : ''}`}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </td>
                <td className="px-2 py-1.5 border-b border-[#F2EEF9] text-right">
                  <button onClick={() => removeLine(l.key)} disabled={lines.length <= 2} className="text-[#726C86] hover:text-rose-600 disabled:opacity-30">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="px-2.5 py-2 text-right font-bold text-[12.5px] border-t border-[#E9E4F2] whitespace-nowrap">รวมเดบิต / รวมเครดิต / ผลต่าง</td>
              <td className="px-2.5 py-2 text-right font-bold text-[12.5px] tabular-nums border-t border-[#E9E4F2]">{formatMoneyDisplay(debitTotal)}</td>
              <td className="px-2.5 py-2 text-right font-bold text-[12.5px] tabular-nums border-t border-[#E9E4F2]">{formatMoneyDisplay(creditTotal)}</td>
              <td className={`px-2.5 py-2 text-right font-bold text-[12.5px] tabular-nums border-t border-[#E9E4F2] ${isZeroMoney(diff) ? 'text-[#0F9D58]' : 'text-[#DC2626]'}`}>
                {formatMoneyDisplay(diff)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <button onClick={addLine} className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-[#6D28D9] mb-3">
        <Plus size={14} /> เพิ่มบรรทัด
      </button>

      {!isZeroMoney(diff) && (
        <div className="mb-3 text-[12px] text-[#B45309] bg-[#FEF3E2] border border-[#F5E6CC] rounded-lg px-3 py-2">
          เดบิตกับเครดิตยังไม่เท่ากัน (ผลต่าง {formatMoneyDisplay(diff)}) — บันทึกและผ่านรายการได้เมื่อยอดเท่ากันเท่านั้น
        </div>
      )}
      {err && <div className="mb-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{err}</div>}

      <div className="flex gap-2 items-center flex-wrap">
        <button
          onClick={() => void save()}
          disabled={!canSave || saving || posting}
          className="bg-white border-[1.5px] border-[#6D28D9] text-[#6D28D9] rounded-lg px-4 py-2 font-bold text-[13px] disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          {saving && <Loader2 size={14} className="animate-spin" />} บันทึกร่าง
        </button>
        <button
          onClick={() => setConfirmPost(true)}
          disabled={!canSave || saving || posting}
          className="bg-[#6D28D9] text-white rounded-lg px-4 py-2 font-bold text-[13px] disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          {posting && <Loader2 size={14} className="animate-spin" />} ตรวจสอบและผ่านรายการ
        </button>
        <button onClick={onCancel} className="text-[13px] font-bold text-[#726C86]">ยกเลิก</button>
      </div>

      {confirmPost && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setConfirmPost(false)}>
          <div className="bg-white rounded-xl p-4 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="font-extrabold text-[15px] text-[#1E1A2B] mb-2">ยืนยันผ่านรายการ</div>
            <div className="text-[12.5px] text-[#403A54] mb-3">
              เมื่อผ่านรายการแล้ว รายการนี้จะไม่สามารถแก้ไขได้อีก (แก้ไขได้ด้วยการกลับรายการเท่านั้น) ต้องการบันทึกและผ่านรายการนี้หรือไม่?
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmPost(false)} className="bg-white border border-[#E9E4F2] text-[#403A54] rounded-lg px-3.5 py-1.5 font-bold text-[12.5px]">ยกเลิก</button>
              <button onClick={() => void postNow()} disabled={posting} className="bg-[#6D28D9] text-white rounded-lg px-3.5 py-1.5 font-bold text-[12.5px] disabled:opacity-50 inline-flex items-center gap-1.5">
                {posting && <Loader2 size={13} className="animate-spin" />} ผ่านรายการ
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
