import { useEffect, useMemo, useState } from 'react';
import { Loader2, Bot, Sparkles, BarChart3, Cpu } from 'lucide-react';
import { tokenUsage, type TokenUsageResponse } from './lib/api';
import { Chip, Kpi } from './ui';

// "ต้นทุน AI" — the suite-wide king's-eye view of AI token spend: how much, and what for.
// Supervisor-only tab (gated by the caller in Accounting.tsx), backed entirely by the
// read-only GET /api/jupiter/token-usage endpoint (also supervisor-gated server-side).

type PeriodDays = 7 | 30;

// Best-effort feature → app map for the "แยกตามฟีเจอร์" table's per-row app tag.
// /token-usage aggregates byApp and byFeature independently (no joint app+feature
// grouping in the response), so this mirrors the real { app, feature } pairs recorded
// across the codebase (every `callClaude(..., { app, feature })` / `embed(..., { app,
// feature })` call site in api/src). A feature not in this map (e.g. a brand-new one
// added later) simply renders without a tag instead of guessing.
const FEATURE_APP: Record<string, string> = {
  'caption-image': 'minerva',
  'kb-distill': 'minerva',
  'kb-embed': 'minerva',
  'msg-embed': 'minerva',
  'line-draft': 'minerva',
  'sticker-draft': 'minerva',
  prewarm: 'minerva',
  rewrite: 'minerva',
  'slip-ocr': 'minerva',
  'vision-draft': 'minerva',
  'memory-summary': 'minerva',
  'test-draft': 'minerva',
  'cheque-ocr': 'juno',
  'receipt-ocr': 'ceres',
  'payment-gate': 'ceres',
  'expense-check': 'ceres',
  'product-embed': 'diana',
  'search-embed': 'diana',
  'venus-card': 'venus',
  'acct-parse': 'jupiter',
};
const APP_LABELS: Record<string, string> = {
  minerva: 'Minerva',
  juno: 'Juno',
  ceres: 'Ceres',
  diana: 'Diana',
  venus: 'Venus',
  jupiter: 'Jupiter',
  vesta: 'Vesta',
  mercury: 'Mercury',
  apollo: 'Apollo',
};

// Abbreviate large token counts, e.g. 1234567 → "1.2M", 8600 → "8.6K".
function abbr(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('en-US');
}

// USD cost, 2–4 decimals depending on magnitude — small per-call AI costs need more
// precision than a plain toFixed(2) would show (otherwise everything reads as $0.00).
function fmtUsd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const decimals = v === 0 ? 2 : v < 1 ? 4 : v < 10 ? 3 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export default function AiCost() {
  const [period, setPeriod] = useState<PeriodDays>(30);
  const [data, setData] = useState<TokenUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const { from, to } = useMemo(() => {
    const toD = new Date();
    const fromD = new Date(toD.getTime() - period * 24 * 60 * 60 * 1000);
    return { from: fromD.toISOString(), to: toD.toISOString() };
  }, [period]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    tokenUsage({ from, to })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setErr(String((e as Error)?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to]);

  const isEmpty = !!data && data.summary.calls === 0;
  const maxFeatureCost = useMemo(
    () => Math.max(1e-9, ...(data?.byFeature.map((f) => f.estCostUsd) ?? [0])),
    [data],
  );
  const maxDayCost = useMemo(
    () => Math.max(1e-9, ...(data?.byDay.map((d) => d.estCostUsd) ?? [0])),
    [data],
  );

  return (
    <section>
      {/* header + period picker */}
      <div className="flex items-center justify-between flex-wrap gap-2.5 mb-3">
        <h2 className="text-[11px] tracking-[0.13em] uppercase text-[#726C86] font-extrabold flex items-center gap-1.5">
          <Bot size={14} /> ต้นทุน AI — ทั้งสูท The Pantheon
        </h2>
        <div className="flex gap-1.5">
          <Chip active={period === 7} onClick={() => setPeriod(7)} all>7 วัน</Chip>
          <Chip active={period === 30} onClick={() => setPeriod(30)} all>30 วัน</Chip>
        </div>
      </div>

      {err && (
        <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
          โหลดข้อมูลไม่สำเร็จ: {err}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center gap-2 text-violet-300 py-16 justify-center">
          <Loader2 size={20} className="animate-spin" /> กำลังโหลด…
        </div>
      ) : data ? (
        isEmpty ? (
          <div className="bg-white border border-dashed border-[#D9C9FB] rounded-xl px-5 py-12 text-center">
            <Sparkles size={22} className="mx-auto mb-2.5 text-[#B9A6E8]" />
            <div className="text-[13.5px] font-bold text-[#4C1D95] mb-1">ยังไม่มีข้อมูล</div>
            <div className="text-[12.5px] text-[#726C86]">ระบบเพิ่งเริ่มบันทึก ลองดูอีกครั้งเมื่อมีการเรียกใช้ AI ในช่วงเวลานี้</div>
          </div>
        ) : (
          <>
            {/* summary KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 mb-4">
              <Kpi accent="#6D28D9" label="ประมาณการค่าใช้จ่าย" value={fmtUsd(data.summary.estCostUsd)} sub="USD" />
              <Kpi accent="#0EA5E9" label="จำนวนครั้งที่เรียกใช้" value={data.summary.calls.toLocaleString('en-US')} />
              <Kpi accent="#0F9D58" label="Input tokens" value={abbr(data.summary.inputTokens)} />
              <Kpi accent="#B45309" label="Output tokens" value={abbr(data.summary.outputTokens)} />
              <Kpi accent="#7C3AED" label="Cache-read tokens" value={abbr(data.summary.cacheReadTokens)} />
            </div>

            {/* แยกตามฟีเจอร์ — the centerpiece: what the spend is FOR */}
            <div className="bg-white border border-[#E9E4F2] rounded-xl overflow-hidden mb-4">
              <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B] flex items-center gap-1.5">
                <BarChart3 size={15} className="text-[#6D28D9]" /> แยกตามฟีเจอร์
                <span className="text-[#726C86] font-normal text-[11.5px]">· {data.byFeature.length} ฟีเจอร์</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      {['ฟีเจอร์', 'จำนวนครั้ง', 'Input', 'Output', 'ประมาณการ (USD)'].map((h, i) => (
                        <th
                          key={h}
                          className={`px-3.5 py-2.5 text-[10px] uppercase tracking-wide text-[#726C86] font-bold border-b border-[#F2EEF9] ${i === 0 ? 'text-left' : 'text-right'}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.byFeature.map((f) => {
                      const app = FEATURE_APP[f.key];
                      return (
                        <tr key={f.key} className="hover:bg-[#F3EEFE]">
                          <td className="px-3.5 py-2.5 text-[12.7px] border-b border-[#F2EEF9] text-left">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-[#1E1A2B]">{f.key}</span>
                              {app && (
                                <span className="text-[10px] font-semibold bg-[#F3EEFE] text-[#4C1D95] border border-[#E3D8FB] rounded-full px-1.5 py-0.5">
                                  {APP_LABELS[app] ?? app}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums text-[#726C86]">{f.calls.toLocaleString('en-US')}</td>
                          <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums text-[#726C86]">{abbr(f.inputTokens)}</td>
                          <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9] tabular-nums text-[#726C86]">{abbr(f.outputTokens)}</td>
                          <td className="px-3.5 py-2.5 text-[12.7px] text-right border-b border-[#F2EEF9]">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-10 h-1.5 rounded-full bg-[#F2EEF9] overflow-hidden shrink-0">
                                <div
                                  className="h-full bg-[#6D28D9] rounded-full"
                                  style={{ width: `${Math.min(100, (f.estCostUsd / maxFeatureCost) * 100)}%` }}
                                />
                              </div>
                              <span className="tabular-nums font-bold text-[#1E1A2B]">{fmtUsd(f.estCostUsd)}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!data.byFeature.length && (
                      <tr><td colSpan={5} className="px-3.5 py-6 text-center text-[#726C86] text-sm">ไม่มีข้อมูล</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.3fr] gap-3.5">
              {/* แยกตามโมเดล */}
              <div className="bg-white border border-[#E9E4F2] rounded-xl overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B] flex items-center gap-1.5">
                  <Cpu size={14} className="text-[#6D28D9]" /> แยกตามโมเดล
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        {['โมเดล', 'จำนวนครั้ง', 'ประมาณการ (USD)'].map((h, i) => (
                          <th
                            key={h}
                            className={`px-3.5 py-2 text-[10px] uppercase tracking-wide text-[#726C86] font-bold border-b border-[#F2EEF9] ${i === 0 ? 'text-left' : 'text-right'}`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.byModel.map((m) => (
                        <tr key={m.key} className="hover:bg-[#F3EEFE]">
                          <td className="px-3.5 py-2 text-[12.5px] border-b border-[#F2EEF9] text-left font-semibold text-[#1E1A2B]">{m.key}</td>
                          <td className="px-3.5 py-2 text-[12.5px] text-right border-b border-[#F2EEF9] tabular-nums text-[#726C86]">{m.calls.toLocaleString('en-US')}</td>
                          <td className="px-3.5 py-2 text-[12.5px] text-right border-b border-[#F2EEF9] tabular-nums font-bold text-[#1E1A2B]">{fmtUsd(m.estCostUsd)}</td>
                        </tr>
                      ))}
                      {!data.byModel.length && (
                        <tr><td colSpan={3} className="px-3.5 py-6 text-center text-[#726C86] text-sm">ไม่มีข้อมูล</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* รายวัน — plain CSS bar chart (divs sized by estCostUsd), no chart library */}
              <div className="bg-white border border-[#E9E4F2] rounded-xl overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-[#F2EEF9] font-bold text-[13.5px] text-[#1E1A2B]">
                  รายวัน <span className="text-[#726C86] font-normal text-[11.5px]">· ประมาณการ USD ต่อวัน</span>
                </div>
                <div className="p-3.5">
                  {data.byDay.length ? (
                    <div className="flex items-end gap-1 h-32 overflow-x-auto">
                      {data.byDay.map((d) => {
                        const hpct = Math.max(2, (d.estCostUsd / maxDayCost) * 100);
                        return (
                          <div key={d.date} className="flex flex-col items-center justify-end h-full min-w-[10px] flex-1">
                            <div
                              className="w-full max-w-[18px] bg-[#6D28D9] rounded-t-[3px] hover:bg-[#4C1D95] transition"
                              style={{ height: `${hpct}%` }}
                              title={`${d.date} · ${fmtUsd(d.estCostUsd)} · ${d.calls.toLocaleString('en-US')} ครั้ง`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center text-[#726C86] text-sm py-6">ไม่มีข้อมูล</div>
                  )}
                  {data.byDay.length > 0 && (
                    <div className="flex justify-between mt-1.5 text-[10px] text-[#726C86]">
                      <span>{data.byDay[0].date}</span>
                      <span>{data.byDay[data.byDay.length - 1].date}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )
      ) : null}
    </section>
  );
}
