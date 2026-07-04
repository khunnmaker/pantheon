import { useState } from 'react';
import { Crown, LogIn, Loader2, AlertTriangle, ShieldCheck, ChevronRight, ArrowLeft } from 'lucide-react';
import { login, setSession, type Agent } from './lib/api';
import { ROLE_GROUPS, SUPERVISOR_EMAIL, type Person, type RoleGroup } from './lib/roster';

const PIN_LEN = 6;

// The "หัวหน้า" (boss) marker + shield are the SUPERVISOR's alone — not "anyone with a
// password". Nee (MD) also logs in with a password now, so key the tag on identity, not cred.
const isSupervisor = (p: Person) => p.email === SUPERVISOR_EMAIL;

// Suite login standard: no credential box until a name is tapped; then Dr. M & Nee (MD) type a
// password, everyone else a masked auto-submit 6-digit PIN. The picker is a 3-level DRILL-DOWN:
//   L1 departments (the 6 ROLE_GROUPS) → tap one hides its siblings and shows
//   L2 that group's name cards → tap one hides its siblings and shows
//   L3 the person + credential input.
// Each deeper level has a back button that pops exactly ONE level (clears the deeper selection
// first). State is minimal: selectedGroupId + selectedEmail, both nullable.
export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Derive the current group/person from the two ids — no duplicated object state to drift.
  const group = selectedGroupId ? ROLE_GROUPS.find((g) => g.id === selectedGroupId) ?? null : null;
  const selected =
    group && selectedEmail ? group.members.find((p) => p.email === selectedEmail) ?? null : null;

  async function submit(person: Person, value: string) {
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(person.email, value);
      setSession(token, agent);
      onLogin(agent);
    } catch {
      // Never echo the PIN/password back; a generic message avoids account enumeration too.
      setError(person.cred === 'pin' ? 'PIN ไม่ถูกต้อง' : 'รหัสผ่านไม่ถูกต้อง');
      setSecret('');
    } finally {
      setBusy(false);
    }
  }

  // L1 → L2: drill into a department (hides the other departments).
  function pickGroup(g: RoleGroup) {
    setSelectedGroupId(g.id);
    setSelectedEmail(null);
    setSecret('');
    setError('');
  }
  // L2 → L3: drill into a person (hides the other names).
  function pickPerson(p: Person) {
    if (p.comingSoon || !p.email) return; // disabled card — never selectable/submittable.
    setSelectedEmail(p.email);
    setSecret('');
    setError('');
  }
  // Back pops exactly one level, clearing the deeper selection first, and resets typed secret/error.
  function back() {
    if (selectedEmail) setSelectedEmail(null);
    else setSelectedGroupId(null);
    setSecret('');
    setError('');
  }

  // A PIN auto-submits once it reaches 6 digits (masked, digits only).
  function onPinChange(v: string) {
    if (!selected) return;
    const digits = v.replace(/\D/g, '').slice(0, PIN_LEN);
    setSecret(digits);
    if (digits.length === PIN_LEN) void submit(selected, digits);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 to-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-violet-100 max-w-sm w-full p-6">
        <div className="flex items-center gap-2 text-violet-700 mb-1">
          <Crown size={24} />
          <h1 className="text-xl font-bold">Jupiter</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">พอร์ทัลทีมงาน · เลือกชื่อเพื่อเข้าสู่ระบบ</p>

        {!group ? (
          // ── Level 1: departments (root, no back button) ──
          <DepartmentList onPick={pickGroup} />
        ) : !selected ? (
          // ── Level 2: names within the selected department ──
          <div>
            <BackButton onClick={back} />
            <h2 className="text-sm font-semibold text-slate-700 mb-3">{group.label}</h2>
            <NameList group={group} onPick={pickPerson} />
          </div>
        ) : (
          // ── Level 3: the selected person + their credential input ──
          <div>
            <BackButton onClick={back} />
            <div className="flex items-center gap-2 mb-4">
              <div className={`w-9 h-9 rounded-full text-white flex items-center justify-center text-sm font-bold ${isSupervisor(selected) ? 'bg-violet-600' : 'bg-slate-500'}`}>
                {selected.label.charAt(0)}
              </div>
              <div>
                <div className="font-semibold text-sm">{selected.label}</div>
                {isSupervisor(selected) && (
                  <div className="flex items-center gap-1 text-[11px] text-violet-600"><ShieldCheck size={11} /> หัวหน้า</div>
                )}
              </div>
            </div>

            {selected.cred === 'password' ? (
              <>
                <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
                <input
                  type="password"
                  autoFocus
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit(selected, secret)}
                  className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
                <button
                  onClick={() => submit(selected, secret)}
                  disabled={busy || !secret}
                  className="w-full px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
                </button>
              </>
            ) : (
              <>
                <label className="block text-xs font-semibold text-slate-500 mb-1">PIN 6 หลัก</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  autoComplete="one-time-code"
                  value={secret}
                  onChange={(e) => onPinChange(e.target.value)}
                  placeholder="••••••"
                  className="w-full px-3 py-2 mb-1 rounded-xl border border-slate-300 text-center tracking-[0.5em] text-lg focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
                <div className="h-5 flex items-center justify-center">
                  {busy && <Loader2 size={16} className="animate-spin text-violet-500" />}
                </div>
              </>
            )}

            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mt-1">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Finger-sized, obviously-tappable back button, placed consistently at the card's top-left.
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-3 py-2 -ml-2 mb-3 rounded-lg text-sm font-medium text-slate-500 hover:text-violet-600 hover:bg-violet-50"
    >
      <ArrowLeft size={16} /> กลับ
    </button>
  );
}

function PersonCard({ p, onPick }: { p: Person; onPick: (p: Person) => void }) {
  // Disabled "coming soon" card — greyed, not tappable (no account provisioned yet).
  if (p.comingSoon) {
    return (
      <div
        aria-disabled="true"
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-slate-100 bg-slate-50 text-left opacity-60 cursor-not-allowed select-none"
      >
        <div className="w-8 h-8 rounded-full bg-slate-300 text-white flex items-center justify-center text-xs font-bold shrink-0">
          {p.label.charAt(0)}
        </div>
        <span className="text-sm font-medium flex-1 text-slate-400">{p.label}</span>
        <span className="text-[11px] text-slate-400">เร็วๆ นี้</span>
      </div>
    );
  }
  return (
    <button
      onClick={() => onPick(p)}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-slate-200 hover:border-violet-300 hover:bg-violet-50 text-left"
    >
      <div className={`w-8 h-8 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0 ${isSupervisor(p) ? 'bg-violet-600' : 'bg-slate-400'}`}>
        {p.label.charAt(0)}
      </div>
      <span className="text-sm font-medium flex-1">{p.label}</span>
      {isSupervisor(p) && <ShieldCheck size={14} className="text-violet-500" />}
      <ChevronRight size={15} className="text-slate-300" />
    </button>
  );
}

// Level 2: the names inside one department. An empty department (สโตร์) shows a subtle
// empty state instead of cards; the back button (rendered by the caller) still returns to L1.
function NameList({ group, onPick }: { group: RoleGroup; onPick: (p: Person) => void }) {
  if (group.members.length === 0) {
    return <div className="px-3 py-2 text-xs text-slate-400">ยังไม่มีรายชื่อ</div>;
  }
  return (
    <div className="space-y-2">
      {group.members.map((p) => (
        <PersonCard key={p.email || p.label} p={p} onPick={onPick} />
      ))}
    </div>
  );
}

// Level 1: the departments (root). Tapping one drills into that group's names.
function DepartmentList({ onPick }: { onPick: (g: RoleGroup) => void }) {
  return (
    <div className="space-y-2">
      {ROLE_GROUPS.map((g) => (
        <button
          key={g.id}
          onClick={() => onPick(g)}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 hover:border-violet-300 hover:bg-violet-50 text-left text-sm font-semibold text-slate-600"
        >
          <span className="flex-1">{g.label}</span>
          <span className="text-xs font-normal text-slate-400">({g.members.length})</span>
          <ChevronRight size={16} className="text-slate-300" />
        </button>
      ))}
    </div>
  );
}
