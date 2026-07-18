// Small shared UI atoms used by both Accounting.tsx and AiCost.tsx. Pulled out of
// Accounting.tsx so AiCost can reuse the same look without a circular import
// (Accounting renders AiCost as its "ต้นทุน AI" tab).

export function Chip({ active, onClick, children, dot, all }: { active: boolean; onClick: () => void; children: React.ReactNode; dot?: string; all?: boolean }) {
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

export function Kpi({ accent, label, value, sub, subTone }: { accent: string; label: string; value: string; sub?: string; subTone?: 'up' | 'down' }) {
  return (
    <div className="bg-white border border-[#E9E4F2] rounded-xl px-3.5 py-3" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="text-[11.5px] text-[#726C86] font-semibold mb-1">{label}</div>
      <div className="text-[21px] font-extrabold text-[#1E1A2B] tracking-tight tabular-nums">{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 font-bold ${subTone === 'down' ? 'text-[#DC2626]' : subTone === 'up' ? 'text-[#0F9D58]' : 'text-[#726C86]'}`}>{sub}</div>}
    </div>
  );
}
