import { useEffect, useMemo, useRef, useState } from 'react';
import { Crown, ArrowLeft, Loader2, Sparkles, Plus, X, Trash2, Users, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import {
  acctCompanies,
  acctSummary,
  acctTxns,
  acctCreateTxn,
  acctDeleteTxn,
  acctRegisters,
  acctParse,
  acctSyncJuno,
  acctPartyBackfillDry,
  acctPartyBackfillApply,
  acctPartyStatus,
  type AcctCompany,
  type AcctSummary,
  type AcctTxn,
  type AcctRegisters,
  type ProposedTxn,
  type Direction,
  type BackfillSummary,
  type BackfillStatus,
} from './lib/api';

// Jupiter accounting cockpit (Phase 1) — the owner's consolidated income/expense view over the
// 5 group companies + a monthly close pack. Supervisor-only; gated by the caller in App.tsx.
// Three tabs (ภาพรวม / บันทึกรายการ / ปิดรอบบัญชี) matching the owner-approved prototype.
// All data is REAL (from /api/jupiter/acct/*); no sample arrays.

const ALL = 'ALL';

// ฿ formatter — rounded, thousands-separated (matches the prototype's B()).
const B = (n: number) => '฿' + Math.round(n).toLocaleString('en-US');

// Current YYYY-MM (server defaults to this too; we send it so the header label is honest).
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// A Buddhist-era month label for the header, e.g. "กรกฎาคม 2568".
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function thMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return `${TH_MONTHS[m - 1]} ${y + 543}`;
}

// Short Thai date for a ledger row, e.g. "08 ก.ค.".
const TH_MON_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function shortThDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${TH_MON_SHORT[d.getMonth()]}`;
}

const toNum = (s: string) => {
  const n = parseFloat(String(s).replace(/[,\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
};

type Tab = 'overview' | 'ledger' | 'close';

export default function Accounting({ onBack }: { onBack: () => void }) {
  const month = currentMonth();
  const [tab, setTab] = useState<Tab>('overview');
  const [company, setCompany] = useState<string>(ALL); // ALL or a company code

  const [companies, setCompanies] = useState<AcctCompany[]>([]);
  const [summary, setSummary] = useState<AcctSummary | null>(null);
  const [registers, setRegisters] = useState<AcctRegisters | null>(null);
  const [txns, setTxns] = useState<AcctTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const colorOf = useMemo(() => {
    const m = new Map(companies.map((c) => [c.code, c.color]));
    return (code: string) => m.get(code) ?? '#6D28D9';
  }, [companies]);
  const nameOf = useMemo(() => {
    const m = new Map(companies.map((c) => [c.code, c.name]));
    return (code: string) => m.get(code) ?? code;
  }, [companies]);

  // Load the shared reference + month data once (and when the month is fixed to current).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([acctCompanies(), acctSummary(month), acctRegisters(month)])
      .then(([c, s, r]) => {
        if (!alive) return;
        setCompanies(c);
        setSummary(s);
        setRegisters(r);
      })
      .catch((e) => { if (alive) setErr(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month]);

  // Ledger reloads when the company filter changes (server-side filter).
  const reloadTxns = () => {
    acctTxns({ month, company: company === ALL ? undefined : company, limit: 200 })
      .then(setTxns)
      .catch((e) => setErr(String(e?.message ?? e)));
  };
  useEffect(() => {
    reloadTxns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, month]);

  // Refresh the money views after any create/delete (so KPIs + registers stay in sync).
  const reloadAll = () => {
    Promise.all([acctSummary(month), acctRegisters(month)])
      .then(([s, r]) => { setSummary(s); setRegisters(r); })
      .catch(() => { /* keep last-good */ });
    reloadTxns();
  };

  // Phase-1b: pull PROM income from Juno (recorded payments) into the books, then refresh.
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const syncJuno = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await acctSyncJuno();
      setSyncMsg(`ดึงจาก Juno สำเร็จ · income ${r.synced} รายการ${r.removed ? ` (นำออก ${r.removed})` : ''}`);
      reloadAll();
    } catch {
      setSyncMsg('ดึงจาก Juno ไม่สำเร็จ');
    } finally {
      setSyncing(false);
    }
  };

  const selectedSummary = useMemo(() => {
    if (!summary) return null;
    const list = company === ALL ? summary.companies : summary.companies.filter((c) => c.code === company);
    const total = list.reduce(
      (s, c) => ({ revenue: s.revenue + c.revenue, expense: s.expense + c.expense, profit: s.profit + c.profit }),
      { revenue: 0, expense: 0, profit: 0 },
    );
    return { list, total };
  }, [summary, company]);

  return (
    <div className="min-h-screen bg-[#F7F5FC] font-sans text-[#403A54]">
      {/* top bar */}
      <header className="bg-gradient-to-r from-[#4C1D95] to-[#6D28D9] text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-5 py-3 flex items-center gap-3 flex-wrap">
          <button onClick={onBack} className="flex items-center gap-1 text-white/85 hover:text-white text-sm">
            <ArrowLeft size={16} /> พอร์ทัล
          </button>
          <div className="flex items-center gap-2 font-extrabold text-base">
            <span className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center">
              <Crown size={17} />
            </span>
            <div className="leading-tight">
              Jupiter
              <small className="block text-[10px] font-semibold opacity-75">ระบบบัญชี · The Pantheon</small>
            </div>
          </div>
          <div className="flex-1" />
          <div className="text-xs sm:text-[12.5px] bg-white/15 rounded-lg px-3 py-1.5 font-semibold">
            รอบเดือน · {thMonthLabel(summary?.month ?? month)}
          </div>
        </div>
      </header>

      {/* company switcher */}
      <div className="bg-white border-b border-[#E9E4F2]">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 flex gap-1.5 overflow-x-auto">
          <Chip active={company === ALL} onClick={() => setCompany(ALL)} all>
            ทั้งหมด
          </Chip>
          {companies.map((c) => (
            <Chip key={c.code} active={company === c.code} onClick={() => setCompany(c.code)} dot={c.color}>
              {c.code}
            </Chip>
          ))}
        </div>
      </div>

      {/* tabs */}
      <div className="bg-white border-b border-[#E9E4F2]">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 flex gap-0.5">
          <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>ภาพรวม</TabBtn>
          <TabBtn active={tab === 'ledger'} onClick={() => setTab('ledger')}>บันทึกรายการ</TabBtn>
          <TabBtn active={tab === 'close'} onClick={() => setTab('close')}>ปิดรอบบัญชี</TabBtn>
        </div>
      </div>

      <main className="max-w-4xl mx-auto p-4">
        {/* Phase-1b: sync PROM income from Juno's recorded payments into the books. */}
        <div className="mb-3 flex items-center gap-3 flex-wrap">
          <button
            onClick={syncJuno}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-50"
          >
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            ดึงรายรับจาก Juno
          </button>
          {syncMsg && <span className="text-xs text-slate-500">{syncMsg}</span>}
        </div>
        {err && (
          <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
            โหลดข้อมูลไม่สำเร็จ: {err}
          </div>
        )}
        {loading && !summary ? (
          <div className="flex items-center gap-2 text-violet-300 py-16 justify-center">
            <Loader2 size={20} className="animate-spin" /> กำลังโหลด…
          </div>
        ) : (
          <>
            {tab === 'overview' && (
              <Overview
                summary={selectedSummary}
                allCompanies={summary?.companies ?? []}
                company={company}
                setCompany={setCompany}
              />
            )}
            {tab === 'ledger' && (
              <Ledger
                companies={companies}
                company={company}
                txns={txns}
                colorOf={colorOf}
                nameOf={nameOf}
                onChanged={reloadAll}
              />
            )}
            {tab === 'close' && <Close registers={registers} company={company} colorOf={colorOf} />}
          </>
        )}

        {/* Supervisor tool: canonical customer identity backfill (Punch #9). */}
        <PartyBackfill />
      </main>

      <footer className="bg-white border-t border-[#E9E4F2] text-center text-[11px] text-[#726C86] py-3 px-4">
        Phase 1 · บัญชีรวมกลุ่ม — แทนที่ Odoo, จ่ายที่เดียว · PROM ดึงจาก Juno/Ceres/Vulcan (Phase 1b) · อีก 4 บริษัทบันทึกตรงนี้
      </footer>
    </div>
  );
}

/* ─────────────────────────── OVERVIEW TAB ─────────────────────────── */

function Overview({
  summary,
  allCompanies,
  company,
  setCompany,
}: {
  summary: { list: AcctSummary['companies']; total: { revenue: number; expense: number; profit: number } } | null;
  allCompanies: AcctSummary['companies'];
  company: string;
  setCompany: (c: string) => void;
}) {
  if (!summary) return null;
  const { total } = summary;
  const margin = total.revenue > 0 ? (total.profit / total.revenue) * 100 : 0;

  // AI-style summary computed from the REAL month data (no sample text). Deterministic
  // rollups: biggest-profit and any loss-making company, plus the consolidated position.
  const insights = useMemo(() => {
    const out: { tag: string; tone: 'a' | 'w' | 'i'; html: string }[] = [];
    const losers = allCompanies.filter((c) => c.profit < 0);
    if (losers.length) {
      out.push({
        tag: 'ด่วน',
        tone: 'a',
        html: `${losers.map((c) => c.code).join(', ')} ขาดทุนในเดือนนี้ — รายจ่ายมากกว่ารายได้`,
      });
    }
    const thin = allCompanies.filter((c) => c.revenue > 0 && c.profit >= 0 && c.profit / c.revenue < 0.1);
    for (const c of thin) {
      out.push({ tag: 'เฝ้าดู', tone: 'w', html: `${c.code}: กำไรบางเพียง ${Math.round((c.profit / c.revenue) * 100)}% ของรายได้` });
    }
    const best = [...allCompanies].sort((a, b) => b.profit - a.profit)[0];
    if (best && best.profit > 0) {
      out.push({ tag: 'ข้อมูล', tone: 'i', html: `${best.code} ทำกำไรสูงสุด ${B(best.profit)} ในเดือนนี้` });
    }
    out.push({ tag: 'ข้อมูล', tone: 'i', html: `กำไรสุทธิรวมทุกบริษัท ${B(total.profit)} จากรายได้ ${B(total.revenue)}` });
    return out;
  }, [allCompanies, total]);

  const toneCls: Record<string, string> = {
    a: 'bg-[#FDECEC] text-[#DC2626]',
    w: 'bg-[#FEF3E2] text-[#B45309]',
    i: 'bg-[#F3EEFE] text-[#6D28D9]',
  };

  return (
    <section>
      {/* deadline strip (statutory Thai filing due dates — fixed monthly cadence) */}
      <div className="flex gap-2.5 mb-4 flex-wrap">
        {[
          { f: 'ภ.ง.ด.1 · 3 · 53', w: 'หัก ณ ที่จ่าย', due: 'ครบกำหนด วันที่ 7 ของเดือนถัดไป' },
          { f: 'ภ.พ.30', w: 'ภาษีมูลค่าเพิ่ม', due: 'ครบกำหนด วันที่ 15 ของเดือนถัดไป' },
          { f: 'ประกันสังคม', w: 'สปส.1-10', due: 'ครบกำหนด วันที่ 15 ของเดือนถัดไป' },
        ].map((d) => (
          <div key={d.f} className="flex-1 min-w-[150px] bg-white border border-[#E9E4F2] border-l-[3px] border-l-[#B45309] rounded-[10px] px-3.5 py-2.5">
            <div className="font-extrabold text-[#1E1A2B] text-[13px]">{d.f}</div>
            <div className="text-[11px] text-[#726C86]">{d.w}</div>
            <div className="text-[11.5px] font-bold text-[#B45309] mt-0.5">{d.due}</div>
          </div>
        ))}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Kpi accent="#0EA5E9" label="รายได้" value={B(total.revenue)} />
        <Kpi accent="#B45309" label="ค่าใช้จ่าย" value={B(total.expense)} />
        <Kpi accent="#0F9D58" label="กำไรสุทธิ" value={B(total.profit)} sub={`${margin.toFixed(0)}% margin`} subTone={total.profit >= 0 ? 'up' : 'down'} />
        <Kpi accent="#7C3AED" label="จำนวนบริษัท" value={String(allCompanies.length)} sub="ในกลุ่ม" />
      </div>

      {/* split: per-company table + AI summary */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-3.5">
        <div className="bg-white border border-[#E9E4F2] rounded-xl overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B]">
            แยกตามบริษัท <span className="text-[#726C86] font-normal text-[11.5px]">· {allCompanies.length ? '' : 'ไม่มีข้อมูล'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {['บริษัท', 'รายได้', 'ค่าใช้จ่าย', 'กำไร', '%'].map((h, i) => (
                    <th key={h} className={`px-3.5 py-2.5 text-[10px] uppercase tracking-wide text-[#726C86] font-bold border-b border-[#F2EEF9] ${i === 0 ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allCompanies.map((c) => {
                  const pct = c.revenue > 0 ? (c.profit / c.revenue) * 100 : 0;
                  return (
                    <tr
                      key={c.code}
                      onClick={() => setCompany(company === c.code ? ALL : c.code)}
                      className={`cursor-pointer hover:bg-[#F3EEFE] ${company === c.code ? 'bg-[#F3EEFE]' : ''}`}
                    >
                      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-left">
                        <span className="inline-flex items-center gap-1.5 font-bold text-[#1E1A2B]">
                          <span className="w-2 h-2 rounded-full" style={{ background: c.color }} />
                          {c.code}
                        </span>{' '}
                        <span className="text-[#726C86]">{c.name}</span>
                      </td>
                      <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums">{B(c.revenue)}</td>
                      <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums text-[#726C86]">{B(c.expense)}</td>
                      <td className={`px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums font-bold ${c.profit >= 0 ? 'text-[#0F9D58]' : 'text-[#DC2626]'}`}>{B(c.profit)}</td>
                      <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums">{pct.toFixed(0)}%</td>
                    </tr>
                  );
                })}
                {!allCompanies.length && (
                  <tr><td colSpan={5} className="px-3.5 py-6 text-center text-[#726C86] text-sm">ยังไม่มีรายการในเดือนนี้</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-gradient-to-b from-[#F3EEFE] to-white border border-[#E9E4F2] rounded-xl overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B] flex items-center gap-1.5">
            <Sparkles size={14} className="text-[#6D28D9]" /> AI สรุปให้
          </div>
          {insights.map((i, idx) => (
            <div key={idx} className="px-3.5 py-2.5 border-b border-[#F2EEF9] last:border-0 text-[12.4px] flex gap-2.5 items-start">
              <span className={`text-[9.5px] font-extrabold tracking-wide px-1.5 py-0.5 rounded shrink-0 mt-px ${toneCls[i.tone]}`}>{i.tag}</span>
              <div className="text-[#403A54]">{i.html}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── LEDGER TAB ─────────────────────────── */

function Ledger({
  companies,
  company,
  txns,
  colorOf,
  nameOf,
  onChanged,
}: {
  companies: AcctCompany[];
  company: string;
  txns: AcctTxn[];
  colorOf: (code: string) => string;
  nameOf: (code: string) => string;
  onChanged: () => void;
}) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [proposed, setProposed] = useState<(ProposedTxn & { via?: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);

  async function runParse(input?: string) {
    const t = (input ?? text).trim();
    if (!t) return;
    setParsing(true);
    setParseErr(null);
    setProposed(null);
    try {
      const res = await acctParse(t);
      if (res.ok && res.proposed) setProposed({ ...res.proposed, via: res.via });
      else setParseErr('แปลงข้อความไม่สำเร็จ ลองพิมพ์ใหม่หรือกรอกในฟอร์ม');
    } catch (e) {
      setParseErr(String((e as Error)?.message ?? e));
    } finally {
      setParsing(false);
    }
  }

  async function saveProposed() {
    if (!proposed) return;
    setSaving(true);
    try {
      await acctCreateTxn({
        companyCode: proposed.companyCode,
        direction: proposed.direction,
        party: proposed.party,
        category: proposed.category,
        amount: proposed.amount,
        vatAmount: proposed.vatAmount,
        whtAmount: proposed.whtAmount,
        note: proposed.note,
      });
      setProposed(null);
      setText('');
      onChanged();
    } catch (e) {
      setParseErr(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const CHIPS = [
    'จ่ายค่าเช่าออฟฟิศ 30,000 TONR',
    'ขายของให้คลินิกสไมล์ 128,000 PROM',
    'จ่ายค่าแล็บ DentalPort 36,000 DENC',
  ];

  return (
    <section>
      {/* AI natural-language entry */}
      <div className="bg-white border-[1.5px] border-[#D9C9FB] rounded-xl p-3.5 mb-4 shadow-[0_2px_12px_rgba(109,40,217,0.06)]">
        <div className="flex items-center gap-2 font-bold text-[#4C1D95] text-[13.5px] mb-2.5">
          <Sparkles size={15} /> บันทึกด้วยภาษาคน — พิมพ์แล้ว AI ลงบัญชีให้
        </div>
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runParse(); }}
            placeholder="เช่น: จ่ายค่าเช่าออฟฟิศ 30,000 TONR"
            className="flex-1 border border-[#E9E4F2] rounded-[9px] px-3 py-2.5 text-[13px] focus:outline-none focus:border-[#6D28D9] focus:ring-2 focus:ring-[#F3EEFE]"
          />
          <button
            onClick={() => runParse()}
            disabled={parsing || !text.trim()}
            className="bg-[#6D28D9] text-white rounded-[9px] px-4 font-bold text-[13px] disabled:opacity-50 flex items-center gap-1.5"
          >
            {parsing ? <Loader2 size={15} className="animate-spin" /> : null} ลงบัญชี
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap mt-2.5">
          {CHIPS.map((c) => (
            <button
              key={c}
              onClick={() => { setText(c); runParse(c); }}
              className="text-[11.5px] bg-[#F3EEFE] text-[#4C1D95] border border-[#E3D8FB] rounded-full px-3 py-1 hover:bg-[#E9DEFC]"
            >
              {c}
            </button>
          ))}
        </div>

        {parseErr && <div className="mt-2.5 text-[12px] text-rose-600">{parseErr}</div>}

        {proposed && (
          <div className="mt-3 border border-dashed border-[#6D28D9] rounded-[10px] p-3 bg-[#F3EEFE]">
            <div className="text-[11px] font-extrabold text-[#4C1D95] tracking-wide mb-1.5 flex items-center gap-1.5">
              <Sparkles size={12} /> AI เสนอรายการนี้
              {proposed.via === 'heuristic' && (
                <span className="text-[9px] font-bold bg-[#FEF3E2] text-[#B45309] px-1.5 py-0.5 rounded">ตีความอัตโนมัติ</span>
              )}
            </div>
            <PRow k="ประเภท" v={<Pill dir={proposed.direction} />} />
            <PRow k="บริษัท" v={`${proposed.companyCode} · ${nameOf(proposed.companyCode)}`} />
            <PRow k="หมวด" v={proposed.category || '–'} />
            {proposed.party && <PRow k="คู่ค้า / รายการ" v={proposed.party} />}
            <PRow k="จำนวนเงิน (สุทธิ)" v={<b>{B(toNum(proposed.amount))}</b>} />
            {toNum(proposed.vatAmount) > 0 && <PRow k="VAT" v={B(toNum(proposed.vatAmount))} />}
            {toNum(proposed.whtAmount) > 0 && <PRow k="หัก ณ ที่จ่าย" v={'−' + B(toNum(proposed.whtAmount))} />}
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={saveProposed}
                disabled={saving || !proposed.amount}
                className="bg-[#0F9D58] text-white rounded-lg px-3.5 py-1.5 font-bold text-[12.5px] disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : null} ✓ บันทึกลงบัญชี
              </button>
              <button
                onClick={() => setProposed(null)}
                className="bg-white border border-[#E9E4F2] text-[#403A54] rounded-lg px-3.5 py-1.5 font-bold text-[12.5px]"
              >
                ยกเลิก
              </button>
            </div>
          </div>
        )}
      </div>

      {/* manual add-transaction toggle */}
      <div className="mb-4">
        <button
          onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1.5 text-[13px] font-bold text-[#6D28D9] hover:text-[#4C1D95]"
        >
          {showForm ? <X size={15} /> : <Plus size={15} />} {showForm ? 'ปิดฟอร์ม' : 'เพิ่มรายการเอง (กรอกฟอร์ม)'}
        </button>
        {showForm && (
          <ManualForm
            companies={companies}
            defaultCompany={company === ALL ? companies[0]?.code ?? '' : company}
            onSaved={() => { setShowForm(false); onChanged(); }}
          />
        )}
      </div>

      {/* ledger table */}
      <div className="bg-white border border-[#E9E4F2] rounded-xl overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B]">
          รายการล่าสุด <span className="text-[#726C86] font-normal text-[11.5px]">· {txns.length} รายการ</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['วันที่', 'บริษัท', 'คู่ค้า / รายการ', 'หมวด', 'VAT', 'หัก ณ ที่จ่าย', 'จำนวนเงิน', ''].map((h, i) => (
                  <th key={i} className={`px-3.5 py-2.5 text-[10px] uppercase tracking-wide text-[#726C86] font-bold border-b border-[#F2EEF9] ${i <= 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <LedgerRow key={t.id} t={t} colorOf={colorOf} onChanged={onChanged} />
              ))}
              {!txns.length && (
                <tr><td colSpan={8} className="px-3.5 py-6 text-center text-[#726C86] text-sm">ยังไม่มีรายการ — เริ่มบันทึกด้านบน</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function LedgerRow({ t, colorOf, onChanged }: { t: AcctTxn; colorOf: (code: string) => string; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  async function del() {
    if (!confirm(`ลบรายการนี้? (${t.party || t.category || t.amount})`)) return;
    setDeleting(true);
    try {
      await acctDeleteTxn(t.id);
      onChanged();
    } finally {
      setDeleting(false);
    }
  }
  const vat = toNum(t.vatAmount);
  const wht = toNum(t.whtAmount);
  return (
    <tr className="hover:bg-[#F3EEFE] group">
      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-[#726C86] tabular-nums text-left">{shortThDate(t.date)}</td>
      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-left">
        <span className="inline-flex items-center gap-1.5 font-bold text-[#1E1A2B] text-[12px]">
          <span className="w-2 h-2 rounded-full" style={{ background: colorOf(t.companyCode) }} />
          {t.companyCode}
        </span>
      </td>
      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-left">{t.party || <span className="text-[#726C86]">—</span>}</td>
      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-[#726C86] text-left">{t.category || '–'}</td>
      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums text-[#726C86]">{vat ? B(vat) : '–'}</td>
      <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums text-[#726C86]">{wht ? B(wht) : '–'}</td>
      <td className={`px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums font-bold ${t.direction === 'income' ? 'text-[#0F9D58]' : 'text-[#DC2626]'}`}>
        {t.direction === 'income' ? '+' : '−'}{B(toNum(t.amount))}
      </td>
      <td className="px-3.5 py-2.5 border-b border-[#F2EEF9] text-right">
        <button onClick={del} disabled={deleting} className="text-[#726C86] hover:text-rose-600 opacity-0 group-hover:opacity-100 transition" title="ลบ">
          {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
      </td>
    </tr>
  );
}

function ManualForm({ companies, defaultCompany, onSaved }: { companies: AcctCompany[]; defaultCompany: string; onSaved: () => void }) {
  const [companyCode, setCompanyCode] = useState(defaultCompany);
  const [direction, setDirection] = useState<Direction>('expense');
  const [party, setParty] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [vatAmount, setVat] = useState('');
  const [whtAmount, setWht] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!companyCode) return setErr('เลือกบริษัท');
    if (!amount.trim()) return setErr('กรอกจำนวนเงิน');
    setSaving(true);
    try {
      await acctCreateTxn({ companyCode, direction, party, category, amount, vatAmount, whtAmount, note });
      onSaved();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'border border-[#E9E4F2] rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:border-[#6D28D9] focus:ring-2 focus:ring-[#F3EEFE] w-full';
  const labelCls = 'text-[11px] font-semibold text-[#726C86] mb-1 block';

  return (
    <div className="mt-3 bg-white border border-[#E9E4F2] rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={labelCls}>บริษัท</label>
        <select value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} className={inputCls}>
          {companies.map((c) => (
            <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>ประเภท</label>
        <div className="flex gap-2">
          {(['income', 'expense'] as Direction[]).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`flex-1 rounded-lg px-3 py-2 text-[12.5px] font-bold border ${direction === d ? (d === 'income' ? 'bg-[#E9F7EF] border-[#0F9D58] text-[#0F9D58]' : 'bg-[#FDECEC] border-[#DC2626] text-[#DC2626]') : 'bg-white border-[#E9E4F2] text-[#726C86]'}`}
            >
              {d === 'income' ? 'รายรับ' : 'รายจ่าย'}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className={labelCls}>คู่ค้า / ลูกค้า</label>
        <input value={party} onChange={(e) => setParty(e.target.value)} className={inputCls} placeholder="ชื่อคู่ค้า" />
      </div>
      <div>
        <label className={labelCls}>หมวด</label>
        <input value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls} placeholder="เช่น ค่าเช่า, ขายสินค้า" />
      </div>
      <div>
        <label className={labelCls}>จำนวนเงินสุทธิ (บาท)</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} placeholder="30000" inputMode="decimal" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>VAT</label>
          <input value={vatAmount} onChange={(e) => setVat(e.target.value)} className={inputCls} placeholder="0" inputMode="decimal" />
        </div>
        <div>
          <label className={labelCls}>หัก ณ ที่จ่าย</label>
          <input value={whtAmount} onChange={(e) => setWht(e.target.value)} className={inputCls} placeholder="0" inputMode="decimal" />
        </div>
      </div>
      <div className="sm:col-span-2">
        <label className={labelCls}>หมายเหตุ</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="(ไม่บังคับ)" />
      </div>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="bg-[#6D28D9] text-white rounded-lg px-4 py-2 font-bold text-[13px] disabled:opacity-50 flex items-center gap-1.5">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} บันทึกรายการ
        </button>
        {err && <span className="text-[12px] text-rose-600">{err}</span>}
      </div>
    </div>
  );
}

/* ─────────────────────────── CLOSE TAB ─────────────────────────── */

function Close({ registers, company, colorOf }: { registers: AcctRegisters | null; company: string; colorOf: (code: string) => string }) {
  if (!registers) return null;
  const rows = company === 'ALL' ? registers.companies : registers.companies.filter((c) => c.code === company);

  return (
    <section>
      <h2 className="text-[11px] tracking-[0.13em] uppercase text-[#726C86] font-extrabold mb-2.5">
        เช็กลิสต์ปิดรอบ · {thMonthLabel(registers.month)} — ทะเบียนภาษีต่อบริษัท
      </h2>

      <div className="bg-white border border-[#E9E4F2] rounded-xl overflow-hidden mb-4">
        <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B]">
          ทะเบียนสำหรับส่งสำนักงานบัญชี <span className="text-[#726C86] font-normal text-[11.5px]">· พร้อม export</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {['บริษัท', 'ขาย', 'ภาษีขาย', 'ซื้อ/จ่าย', 'ภาษีซื้อ', 'หัก ณ ที่จ่าย', 'VAT สุทธิ'].map((h, i) => (
                  <th key={h} className={`px-3.5 py-2.5 text-[10px] uppercase tracking-wide text-[#726C86] font-bold border-b border-[#F2EEF9] ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.code} className="hover:bg-[#F3EEFE]">
                  <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-left">
                    <span className="inline-flex items-center gap-1.5 font-bold text-[#1E1A2B]">
                      <span className="w-2 h-2 rounded-full" style={{ background: colorOf(c.code) }} />
                      {c.code}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums">{B(c.sales)}</td>
                  <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums">{B(c.outputVat)}</td>
                  <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums text-[#726C86]">{B(c.purchases)}</td>
                  <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums text-[#726C86]">{B(c.inputVat)}</td>
                  <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums text-[#726C86]">{B(c.wht)}</td>
                  <td className={`px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-right tabular-nums font-bold ${c.vatNet >= 0 ? 'text-[#0F9D58]' : 'text-[#DC2626]'}`}>{B(c.vatNet)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={7} className="px-3.5 py-6 text-center text-[#726C86] text-sm">ไม่มีข้อมูล</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* filing checklist — statutory Thai filings, status derived from whether the register has data */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {[
          { f: 'ภ.ง.ด.1', d: 'หัก ณ ที่จ่าย เงินเดือน', due: '7 ของเดือนถัดไป' },
          { f: 'ภ.ง.ด.3 / 53', d: 'หัก ณ ที่จ่าย ค่าบริการ', due: '7 ของเดือนถัดไป' },
          { f: 'ภ.พ.30', d: 'ภาษีมูลค่าเพิ่ม', due: '15 ของเดือนถัดไป' },
          { f: 'ประกันสังคม', d: 'สปส.1-10', due: '15 ของเดือนถัดไป' },
        ].map((f) => (
          <div key={f.f} className="bg-white border border-[#E9E4F2] rounded-[11px] px-3.5 py-3">
            <div className="flex justify-between items-baseline">
              <span className="font-extrabold text-[#4C1D95] text-[14px]">{f.f}</span>
              <span className="text-[11px] font-bold text-[#B45309]">ครบ {f.due}</span>
            </div>
            <div className="text-[11.5px] text-[#726C86] mt-0.5 mb-2">{f.d}</div>
            <div className="flex gap-1.5 flex-wrap">
              {rows.map((c) => {
                const hasData = f.f === 'ภ.พ.30' ? c.sales > 0 || c.purchases > 0 : f.f.startsWith('ภ.ง.ด') ? c.wht > 0 : true;
                const cls = hasData ? 'bg-[#FEF3E2] text-[#B45309]' : 'bg-[#F1F0F5] text-[#726C86]';
                const label = hasData ? 'รอยื่น' : 'ไม่มี';
                return (
                  <span key={c.code} className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${cls}`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {c.code} · {label}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────── PARTY BACKFILL (supervisor tool · Punch #9) ─────────────────── */

// Human labels for the identity channels the backfill populates.
const CHANNEL_LABELS: Record<string, string> = {
  line_user: 'LINE',
  oa_chat: 'OA chat',
  express_code: 'รหัส Express',
  diana_email: 'อีเมล Diana',
  agent_email: 'อีเมลตัวแทน',
  ceres_name: 'ชื่อ (Ceres)',
  phone: 'เบอร์โทร',
  vendor_local: 'ผู้ขาย',
};
const channelLabel = (ch: string) => CHANNEL_LABELS[ch] ?? ch;

// Collapsible admin panel: dry-run (preview) → confirm → apply (background) → poll to done.
// The whole Accounting page is already supervisor-gated, and the routes re-check the role.
function PartyBackfill() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [dry, setDry] = useState<BackfillSummary | null>(null);
  const [dryLoading, setDryLoading] = useState(false);
  const [applying, setApplying] = useState(false); // an apply is in flight (server running)
  const [confirming, setConfirming] = useState(false); // showing the "รันจริง?" confirm step
  const [err, setErr] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = () =>
    acctPartyStatus()
      .then((s) => {
        setStatus(s);
        return s;
      })
      .catch((e) => {
        setErr(String((e as Error)?.message ?? e));
        return null;
      });

  // Load current spine counts when the panel is first opened; adopt a run already in flight.
  useEffect(() => {
    if (!open || status) return;
    refreshStatus().then((s) => {
      if (s?.running) setApplying(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While an apply is running, poll status every 3s until running=false, then show final counts.
  useEffect(() => {
    if (!applying) return;
    pollRef.current = setInterval(async () => {
      const s = await refreshStatus();
      if (s && !s.running) {
        setApplying(false);
        setDry(null);
        setDoneMsg(`รวมข้อมูลเสร็จ · ${s.parties.toLocaleString()} ราย · ${s.identities.toLocaleString()} identity`);
      }
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applying]);

  async function runDry() {
    setDryLoading(true);
    setErr(null);
    setDoneMsg(null);
    setConfirming(false);
    setDry(null);
    try {
      setDry(await acctPartyBackfillDry());
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setDryLoading(false);
    }
  }

  async function runApply() {
    setErr(null);
    setConfirming(false);
    try {
      const r = await acctPartyBackfillApply();
      if (r.started) {
        setApplying(true);
        setDoneMsg(null);
      } else if (r.busy) {
        setApplying(true); // a run is already going — just poll it
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }

  const dryTotalIdentities = dry ? Object.values(dry.identities).reduce((a, b) => a + b, 0) : 0;

  return (
    <section className="mt-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[12px] font-bold text-[#726C86] hover:text-[#4C1D95]"
      >
        <Users size={14} /> รวมข้อมูลลูกค้า (Party backfill)
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="mt-2.5 bg-white border border-[#E9E4F2] rounded-xl p-4">
          <div className="text-[12px] text-[#726C86] mb-3 leading-relaxed">
            รวมลูกค้าที่กระจายอยู่หลายระบบ (LINE · Express · Diana · OA · Ceres) ให้เป็นตัวตนเดียว
            (Party) — ทำครั้งเดียว, รันซ้ำได้ปลอดภัย (idempotent). แนะนำให้กด{' '}
            <b>ตรวจก่อน</b> เพื่อดูผลก่อนรันจริง
          </div>

          {/* live spine counts */}
          <div className="flex gap-2.5 flex-wrap mb-3">
            <CountPill label="Party ปัจจุบัน" value={status ? status.parties.toLocaleString() : '…'} />
            <CountPill label="Identity ปัจจุบัน" value={status ? status.identities.toLocaleString() : '…'} />
            {status?.running && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-[#B45309] bg-[#FEF3E2] rounded-lg px-3 py-1.5">
                <Loader2 size={13} className="animate-spin" /> กำลังรวมข้อมูล…
              </span>
            )}
          </div>

          {/* actions */}
          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={runDry}
              disabled={dryLoading || applying}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3.5 py-1.5 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-50"
            >
              {dryLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              ตรวจก่อน (dry-run)
            </button>
            {dry && !applying && !confirming && (
              <button
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3.5 py-1.5 rounded-lg bg-[#6D28D9] text-white hover:bg-[#5B21B6]"
              >
                รันจริง (apply)
              </button>
            )}
            {doneMsg && <span className="text-[12px] text-[#0F9D58] font-semibold">{doneMsg}</span>}
          </div>

          {err && <div className="mt-2.5 text-[12px] text-rose-600">ผิดพลาด: {err}</div>}

          {/* confirm step */}
          {confirming && dry && (
            <div className="mt-3 border border-dashed border-[#6D28D9] rounded-[10px] p-3 bg-[#F3EEFE]">
              <div className="text-[12.5px] text-[#4C1D95] font-bold mb-2">
                ยืนยันรันจริง? จะสร้าง Party ~{dry.parties.toLocaleString()} ราย และ{' '}
                {dryTotalIdentities.toLocaleString()} identity (รันซ้ำได้ ไม่สร้างซ้ำ)
              </div>
              <div className="flex gap-2">
                <button
                  onClick={runApply}
                  className="bg-[#0F9D58] text-white rounded-lg px-3.5 py-1.5 font-bold text-[12.5px]"
                >
                  ✓ ยืนยันรันจริง
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="bg-white border border-[#E9E4F2] text-[#403A54] rounded-lg px-3.5 py-1.5 font-bold text-[12.5px]"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          )}

          {/* dry-run result */}
          {dry && (
            <div className="mt-3 border border-[#E9E4F2] rounded-xl overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13px] text-[#1E1A2B] bg-[#FAF8FE]">
                ผลการตรวจ (dry-run) · ยังไม่เขียนข้อมูล
              </div>
              <div className="p-3.5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <MiniStat label="Party ที่จะสร้าง" value={dry.parties.toLocaleString()} />
                <MiniStat label="Identity ที่จะสร้าง" value={dryTotalIdentities.toLocaleString()} />
                <MiniStat
                  label="ชนกัน (ต้องตรวจ)"
                  value={dry.conflicts.toLocaleString()}
                  tone={dry.conflicts > 0 ? 'warn' : undefined}
                />
              </div>

              {/* identities per channel */}
              <div className="px-3.5 pb-3.5 flex flex-wrap gap-1.5">
                {Object.keys(dry.identities).length === 0 && (
                  <span className="text-[12px] text-[#726C86]">ไม่มี identity ใหม่ (ข้อมูลรวมแล้ว)</span>
                )}
                {Object.entries(dry.identities)
                  .sort((a, b) => b[1] - a[1])
                  .map(([ch, n]) => (
                    <span
                      key={ch}
                      className="text-[11px] font-semibold bg-[#F3EEFE] text-[#4C1D95] border border-[#E3D8FB] rounded-full px-2.5 py-1"
                    >
                      {channelLabel(ch)} · {n.toLocaleString()}
                    </span>
                  ))}
              </div>

              {/* conflict sample */}
              {dry.sampleConflicts.length > 0 && (
                <div className="px-3.5 pb-3.5">
                  <div className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#B45309] mb-1.5">
                    <AlertTriangle size={13} /> ตัวอย่างที่ชนกัน (ไม่รวมอัตโนมัติ — ต้องตรวจเอง)
                  </div>
                  <div className="bg-[#FEF9F0] border border-[#F5E6CC] rounded-lg p-2.5 max-h-40 overflow-y-auto">
                    {dry.sampleConflicts.map((c, i) => (
                      <div key={i} className="text-[11px] text-[#8A5A12] font-mono tabular-nums leading-relaxed break-all">
                        {c}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CountPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#F7F5FC] border border-[#E9E4F2] rounded-lg px-3 py-1.5">
      <span className="text-[10.5px] text-[#726C86] font-semibold">{label} </span>
      <span className="text-[12.5px] font-extrabold text-[#1E1A2B] tabular-nums">{value}</span>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div>
      <div className="text-[10.5px] text-[#726C86] font-semibold mb-0.5">{label}</div>
      <div className={`text-[18px] font-extrabold tabular-nums ${tone === 'warn' ? 'text-[#B45309]' : 'text-[#1E1A2B]'}`}>
        {value}
      </div>
    </div>
  );
}

/* ─────────────────────────── small UI atoms ─────────────────────────── */

function Chip({ active, onClick, children, dot, all }: { active: boolean; onClick: () => void; children: React.ReactNode; dot?: string; all?: boolean }) {
  const base = 'border rounded-[9px] px-3 py-1.5 text-[12.5px] font-bold whitespace-nowrap flex items-center gap-1.5 cursor-pointer transition';
  const cls = all
    ? active
      ? 'bg-[#6D28D9] border-[#6D28D9] text-white'
      : 'bg-white border-[#E9E4F2] text-[#726C86]'
    : active
      ? 'bg-[#F3EEFE] border-[#6D28D9] text-[#4C1D95]'
      : 'bg-white border-[#E9E4F2] text-[#726C86]';
  return (
    <button onClick={onClick} className={`${base} ${cls}`}>
      {dot && <span className="w-[7px] h-[7px] rounded-full" style={{ background: dot }} />}
      {children}
    </button>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-3 text-[13.5px] font-bold -mb-px border-b-[2.5px] ${active ? 'text-[#6D28D9] border-[#6D28D9]' : 'text-[#726C86] border-transparent'}`}
    >
      {children}
    </button>
  );
}

function Kpi({ accent, label, value, sub, subTone }: { accent: string; label: string; value: string; sub?: string; subTone?: 'up' | 'down' }) {
  return (
    <div className="bg-white border border-[#E9E4F2] rounded-xl px-3.5 py-3" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="text-[11.5px] text-[#726C86] font-semibold mb-1">{label}</div>
      <div className="text-[21px] font-extrabold text-[#1E1A2B] tracking-tight tabular-nums">{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 font-bold ${subTone === 'down' ? 'text-[#DC2626]' : subTone === 'up' ? 'text-[#0F9D58]' : 'text-[#726C86]'}`}>{sub}</div>}
    </div>
  );
}

function PRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between text-[12.5px] py-0.5">
      <span className="text-[#726C86]">{k}</span>
      <span className="font-bold text-[#1E1A2B]">{v}</span>
    </div>
  );
}

function Pill({ dir }: { dir: Direction }) {
  return (
    <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded ${dir === 'income' ? 'bg-[#E9F7EF] text-[#0F9D58]' : 'bg-[#FDECEC] text-[#DC2626]'}`}>
      {dir === 'income' ? 'รายรับ' : 'รายจ่าย'}
    </span>
  );
}
