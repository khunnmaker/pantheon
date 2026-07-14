import { useEffect, useState } from 'react';
import { Bot, LogIn, Loader2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { login, setSession, getLogins, type Agent, type LoginCard } from './lib/api';
import { groupLogins, type GroupMeta, memberAvatar, teamAvatar } from '@pantheon/ui';

const PIN_LEN = 6;

// Role-grouped, tap-to-drill-down, Metro-tile login picker — the SAME UX as the Pantheon portal
// (pantheon/src/Login.tsx), adapted to Minerva's sky accent. The people come from the server
// (GET /api/auth/logins?app=minerva) — a rich card list carrying group + gender. The picker is a
// 3-level DRILL-DOWN:
//   L1 role groups (2-col Metro grid, solid group color + funEmoji mascot + member count) → tap →
//   L2 that group's people as tiles with each person's adventurer avatar → tap →
//   L3 the person + credential input (password field OR masked auto-submit 6-digit PIN).
// Each deeper level has a "← กลับ" back button that pops exactly one level. The auth mechanism is
// UNCHANGED: submit() still calls login() → setSession() → onLogin(). The manual email/password
// form stays as a fallback for when the card fetch fails.
export default function Login({ onLogin }: { onLogin: (agent: Agent) => void }) {
  const [view, setView] = useState<'list' | 'manual'>('list');
  const [cards, setCards] = useState<LoginCard[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Manual-fallback state.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    getLogins('minerva')
      .then((rows) => { if (!cancelled) setCards(rows); })
      .catch(() => { if (!cancelled) { setLoadFailed(true); setView('manual'); } });
    return () => { cancelled = true; };
  }, []);

  const groups = cards ? groupLogins(cards) : [];
  const group = selectedGroupId ? groups.find((g) => g.meta.id === selectedGroupId) ?? null : null;
  const selected =
    group && selectedEmail ? group.members.find((p) => p.email === selectedEmail) ?? null : null;

  async function submit(useEmail: string, value: string) {
    const em = useEmail.trim();
    if (!em || !value || busy) return;
    setBusy(true);
    setError('');
    try {
      const { token, agent } = await login(em, value);
      setSession(token, agent);
      onLogin(agent);
    } catch {
      setError('รหัสไม่ถูกต้อง');
      setSecret('');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  function pickGroup(g: GroupMeta) {
    setSelectedGroupId(g.id);
    setSelectedEmail(null);
    setSecret('');
    setError('');
  }
  function pickPerson(p: LoginCard) {
    setSelectedEmail(p.email);
    setSecret('');
    setError('');
  }
  function back() {
    if (selectedEmail) setSelectedEmail(null);
    else setSelectedGroupId(null);
    setSecret('');
    setError('');
  }
  function onPinChange(v: string) {
    if (!selected) return;
    const digits = v.replace(/\D/g, '').slice(0, PIN_LEN);
    setSecret(digits);
    if (digits.length === PIN_LEN) void submit(selected.email, digits);
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6 font-sans text-slate-800">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 max-w-md w-full p-6">
        <div className="flex items-center gap-2 text-sky-700 mb-1">
          <Bot size={24} />
          <h1 className="text-xl font-bold">Minerva</h1>
        </div>
        <p className="text-sm text-slate-500 mb-5">คอนโซลพนักงาน · เลือกชื่อเพื่อเข้าสู่ระบบ</p>

        {view === 'list' ? (
          <>
            {!cards ? (
              <div className="py-8 flex justify-center text-slate-400">
                <Loader2 className="animate-spin" size={22} />
              </div>
            ) : !group ? (
              // ── Level 1: role groups ──
              <GroupGrid groups={groups} onPick={pickGroup} />
            ) : !selected ? (
              // ── Level 2: people within the selected group ──
              <div>
                <BackButton onClick={back} />
                <div className={`${group.meta.color} text-white rounded-md px-3 py-2 mb-3`}>
                  <span className="text-sm font-bold">{group.meta.label}</span>
                </div>
                <NameGrid members={group.members} onPick={pickPerson} />
              </div>
            ) : (
              // ── Level 3: the selected person + credential input ──
              <div>
                <BackButton onClick={back} />
                <div className={`${group.meta.color} text-white rounded-md px-4 py-3 mb-4`}>
                  <div className="flex items-center gap-2">
                    <div className="w-12 h-12 rounded-md bg-white/25 overflow-hidden flex items-center justify-center shrink-0">
                      <img src={memberAvatar(selected.email, selected.gender)} alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="font-bold text-base leading-tight">{selected.name}</div>
                  </div>
                </div>

                {selected.kind === 'password' ? (
                  <>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
                    <input
                      type="password"
                      autoFocus
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && submit(selected.email, secret)}
                      className="w-full px-3 py-2 mb-3 rounded-md border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                    />
                    <button
                      onClick={() => submit(selected.email, secret)}
                      disabled={busy || !secret}
                      className="w-full px-3 py-2.5 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
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
                      className="w-full px-3 py-2 mb-1 rounded-md border border-slate-300 text-center tracking-[0.5em] text-lg focus:outline-none focus:ring-2 focus:ring-sky-400"
                    />
                    <div className="h-5 flex items-center justify-center">
                      {busy && <Loader2 size={16} className="animate-spin text-sky-500" />}
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

            <button
              type="button"
              onClick={() => { setView('manual'); setSelectedGroupId(null); setSelectedEmail(null); setError(''); }}
              className="w-full mt-4 text-[11px] text-slate-400 hover:text-slate-600"
            >
              เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน
            </button>
          </>
        ) : (
          <>
            {loadFailed && (
              <div className="text-[11px] text-slate-400 mb-3">โหลดรายชื่อไม่สำเร็จ — เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน</div>
            )}
            <label className="block text-xs font-semibold text-slate-500 mb-1">อีเมล</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(email, password)}
              placeholder="name@prominent.local"
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
            />
            <label className="block text-xs font-semibold text-slate-500 mb-1">รหัสผ่าน</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(email, password)}
              className="w-full px-3 py-2 mb-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
            />
            {error && (
              <div className="flex items-center gap-1 text-rose-600 text-xs mb-3">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            <button
              onClick={() => submit(email, password)}
              disabled={busy}
              className="w-full px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />} เข้าสู่ระบบ
            </button>
            {/* Going back to the card list is pointless when the fetch failed — it would
                just spin forever — so hide the back button on the fallback path. */}
            {!loadFailed && (
              <button
                type="button"
                onClick={() => { setView('list'); setError(''); }}
                className="w-full mt-3 text-[11px] text-slate-400 hover:text-slate-600"
              >
                ย้อนกลับ
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Finger-sized, flat Metro back button, top-left of the card.
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-2 -ml-2 mb-3 rounded-md text-sm font-medium text-slate-500 hover:text-sky-600 hover:bg-slate-100"
    >
      <ArrowLeft size={16} /> กลับ
    </button>
  );
}

// Level 1: role groups as a 2-col grid of solid-color square Metro tiles. Each shows the Thai
// label + a funEmoji mascot + the member count.
function GroupGrid({
  groups,
  onPick,
}: {
  groups: { meta: GroupMeta; members: LoginCard[] }[];
  onPick: (g: GroupMeta) => void;
}) {
  if (groups.length === 0) {
    return <div className="px-1 py-6 text-center text-xs text-slate-400">ยังไม่มีรายชื่อ</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {groups.map(({ meta, members }) => (
        <button
          key={meta.id}
          onClick={() => onPick(meta)}
          className={`${meta.color} relative aspect-square flex flex-col items-center justify-center gap-2 p-2 rounded-md text-white hover:brightness-110 transition`}
        >
          <span className="absolute top-2 right-2.5 text-xs font-semibold text-white/80">{members.length}</span>
          <img src={teamAvatar(meta.id)} alt="" className="w-24 h-24 rounded-full bg-white/90 object-cover" />
          <span className="text-base font-bold leading-tight text-center">{meta.label}</span>
        </button>
      ))}
    </div>
  );
}

// Level 2: the people inside one group, as a 2-col tile grid with each person's avatar.
function NameGrid({ members, onPick }: { members: LoginCard[]; onPick: (p: LoginCard) => void }) {
  if (members.length === 0) {
    return <div className="px-1 py-6 text-center text-xs text-slate-400">ยังไม่มีรายชื่อ</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {members.map((p) => (
        <button
          key={p.email}
          onClick={() => onPick(p)}
          className="relative aspect-square flex flex-col items-center justify-center gap-2 p-2 rounded-md bg-slate-700 hover:bg-slate-800 text-white transition-colors"
        >
          <img src={memberAvatar(p.email, p.gender)} alt="" className="w-24 h-24 rounded-full object-cover bg-white/15" />
          <span className="text-sm font-bold leading-tight text-center">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
